// Types partagés du moteur Pro.

/** Rectangle normalisé [x0, x1, y0, y1] (fractions de la largeur et de la hauteur de l'image). */
export type NRect = [number, number, number, number];
export type NPoint = [number, number];

export const EFFECTS = [
  'glow', 'chip', 'frame', 'fan', 'vent', 'heatpipe', 'plate', 'power', 'nand',
  'battery', 'flex', 'speaker', 'trackpad', 'port', 'control', 'network',
] as const;
export type EffectName = (typeof EFFECTS)[number];

export type ZoneKind = 'rect' | 'circle' | 'path' | 'frame';

/** Signaux nommés produits par src/pro/signals.ts et référencés par les zones du profil. */
export type SignalName =
  | 'cpu' | 'gpu' | 'mem' | 'fan' | 'heat' | 'exhaust' | 'power' | 'io' | 'net'
  | 'battery' | 'activity' | 'audio' | 'ac' | 'day' | 'none';

export interface CircleDef {
  /** Centre normalisé (x en largeur, y en hauteur). */
  c: NPoint;
  /** Rayons en fraction de la largeur de l'image. */
  blades: number;
  hub: number;
  housing: number;
}

export interface ZoneDef {
  id: string;
  label: string;
  kind: ZoneKind;
  effect: EffectName;
  signal: SignalName;
  /** Boîte englobante (rect pour kind=rect, cadre extérieur pour kind=frame). */
  rect: NRect;
  /** Largeur du fondu des bords, en fraction de la largeur de l'image. */
  feather: number;
  /** Polygone optionnel ; s'il existe, il remplace le rectangle pour le masque. */
  polygon?: NPoint[] | null;
  circle?: CircleDef;
  /** Chemin (kind=path) et demi-largeur, en fraction de la largeur. */
  path?: NPoint[];
  width?: number;
  /** Position (0 à 1) d'où part le flux le long du chemin : 0.5 = du milieu vers les deux bouts. */
  origin?: number;
  /** Trou du cadre (kind=frame). */
  inner?: NRect;
  /** Index de la cellule de batterie (ordre de remplissage). */
  cell?: number;
}

export interface RenderSettings {
  gamma: number;
  exposure: number;
  ambient: number;
  ambientGlow: number;
  bloom: number;
  detail: number;
  edges: number;
  grain: number;
  vignette: number;
}

export interface Profile {
  version: number;
  name: string;
  image: { source: string; width: number; height: number };
  /** Attribution narrative des deux puces (configurable). */
  narrative: { die_top: 'cpu' | 'gpu'; die_bottom: 'cpu' | 'gpu' };
  render: RenderSettings;
  zones: ZoneDef[];
}

// Format d'un instantané du flux /telemetry de server/telemetry-pro.mjs (ou de la simulation).
export interface TelemetrySnapshot {
  t: number;
  source: 'live' | 'partial' | 'sim';
  simulated: string[];
  cpu: { avg: number; busyCores: number; cores: number; top: number; avg30: number; topProc?: number; topProcName?: string };
  gpu: number;
  mem: { used: number; totalGB: number };
  disk: { bps: number };
  net: { rxBps: number; txBps: number };
  power: { watts: number; source: string; cpuW?: number; gpuW?: number };
  battery: { present: boolean; level: number; charging: boolean; ac: boolean; charged: boolean };
  thermal: { pressure: number; level: string };
  audio: { playing: boolean; volume: number; muted: boolean };
  fan: { level: number; rpm: number | null; source: 'estimate' | 'smc' | 'sim' };
}
