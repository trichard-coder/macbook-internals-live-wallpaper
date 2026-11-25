// Format d'un instantané du flux /telemetry (produit par server/telemetry.mjs ou la simulation).
export interface TelemetrySnapshot {
  t: number;
  source: 'live' | 'partial' | 'sim';
  simulated: string[];
  cpu: { avg: number; busyCores: number; cores: number; top: number; avg30: number; topProc?: number; topProcName?: string };
  gpu: number;
  mem: { used: number; totalGB: number };
  disk: { bps: number };
  net: { rxBps: number; txBps: number };
  power: { watts: number; source: 'system' | 'battery' | 'cpu-proxy' | 'sim' };
  battery: { present: boolean; level: number; charging: boolean; ac: boolean; charged: boolean };
  thermal: { pressure: number; level: string };
  audio: { playing: boolean; volume: number; muted: boolean };
  /** Secondes écoulées depuis la dernière action clavier / trackpad / souris (tout le système). */
  input?: { idleSec: number };
}

/** Rectangle normalisé [x0, x1, y0, y1] (fractions de la largeur et de la hauteur de l'image). */
export type NRect = [number, number, number, number];
export type NPoint = [number, number];

export interface ZoneDef {
  id: string;
  label: string;
  rect: NRect;
  /** Largeur du fondu des bords, en fraction de la largeur de l'image. */
  feather: number;
  /** Polygone optionnel ; s'il existe, il remplace le rectangle pour le masque. */
  polygon?: NPoint[] | null;
  /** Point d'origine des effets (grille du haut-parleur, centre de la puce...). */
  anchor?: NPoint;
  /** Cœur incandescent (die de la puce), suggéré par scripts/analyze-images.mjs. */
  core?: NRect;
}

export interface ZonesFile {
  version: number;
  image: { width: number; height: number };
  zones: ZoneDef[];
}
