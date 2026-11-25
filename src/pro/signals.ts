// Traduction des mesures brutes en signaux nommés (0 à 1) et en textes d'étiquettes.
// Les zones du profil référencent ces signaux par leur nom (champ "signal").

import { daylight } from './themes';
import type { SignalName, TelemetrySnapshot } from './types';

export interface Derived {
  values: Record<SignalName, number>;
  battery: { present: boolean; level: number; charging: boolean; ac: boolean; low: boolean };
  audio: { playing: boolean; volume: number; muted: boolean };
  labels: Partial<Record<SignalName, string>>;
  source: TelemetrySnapshot['source'] | 'none';
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Échelle logarithmique : lo -> 0, hi -> 1. */
const logLevel = (x: number, lo: number, hi: number) => clamp01(Math.log(Math.max(x, lo) / lo) / Math.log(hi / lo));
const pct = (x: number) => `${Math.round(x * 100)} %`;

function bytes(bps: number): string {
  if (bps < 1024) return `${Math.round(bps)} o/s`;
  if (bps < 1024 ** 2) return `${(bps / 1024).toFixed(bps < 10 * 1024 ? 1 : 0)} Ko/s`;
  if (bps < 1024 ** 3) return `${(bps / 1024 ** 2).toFixed(bps < 10 * 1024 ** 2 ? 1 : 0)} Mo/s`;
  return `${(bps / 1024 ** 3).toFixed(1)} Go/s`;
}

/**
 * Ligne de base adaptative (20e centile sur 10 min) : sur une puce à 14 cœurs, une boucle
 * infinie ne pèse que 7 % de la moyenne, mais elle ressort nettement de l'activité habituelle.
 * Logique reprise de la version Air (copiée, pas importée).
 */
class Baseline {
  private samples: number[] = [];
  private smooth: number | null = null;
  private lastT = 0;
  private lastSave = 0;
  constructor(private key: string, private window = 600, private pct = 0.2, private tau = 2) {
    try {
      const o = JSON.parse(localStorage.getItem(`mbp-wallpaper.${key}`) ?? 'null') as { v: number; t: number } | null;
      if (o && Date.now() - o.t < 3600_000 && Number.isFinite(o.v)) this.samples = new Array(30).fill(o.v);
    } catch { /* localStorage indisponible */ }
  }
  excess(x: number, t: number): number {
    const dt = this.lastT ? Math.min(10, Math.max(0, (t - this.lastT) / 1000)) : 1;
    if (dt > 0 || this.smooth == null) {
      this.lastT = t;
      this.smooth = this.smooth == null ? x : this.smooth + (x - this.smooth) * (1 - Math.exp(-dt / this.tau));
      this.samples.push(this.smooth);
      if (this.samples.length > this.window) this.samples.shift();
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const base = sorted[Math.floor((sorted.length - 1) * this.pct)];
    if (t - this.lastSave > 30000 && this.samples.length >= 30) {
      this.lastSave = t;
      try { localStorage.setItem(`mbp-wallpaper.${this.key}`, JSON.stringify({ v: base, t: Date.now() })); } catch { /* ignoré */ }
    }
    return Math.max(0, this.smooth - base);
  }
}

export class SignalModel {
  private cpuBase = new Baseline('cpu-baseline');
  private gpuBase = new Baseline('gpu-baseline');
  /** Température simulée (0 à 1) : intégration de la charge dans le temps. */
  private heat = 0;
  private lastT = 0;

  derive(s: TelemetrySnapshot | null, now = new Date()): Derived {
    const day = daylight(now);
    const empty: Record<SignalName, number> = {
      cpu: 0, gpu: 0, mem: 0, fan: 0.12, heat: 0, exhaust: 0, power: 0, io: 0, net: 0,
      battery: 0, activity: 0, audio: 0, ac: 0, day, soc: 0, input: 0, none: 0,
    };
    if (!s) {
      return { values: empty, battery: { present: false, level: 0, charging: false, ac: false, low: false },
        audio: { playing: false, volume: 0, muted: false }, labels: {}, source: 'none' };
    }
    const sim = new Set(s.simulated);
    const tag = (k: string) => (s.source === 'sim' || sim.has(k) ? ' (simulé)' : '');

    // CPU perçu : processus le plus actif, excédent de cœurs occupés, moyenne absolue.
    const proc = Math.pow(clamp01(((s.cpu.topProc ?? 0) - 0.45) / 0.45), 0.8);
    const cores = Math.pow(clamp01((this.cpuBase.excess(s.cpu.busyCores, s.t) - 0.35) / 1.2), 0.8);
    const cpu = Math.max(proc, cores, clamp01((s.cpu.avg - 0.3) / 0.55));
    const gpu = clamp01((this.gpuBase.excess(s.gpu, s.t) - 0.12) / 0.5);
    const soc = Math.max(cpu, gpu * 0.9);

    // Chaleur : monte en quelques secondes, retombe en une vingtaine.
    const dt = this.lastT ? Math.min(10, Math.max(0, (s.t - this.lastT) / 1000)) : 1;
    this.lastT = s.t;
    const tau = soc > this.heat ? 5 : 18;
    this.heat += (soc - this.heat) * (1 - Math.exp(-dt / tau));
    const heat = Math.max(this.heat, s.thermal.pressure * 0.8);

    const fan = clamp01(s.fan?.level ?? 0.12 + 0.88 * heat);
    const exhaust = clamp01(heat * (0.45 + 0.55 * fan));
    const memPressure = clamp01((s.mem.used - 0.45) / 0.5);
    const io = logLevel(s.disk.bps, 1e6, 5e8);
    const net = logLevel(s.net.rxBps + s.net.txBps, 2e4, 5e7);
    const power = logLevel(s.power.watts, 4, 80);
    const activity = clamp01(0.55 * soc + 0.25 * io + 0.2 * net);
    const b = s.battery;
    const low = b.present && b.level < 0.2;
    const audioOn = s.audio.playing && !s.audio.muted;

    const values: Record<SignalName, number> = {
      cpu, gpu, mem: memPressure, fan, heat, exhaust, power, io, net,
      battery: b.present ? b.level : 0, activity,
      audio: audioOn ? 0.3 + 0.7 * s.audio.volume : 0,
      ac: b.ac ? 1 : 0, day, soc,
      // Activité clavier / trackpad : 1 en cours d'utilisation, s'éteint en quelques secondes.
      input: s.input && Number.isFinite(s.input.idleSec) ? Math.exp(-Math.max(0, s.input.idleSec - 0.5) / 2.5) : 0,
      none: 0,
    };

    const sourceText: Record<string, string> = { system: 'mesure système', battery: 'tension x courant', 'cpu-proxy': 'estimation', powermetrics: 'powermetrics', sim: 'simulé' };
    const hh = String(now.getHours()).padStart(2, '0'), mm = String(now.getMinutes()).padStart(2, '0');
    const labels: Partial<Record<SignalName, string>> = {
      cpu: `CPU ${pct(s.cpu.avg)} (${s.cpu.busyCores.toFixed(1)} cœurs sur ${s.cpu.cores})${s.cpu.topProc && s.cpu.topProc > 0.5 ? ` · ${s.cpu.topProcName} ${Math.round(s.cpu.topProc * 100)} %` : ''}${s.power.cpuW != null ? ` · ${s.power.cpuW.toFixed(1)} W` : ''}${tag('cpu')}`,
      gpu: `GPU ${pct(s.gpu)}${s.power.gpuW != null ? ` · ${s.power.gpuW.toFixed(1)} W` : ''}${tag('gpu')}`,
      mem: `Mémoire ${pct(s.mem.used)} de ${s.mem.totalGB} Go${tag('mem')}`,
      fan: s.fan?.rpm != null ? `${Math.round(s.fan.rpm)} tr/min (mesuré)` : `Régime estimé ${pct(fan)}${tag('fan')}`,
      heat: `Chaleur ${pct(heat)} · pression thermique ${s.thermal.level}${tag('thermal')}`,
      exhaust: `Air chaud ${pct(exhaust)} · ventilation ${pct(fan)}`,
      power: `${s.power.watts.toFixed(1)} W (${sourceText[s.power.source] ?? s.power.source})${tag('power')}`,
      io: `Disque ${bytes(s.disk.bps)}${tag('disk')}`,
      net: `↓ ${bytes(s.net.rxBps)}  ↑ ${bytes(s.net.txBps)}${tag('net')}`,
      battery: !b.present ? 'Pas de batterie' : `${pct(b.level)} · ${b.charging ? 'en charge' : b.charged ? 'chargée' : b.ac ? 'secteur, charge en pause' : 'sur batterie'}${low && !b.charging ? ' · faible' : ''}${tag('battery')}`,
      activity: `Activité globale ${pct(activity)}`,
      audio: `${s.audio.playing ? 'Lecture audio' : 'Silence'} · volume ${pct(s.audio.volume)}${s.audio.muted ? ' (muet)' : ''}${tag('audio')}`,
      ac: (b.ac ? 'Adaptateur secteur branché' : 'Adaptateur débranché') + tag('battery'),
      day: `${day > 0.5 ? 'Mode jour' : 'Mode nuit'} · ${hh}:${mm}`,
      soc: `Puce ${pct(soc)} · CPU ${pct(s.cpu.avg)} · GPU ${pct(s.gpu)}${tag('cpu')}`,
      input: s.input ? `Dernière action il y a ${s.input.idleSec < 1 ? 'moins d\'une seconde' : `${Math.round(s.input.idleSec)} s`}` : 'Activité inconnue',
    };

    return {
      values,
      battery: { present: b.present, level: b.level, charging: b.charging, ac: b.ac, low },
      audio: { playing: s.audio.playing, volume: s.audio.volume, muted: s.audio.muted },
      labels, source: s.source,
    };
  }
}
