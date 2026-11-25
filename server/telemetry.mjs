#!/usr/bin/env node
// Serveur de télémétrie, Node.js sans dépendance externe.
//   GET  /telemetry       flux SSE (1 ou 2 Hz) des mesures de la machine
//   GET  /telemetry.json  dernier instantané (pratique pour déboguer)
//   POST /__zones         réécrit src/zones.json (éditeur de zones)
//   GET  /*               sert le build statique (dist/) pour Plash
//
// Options : --port 8787  --hz 1|2  --sim (tout simuler)  --static <dossier>  --verbose
// Variables : PORT, HOST, TELEMETRY_HZ, TELEMETRY_SIM=1
//
// Chaque source est échantillonnée à son propre rythme (les commandes coûteuses rarement).
// Une source qui échoue 3 fois de suite est remplacée par la simulation, champ par champ.
// L'échantillonnage s'arrête quand plus aucun client n'est connecté.

import http from 'node:http';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSimulator } from '../src/shared/simulation.mjs';
import { writeZonesFile } from './zones-io.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const env = process.env;

const PORT = Number(arg('--port') ?? env.PORT ?? 8787);
const HOST = env.HOST ?? '127.0.0.1';
const HZ = Math.min(2, Math.max(0.5, Number(arg('--hz') ?? env.TELEMETRY_HZ ?? 1)));
const FORCE_SIM = argv.includes('--sim') || env.TELEMETRY_SIM === '1';
const STATIC_DIR = path.resolve(root, arg('--static') ?? 'dist');
const ZONES_FILE = path.join(root, 'src/zones.json');
const VERBOSE = argv.includes('--verbose');
const IS_MAC = process.platform === 'darwin';

const log = (...a) => console.log('[telemetry]', ...a);
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

const COLLECTORS = {
  cpu: { every: 1, fn: sampleCpu },
  net: { every: 1, fn: sampleNet },
  input: { every: 1, fn: sampleInput },
  gpu: { every: 2, fn: sampleGpu },
  procs: { every: 2, fn: sampleProcs },
  disk: { every: 2, fn: sampleDisk },
  audio: { every: 3, fn: sampleAudio },
  mem: { every: 5, fn: sampleMem },
  power: { every: 5, fn: samplePower },
  battery: { every: 10, fn: sampleBattery },
  thermal: { every: 15, fn: sampleThermal },
};
const MAC_ONLY = new Set(['input', 'procs', 'gpu', 'net', 'disk', 'audio', 'mem', 'power', 'battery', 'thermal']);

const live = {}, fails = {}, lastRun = {}, busy = {};
const sim = createSimulator({ cores: os.cpus().length || 8, totalGB: Math.round(os.totalmem() / 2 ** 30) });

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
  let power = pick('power');
  if (power && power.watts == null) {
    // À défaut de mesure électrique, proxy fondé sur la charge CPU / GPU.
    power = { watts: 3 + cpu.busyCores * 3.5 + gpu * 10, source: 'cpu-proxy' };
  }
  let battery = pick('battery');
  if (batteryExtra && !simulated.includes('battery') && battery.present) {
    battery = { ...battery, ac: battery.ac || batteryExtra.ac };
  }
  const snap = {
    t: Date.now(),
    source: simulated.length === 0 ? 'live' : simulated.length >= 10 ? 'sim' : 'partial',
    simulated,
    cpu, gpu, mem: pick('mem'), disk: pick('disk'), net: pick('net'), power, battery,
    thermal: pick('thermal'), audio: pick('audio'), input: pick('input'),
  };
  return snap;
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
    if (now - idleSince > 10000) { clearInterval(timer); timer = null; if (VERBOSE) log('plus de client, échantillonnage en pause'); }
  } else idleSince = 0;
}
let warmup = null;
function ensureSampling() {
  if (timer) return warmup;
  idleSince = 0;
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
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
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
    if (rel === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><body style="background:#111;color:#ccc;font:14px system-ui;padding:2em">'
        + 'Build introuvable. Lancez <code>npm run build</code>, puis rechargez. Le flux est disponible sur <a href="/telemetry" style="color:#8cf">/telemetry</a>.</body>');
    } else res.writeHead(404).end();
  }
}

function readBody(req, limit = 256 * 1024) {
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
  if (pathname === '/__zones' && req.method === 'POST') {
    if (origin === null) { res.writeHead(403).end(); return; }
    try {
      await writeZonesFile(ZONES_FILE, JSON.parse(await readBody(req)));
      log('src/zones.json mis à jour (relancez npm run build pour le build statique)');
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
  if (e.code === 'EADDRINUSE') console.error(`[telemetry] le port ${PORT} est déjà utilisé (option --port pour en changer)`);
  else console.error('[telemetry]', e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log(`http://localhost:${PORT}/  (build : ${path.relative(root, STATIC_DIR) || '.'})`);
  log(`flux SSE : http://localhost:${PORT}/telemetry à ${HZ} Hz${FORCE_SIM ? ' (simulation forcée)' : ''}${!IS_MAC ? ' (hors macOS : simulation partielle)' : ''}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
