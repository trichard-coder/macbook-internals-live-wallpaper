// Traduction des mesures brutes en intensités de zones (0 à 1).

import type { TelemetrySnapshot } from './types';
import { daylight } from './themes';

export interface Derived {
  targets: Record<string, number>;
  cpuLevel: number;
  gpuLevel: number;
  ioLevel: number;
  netLevel: number;
  powerLevel: number;
  thermal: number;
  activity: number;
  battery: { present: boolean; level: number; charging: boolean; ac: boolean; low: boolean };
  audio: { playing: boolean; volume: number; muted: boolean };
  daylight: number;
  /** Secondes depuis la dernière action clavier / trackpad (Infinity si inconnu). */
  idleSec: number;
  source: TelemetrySnapshot['source'] | 'none';
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Échelle logarithmique : lo -> 0, hi -> 1. */
const logLevel = (x: number, lo: number, hi: number) => clamp01(Math.log(Math.max(x, lo) / lo) / Math.log(hi / lo));


/**
 * Charge CPU perçue, combinaison de trois indicateurs :
 * 1. le processus le plus actif (hors WindowServer) : une boucle infinie sature un cœur
 *    (100 %) alors qu'au repos aucun processus ne dépasse 25 à 30 % ;
 * 2. l'excédent de « cœurs occupés » par rapport au repos habituel de la machine, mesuré par
 *    une ligne de base adaptative (20e centile sur 10 min) : une machine avec des applications
 *    ouvertes occupe déjà 1 à 2 cœurs, et une boucle se noierait dans la moyenne de 10 cœurs ;
 * 3. la moyenne absolue, pour qu'une machine réellement saturée reste au maximum.
 */
class Baseline {
  private samples: number[] = [];
  private smooth: number | null = null;
  private lastT = 0;
  private lastSave = 0;
  constructor(private key: string, private window = 600, private pct = 0.2, private smoothTau = 2) {
    // Ligne de base mémorisée (moins d'une heure) : pas de faux pic au chargement de la page.
    try {
      const o = JSON.parse(localStorage.getItem(`mba-wallpaper.${key}`) ?? 'null') as { v: number; t: number } | null;
      if (o && Date.now() - o.t < 3600_000 && Number.isFinite(o.v)) this.samples = new Array(30).fill(o.v);
    } catch { /* localStorage indisponible */ }
  }
  private base(): number {
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * this.pct)];
  }
  excess(x: number, t: number): number {
    const dt = this.lastT ? Math.min(10, Math.max(0, (t - this.lastT) / 1000)) : 1;
    if (dt > 0 || this.smooth == null) {
      this.lastT = t;
      this.smooth = this.smooth == null ? x : this.smooth + (x - this.smooth) * (1 - Math.exp(-dt / this.smoothTau));
      this.samples.push(this.smooth);
      if (this.samples.length > this.window) this.samples.shift();
    }
    const base = this.base();
    if (t - this.lastSave > 30000 && this.samples.length >= 30) {
      this.lastSave = t;
      try { localStorage.setItem(`mba-wallpaper.${this.key}`, JSON.stringify({ v: base, t: Date.now() })); } catch { /* ignoré */ }
    }
    return Math.max(0, this.smooth - base);
  }
}
const cpuBase = new Baseline('cpu-baseline');
const gpuBase = new Baseline('gpu-baseline');

export function cpuLevel(cpu: TelemetrySnapshot['cpu'], t = Date.now()): number {
  const proc = Math.pow(clamp01(((cpu.topProc ?? 0) - 0.45) / 0.45), 0.8);
  const cores = Math.pow(clamp01((cpuBase.excess(cpu.busyCores, t) - 0.35) / 1.2), 0.8);
  const abs = clamp01((cpu.avg - 0.3) / 0.55);
  return Math.max(proc, cores, abs);
}

export function derive(s: TelemetrySnapshot | null, now = new Date()): Derived {
  const day = daylight(now);
  if (!s) {
    return {
      targets: { display_connector: day }, cpuLevel: 0, gpuLevel: 0, ioLevel: 0, netLevel: 0, powerLevel: 0, thermal: 0, activity: 0,
      battery: { present: false, level: 0, charging: false, ac: false, low: false },
      audio: { playing: false, volume: 0, muted: false }, daylight: day, idleSec: Infinity, source: 'none',
    };
  }
  const cpu = cpuLevel(s.cpu, s.t);
  const gpu = clamp01((gpuBase.excess(s.gpu, s.t) - 0.15) / 0.55);
  const soc = Math.max(cpu, gpu * 0.9);
  const memPressure = clamp01((s.mem.used - 0.45) / 0.5);
  const io = logLevel(s.disk.bps, 1e6, 5e8);
  const net = logLevel(s.net.rxBps + s.net.txBps, 2e4, 5e7);
  const power = logLevel(s.power.watts, 5, 60);
  const thermalCpu = clamp01((s.cpu.avg30 - 0.08) / 0.45);
  const thermal = Math.max(s.thermal.pressure, thermalCpu);
  const activity = clamp01(0.55 * soc + 0.25 * io + 0.2 * net);
  const b = s.battery;
  const low = b.present && b.level < 0.2;
  const audioOn = s.audio.playing && !s.audio.muted;
  // Trackpad / Taptic Engine : actif quand vous tapez ou utilisez le trackpad, s'éteint en quelques secondes.
  const idleSec = s.input?.idleSec ?? Infinity;
  const input = Number.isFinite(idleSec) ? Math.exp(-Math.max(0, idleSec - 0.5) / 2.5) : 0;

  const targets: Record<string, number> = {
    logic_board: 0.4 * activity,
    soc,
    memory_nand: clamp01(0.08 + 0.45 * memPressure + 0.45 * io),
    wifi_bt: net,
    power_stage: power,
    thermal_plate: thermal,
    speaker_left: audioOn ? 0.3 + 0.7 * s.audio.volume : 0,
    speaker_right: audioOn ? 0.3 + 0.7 * s.audio.volume : 0,
    battery_top: b.present ? b.level : 0,
    battery_bl: b.present ? b.level : 0,
    battery_br: b.present ? b.level : 0,
    trackpad_taptic: input,
    flex_cable: activity,
    ports_right: b.ac ? 0.35 : 0,
    display_connector: day,
  };

  return {
    targets, cpuLevel: cpu, gpuLevel: gpu, ioLevel: io, netLevel: net, powerLevel: power, thermal, activity,
    battery: { present: b.present, level: b.level, charging: b.charging, ac: b.ac, low },
    audio: { playing: s.audio.playing, volume: s.audio.volume, muted: s.audio.muted },
    daylight: day, idleSec, source: s.source,
  };
}
