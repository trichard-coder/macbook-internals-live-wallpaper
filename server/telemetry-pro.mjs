#!/usr/bin/env node
// Serveur de télémétrie de la version MacBook Pro, Node.js sans dépendance externe.
// Copie étendue de server/telemetry.mjs (version Air, non modifiée) : mêmes collecteurs,
// plus le régime des ventilateurs (estimé, ou mesuré avec --powermetrics) et les puissances
// CPU / GPU.
//   GET  /telemetry          flux SSE (1 ou 2 Hz)
//   GET  /telemetry.json     dernier instantané
//   POST /__profile-pro      réécrit profiles/pro.json (éditeur de zones)
//   GET  /*                  sert le build statique (dist-pro/, page pro.html) pour Plash
//
// Options : --port 8788  --hz 1|2  --sim  --static <dossier>  --verbose
//           --powermetrics  lit la vraie vitesse des ventilateurs et les puissances CPU / GPU
//                           (à lancer avec sudo : sudo node server/telemetry-pro.mjs --powermetrics)
// Variables : PORT, HOST, TELEMETRY_HZ, TELEMETRY_SIM=1, FAN_MIN_RPM, FAN_MAX_RPM
//
// Une source qui échoue 3 fois de suite est remplacée par la simulation, champ par champ.
// L'échantillonnage s'arrête quand plus aucun client n'est connecté.

import http from 'node:http';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSimulator } from '../src/pro/sim.mjs';
import { writeProfileFile } from './profile-pro-io.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const env = process.env;

const PORT = Number(arg('--port') ?? env.PORT ?? 8788);
const HOST = env.HOST ?? '127.0.0.1';
const HZ = Math.min(2, Math.max(0.5, Number(arg('--hz') ?? env.TELEMETRY_HZ ?? 1)));
const FORCE_SIM = argv.includes('--sim') || env.TELEMETRY_SIM === '1';
const POWERMETRICS = argv.includes('--powermetrics');
const STATIC_DIR = path.resolve(root, arg('--static') ?? 'dist-pro');
const PROFILE_FILE = path.join(root, 'profiles/pro.json');
const VERBOSE = argv.includes('--verbose');
const IS_MAC = process.platform === 'darwin';
const FAN_MIN = Number(env.FAN_MIN_RPM ?? 1200), FAN_MAX = Number(env.FAN_MAX_RPM ?? 6500);

const log = (...a) => console.log('[telemetry-pro]', ...a);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function run(cmd, args, timeout = 3000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024, env: { ...env, LC_ALL: 'C' } }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

// Entiers non signés 64 bits d'ioreg (ex. courant négatif) convertis en signés.
function signed64(str) {
  const v = BigInt(str);
  return Number(v >= 1n << 63n ? v - (1n << 64n) : v);
}

// ---------------------------------------------------------------- collecteurs

let prevCpus = null, prevCpuT = 0, avg30 = null;
async function sampleCpu() {
  const cpus = os.cpus();
  const now = Date.now();
  if (!cpus.length) throw new Error('os.cpus vide');
  const prev = prevCpus, dtS = (now - prevCpuT) / 1000;
  prevCpus = cpus; prevCpuT = now;
  if (!prev || prev.length !== cpus.length) return undefined; // première mesure : pas encore de delta
  let busy = 0, top = 0;
  cpus.forEach((c, i) => {
    const a = c.times, b = prev[i].times;
    const total = (a.user + a.nice + a.sys + a.irq + a.idle) - (b.user + b.nice + b.sys + b.irq + b.idle);
    const u = total > 0 ? clamp01(1 - (a.idle - b.idle) / total) : 0;
    busy += u; if (u > top) top = u;
  });
  const avg = busy / cpus.length;
  avg30 = avg30 == null ? avg : avg30 + (avg - avg30) * (1 - Math.exp(-dtS / 30));
  return { avg, busyCores: busy, cores: cpus.length, top, avg30 };
}

// Processus le plus gourmand (hors compositeur et noyau) : une boucle infinie sature un cœur
// et ressort nettement, alors qu'elle se noie dans la moyenne d'une puce à 10 cœurs ou plus.
async function sampleProcs() {
  const out = await run('ps', ['-A', '-o', '%cpu=,comm=']);
  let top = 0, name = '';
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*([\d.]+)\s+(.+)$/);
    if (!m || /WindowServer|kernel_task/.test(m[2])) continue;
    const v = Number(m[1]) / 100;
    if (v > top) { top = v; name = path.basename(m[2]); }
  }
  return { top, name };
}

// Activité clavier / trackpad / souris dans tout le système : temps écoulé depuis la dernière
// action de l'utilisateur (HIDIdleTime, en nanosecondes).
async function sampleInput() {
  const out = await run('ioreg', ['-c', 'IOHIDSystem', '-d', '4']);
  const m = out.match(/"HIDIdleTime"\s*=\s*(\d+)/);
  if (!m) throw new Error('HIDIdleTime introuvable');
  return { idleSec: Number(BigInt(m[1]) / 1000000n) / 1000 };
}

async function sampleGpu() {
  const out = await run('ioreg', ['-r', '-c', 'IOAccelerator', '-d', '1']);
  const vals = [...out.matchAll(/"Device Utilization %"\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
  if (!vals.length) throw new Error('Device Utilization % introuvable');
  return clamp01(Math.max(...vals) / 100);
}

let prevNet = null;
async function sampleNet() {
  const out = await run('netstat', ['-ib']);
  let rx = 0, tx = 0; const seen = new Set();
  for (const line of out.split('\n')) {
    const tok = line.trim().split(/\s+/);
    if (!/^en\d+$/.test(tok[0]) || !line.includes('<Link#') || seen.has(tok[0])) continue;
    seen.add(tok[0]);
    // Colonnes lues depuis la droite (Address peut être vide) : Ibytes = -5, Obytes = -2.
    rx += Number(tok[tok.length - 5]) || 0;
    tx += Number(tok[tok.length - 2]) || 0;
  }
  const now = Date.now(), prev = prevNet;
  prevNet = { rx, tx, t: now };
  if (!prev) return undefined;
  const dt = (now - prev.t) / 1000;
  return { rxBps: Math.max(0, (rx - prev.rx) / dt), txBps: Math.max(0, (tx - prev.tx) / dt) };
}

let prevDisk = null;
async function sampleDisk() {
  const out = await run('iostat', ['-Id', '-c', '1']);
  const lines = out.trim().split('\n');
  const nums = lines[lines.length - 1].trim().split(/\s+/).map(Number);
  let mb = 0;
  for (let i = 2; i < nums.length; i += 3) mb += nums[i] || 0; // colonnes KB/t xfrs MB par disque
  const now = Date.now(), prev = prevDisk;
  prevDisk = { mb, t: now };
  if (!prev) return undefined;
  return { bps: Math.max(0, ((mb - prev.mb) * 1024 * 1024) / ((now - prev.t) / 1000)) };
}

async function sampleMem() {
  const out = await run('vm_stat', []);
  const page = Number(out.match(/page size of (\d+) bytes/)?.[1] ?? 16384);
  const get = (label) => Number(out.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? NaN);
  const anon = get('Anonymous pages'), purg = get('Pages purgeable');
  const wired = get('Pages wired down'), comp = get('Pages occupied by compressor'), active = get('Pages active');
  // Proche de « Mémoire utilisée » du Moniteur d'activité : app + câblée + compressée.
  const app = Number.isFinite(anon) ? anon - (purg || 0) : active;
  const used = ((app + wired + (comp || 0)) * page) / os.totalmem();
  if (!Number.isFinite(used)) throw new Error('vm_stat illisible');
  return { used: clamp01(used), totalGB: Math.round(os.totalmem() / 2 ** 30) };
}

let batteryExtra = null; // infos complémentaires d'AppleSmartBattery
async function samplePower() {
  const out = await run('ioreg', ['-rn', 'AppleSmartBattery', '-d', '1']);
  const num = (k) => { const m = out.match(new RegExp(`"${k}"\\s*=\\s*(\\d+)`)); return m ? signed64(m[1]) : null; };
  const yes = (k) => new RegExp(`"${k}"\\s*=\\s*Yes`).test(out);
  if (!out.includes('AppleSmartBattery')) return { watts: null, source: 'none' };
  batteryExtra = { ac: yes('ExternalConnected'), charging: yes('IsCharging') };
  // 1) Télémétrie système d'Apple Silicon (mW), valable sur secteur comme sur batterie.
  const sysLoad = num('SystemLoad') ?? 0, sysIn = num('SystemPowerIn') ?? 0;
  if (sysLoad > 0 || sysIn > 0) return { watts: Math.max(sysLoad, sysIn) / 1000, source: 'system' };
  // 2) Tension x courant de la batterie.
  const mv = num('Voltage'), ma = num('InstantAmperage') ?? num('Amperage');
  if (mv && ma) return { watts: Math.abs(mv * ma) / 1e6, source: 'battery' };
  return { watts: null, source: 'none' };
}

async function sampleBattery() {
  const out = await run('pmset', ['-g', 'batt']);
  const ac = /'AC Power'/.test(out);
  const m = out.match(/InternalBattery[^\t]*\t\s*(\d+)%;\s*([^;]+);/);
  if (!m) return { present: false, level: 0, charging: false, ac: true, charged: false };
  const status = m[2].trim();
  const charging = status === 'charging' || status === 'finishing charge';
  return { present: true, level: Number(m[1]) / 100, charging, ac, charged: status === 'charged' };
}

const THERMAL_NAMES = ['nominal', 'moderate', 'heavy', 'trapping', 'sleeping'];
async function sampleThermal() {
  const out = await run('pmset', ['-g', 'therm']);
  let pressure = 0;
  const lim = out.match(/CPU_Speed_Limit\s*=\s*(\d+)/);
  if (lim) pressure = Math.max(pressure, 1 - Number(lim[1]) / 100);
  const warn = out.match(/thermal warning level[^\d]*(\d+)/i);
  if (warn) pressure = Math.max(pressure, clamp01(Number(warn[1]) / 3));
  // Complément Apple Silicon : niveau de pression thermique publié par le noyau.
  let level = 0;
  try {
    const n = await run('notifyutil', ['-g', 'com.apple.system.thermalpressurelevel']);
    level = Number(n.trim().split(/\s+/).pop()) || 0;
    pressure = Math.max(pressure, clamp01(level / 3));
  } catch { /* notifyutil absent : on garde pmset seul */ }
  return { pressure, level: THERMAL_NAMES[level] ?? 'nominal' };
}

let volume = { volume: 0.5, muted: false, t: 0 };
async function sampleAudio() {
  const out = await run('pmset', ['-g', 'assertions']);
  const section = out.split('Listed by owning process:')[1]?.split('Kernel Assertions')[0] ?? '';
  const playing = /\(coreaudiod\)|named: "com\.apple\.audio\./.test(section);
  // osascript coûte ~60 ms de CPU : toutes les 15 s pendant la lecture, sinon toutes les 60 s.
  const age = Date.now() - volume.t;
  if (age > (playing ? 15000 : 60000)) {
    volume.t = Date.now();
    try {
      const v = await run('osascript', ['-e', 'get volume settings']);
      const ov = v.match(/output volume:(\d+|missing value)/)?.[1];
      volume.volume = ov && ov !== 'missing value' ? Number(ov) / 100 : volume.volume;
      volume.muted = /output muted:true/.test(v);
    } catch { /* volume indisponible : dernière valeur connue */ }
  }
  return { playing, volume: volume.volume, muted: volume.muted };
}

// ---------------------------------------------------------------- powermetrics (optionnel)
// powermetrics écrit un bloc de texte par intervalle. On lit en continu :
//   « Fan: 2345 rpm » (échantillonneur smc, absent sur la plupart des Mac Apple Silicon)
//   « CPU Power: 1234 mW », « GPU Power: 56 mW »
// Si l'échantillonneur smc est refusé, on relance sans lui.

const pm = { fanRpm: null, cpuW: null, gpuW: null, t: 0, proc: null, samplers: 'smc,cpu_power,gpu_power' };

/** Analyse un bloc de sortie de powermetrics (exportée pour les tests). */
export function parsePowermetrics(text) {
  const out = {};
  const fan = text.match(/^\s*Fan:\s*([\d.]+)\s*rpm/im);
  if (fan) out.fanRpm = Number(fan[1]);
  const cpu = text.match(/^\s*CPU Power:\s*([\d.]+)\s*mW/im);
  if (cpu) out.cpuW = Number(cpu[1]) / 1000;
  const gpu = text.match(/^\s*GPU Power:\s*([\d.]+)\s*mW/im);
  if (gpu) out.gpuW = Number(gpu[1]) / 1000;
  return out;
}

function startPowermetrics() {
  if (!POWERMETRICS || !IS_MAC || pm.proc) return;
  if (process.getuid?.() !== 0) {
    log('--powermetrics demande les droits administrateur : sudo node server/telemetry-pro.mjs --powermetrics (repli sur l\'estimation)');
    return;
  }
  const proc = spawn('powermetrics', ['--samplers', pm.samplers, '-i', '1000'], { stdio: ['ignore', 'pipe', 'pipe'] });
  pm.proc = proc;
  let buf = '', errBuf = '';
  proc.stdout.on('data', (c) => {
    buf += c.toString();
    // Chaque échantillon commence par « *** Sampled system activity ».
    const parts = buf.split(/\*\*\* Sampled system activity/);
    buf = parts.pop() ?? '';
    for (const p of parts) {
      const v = parsePowermetrics(p);
      if (Object.keys(v).length) Object.assign(pm, v, { t: Date.now() });
    }
  });
  proc.stderr.on('data', (c) => { errBuf += c.toString(); });
  proc.on('exit', (code) => {
    pm.proc = null;
    if (pm.samplers.includes('smc') && /smc|sampler/i.test(errBuf)) {
      log('échantillonneur smc indisponible sur cette machine : relance sans vitesse des ventilateurs');
      pm.samplers = 'cpu_power,gpu_power';
      setTimeout(startPowermetrics, 500);
    } else if (code) {
      log(`powermetrics arrêté (code ${code}) : ${errBuf.trim().split('\n')[0] ?? ''}`);
    }
  });
}
function stopPowermetrics() { pm.proc?.kill(); pm.proc = null; }

// ---------------------------------------------------------------- ventilateurs (estimation)
// Pas d'accès sans droits aux capteurs SMC sur Apple Silicon : le régime est estimé à partir
// de la charge CPU + GPU lissée sur 20 s (les ventilateurs réagissent lentement) et de la
// pression thermique (pmset -g therm). Seuil bas : au repos, les ventilateurs tournent à peine.

let load20 = null, lastFanT = 0;
function estimateFan(cpu, gpu, thermal) {
  const now = Date.now();
  const dt = lastFanT ? Math.min(10, (now - lastFanT) / 1000) : 1;
  lastFanT = now;
  // Un processus qui sature un cœur compte, même noyé dans la moyenne de 14 cœurs.
  const load = Math.max(cpu.avg * 1.2, (cpu.topProc ?? 0) * 0.6, gpu);
  load20 = load20 == null ? load : load20 + (load - load20) * (1 - Math.exp(-dt / 20));
  return clamp01(Math.max(0.06 + (load20 - 0.28) * 1.3, thermal?.pressure ?? 0));
}

const COLLECTORS = {
  cpu: { every: 1, fn: sampleCpu },
  net: { every: 1, fn: sampleNet },
  gpu: { every: 2, fn: sampleGpu },
  procs: { every: 2, fn: sampleProcs },
  disk: { every: 2, fn: sampleDisk },
  audio: { every: 3, fn: sampleAudio },
  mem: { every: 5, fn: sampleMem },
  power: { every: 5, fn: samplePower },
  battery: { every: 10, fn: sampleBattery },
  thermal: { every: 15, fn: sampleThermal },
};
const MAC_ONLY = new Set(['procs', 'gpu', 'net', 'disk', 'audio', 'mem', 'power', 'battery', 'thermal']);

const live = {}, fails = {}, lastRun = {}, busy = {};
const sim = createSimulator({ cores: os.cpus().length || 14, totalGB: Math.round(os.totalmem() / 2 ** 30) });

function runCollectors(now) {
  for (const [key, c] of Object.entries(COLLECTORS)) {
    if (FORCE_SIM || (!IS_MAC && MAC_ONLY.has(key))) continue;
    if (busy[key] || now - (lastRun[key] ?? 0) < c.every * 1000 - 50) continue;
    busy[key] = true; lastRun[key] = now;
    c.fn().then((v) => {
      if (v !== undefined) { live[key] = v; fails[key] = 0; }
    }).catch((e) => {
      fails[key] = (fails[key] ?? 0) + 1;
      if (VERBOSE || fails[key] === 3) log(`source "${key}" en échec (${fails[key]}x) : ${e.message.split('\n')[0]}${fails[key] >= 3 ? ' -> simulation' : ''}`);
    }).finally(() => { busy[key] = false; });
  }
}

function compose() {
  const s = sim.step(1 / HZ);
  const simulated = [];
  const pick = (key) => {
    if (!FORCE_SIM && live[key] !== undefined && (fails[key] ?? 0) < 3) return live[key];
    simulated.push(key); return s[key];
  };
  let cpu = pick('cpu');
  const gpu = pick('gpu');
  if (!simulated.includes('cpu') && live.procs && (fails.procs ?? 0) < 3) cpu = { ...cpu, topProc: live.procs.top, topProcName: live.procs.name };
  const thermal = pick('thermal');
  const pmFresh = pm.t && Date.now() - pm.t < 5000;

  let power = pick('power');
  if (power && power.watts == null) power = { watts: 3 + cpu.busyCores * 2.6 + gpu * 18, source: 'cpu-proxy' };
  if (pmFresh && pm.cpuW != null) power = { ...power, cpuW: pm.cpuW, gpuW: pm.gpuW ?? undefined };

  let battery = pick('battery');
  if (batteryExtra && !simulated.includes('battery') && battery.present) battery = { ...battery, ac: battery.ac || batteryExtra.ac };

  let fan;
  if (FORCE_SIM) { fan = s.fan; simulated.push('fan'); }
  else if (pmFresh && pm.fanRpm != null) fan = { level: clamp01((pm.fanRpm - FAN_MIN * 0.5) / (FAN_MAX - FAN_MIN * 0.5)), rpm: pm.fanRpm, source: 'smc' };
  else fan = { level: estimateFan(cpu, gpu, thermal), rpm: null, source: 'estimate' };

  return {
    t: Date.now(),
    source: simulated.length === 0 ? 'live' : simulated.length >= 9 ? 'sim' : 'partial',
    simulated,
    cpu, gpu, mem: pick('mem'), disk: pick('disk'), net: pick('net'), power, battery,
    thermal, audio: pick('audio'), fan,
  };
}

// ---------------------------------------------------------------- diffusion SSE

const clients = new Set();
let latest = null, timer = null, idleSince = 0;

function tick() {
  const now = Date.now();
  runCollectors(now);
  latest = compose();
  const payload = `data: ${JSON.stringify(latest)}\n\n`;
  for (const res of clients) res.write(payload);
  if (clients.size === 0) {
    if (!idleSince) idleSince = now;
    if (now - idleSince > 10000) {
      clearInterval(timer); timer = null; stopPowermetrics();
      if (VERBOSE) log('plus de client, échantillonnage en pause');
    }
  } else idleSince = 0;
}
let warmup = null;
function ensureSampling() {
  if (timer) return warmup;
  idleSince = 0;
  startPowermetrics();
  // Amorçage : les sources à delta (CPU, réseau, disque) ont besoin de deux mesures.
  runCollectors(Date.now());
  for (const k of ['cpu', 'net', 'disk']) lastRun[k] = 0;
  timer = setInterval(tick, 1000 / HZ);
  warmup = new Promise((resolve) => setTimeout(() => { runCollectors(Date.now()); setTimeout(resolve, 300); }, 500));
  return warmup;
}

// Origines autorisées : pages locales uniquement (file:// envoie "null").
function allowedOrigin(origin) {
  if (!origin || origin === 'null') return origin ?? '*';
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin) ? origin : null;
}

function openSse(req, res, set, onOpen) {
  const origin = allowedOrigin(req.headers.origin);
  if (origin === null) { res.writeHead(403).end(); return; }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': origin,
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  set.add(res);
  onOpen?.(res);
  req.on('close', () => set.delete(res));
}

// ---------------------------------------------------------------- serveur HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

async function serveStatic(req, res, pathname) {
  const rel = decodeURIComponent(pathname === '/' ? '/pro.html' : pathname);
  const file = path.resolve(STATIC_DIR, '.' + rel);
  if (!file.startsWith(STATIC_DIR + path.sep)) { res.writeHead(403).end(); return; }
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error('pas un fichier');
    const body = await readFile(file);
    const immutable = rel.includes('/assets/');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(body);
  } catch {
    if (rel === '/pro.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><body style="background:#111;color:#ccc;font:14px system-ui;padding:2em">'
        + 'Build introuvable. Lancez <code>npm run build:pro</code>, puis rechargez. Le flux est disponible sur <a href="/telemetry" style="color:#8cf">/telemetry</a>.</body>');
    } else res.writeHead(404).end();
  }
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('corps trop volumineux')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const origin = allowedOrigin(req.headers.origin);

  if (req.method === 'OPTIONS') {
    if (origin === null) { res.writeHead(403).end(); return; }
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
    }).end();
    return;
  }
  if (pathname === '/telemetry') {
    await ensureSampling();
    openSse(req, res, clients, (r) => { if (latest) r.write(`data: ${JSON.stringify(latest)}\n\n`); });
    return;
  }
  if (pathname === '/telemetry.json') {
    await ensureSampling();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin ?? 'null' });
    res.end(JSON.stringify(latest ?? compose(), null, 2));
    return;
  }
  if (pathname === '/__profile-pro' && req.method === 'POST') {
    if (origin === null) { res.writeHead(403).end(); return; }
    try {
      await writeProfileFile(PROFILE_FILE, JSON.parse(await readBody(req)));
      log('profiles/pro.json mis à jour (relancez npm run build:pro pour le build statique)');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin }).end('{"ok":true}');
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin }).end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') { await serveStatic(req, res, pathname); return; }
  res.writeHead(405).end();
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`[telemetry-pro] le port ${PORT} est déjà utilisé (option --port pour en changer)`);
  else console.error('[telemetry-pro]', e);
  process.exit(1);
});

// Pas de démarrage du serveur quand le module est importé (tests du parseur).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => {
    log(`http://localhost:${PORT}/pro.html  (build : ${path.relative(root, STATIC_DIR) || '.'})`);
    log(`flux SSE : http://localhost:${PORT}/telemetry à ${HZ} Hz${FORCE_SIM ? ' (simulation forcée)' : ''}${!IS_MAC ? ' (hors macOS : simulation partielle)' : ''}`);
    if (POWERMETRICS) log('mode powermetrics demandé');
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopPowermetrics(); process.exit(0); });
}
