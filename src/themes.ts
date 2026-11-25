import type { LayerName } from './assets';
import type { ThemeName } from './config';

export interface Theme {
  name: ThemeName;
  /** Calque toujours visible. */
  base: LayerName;
  /** Calque révélé à intensité moyenne. */
  mid: LayerName;
  /** Calque révélé à intensité maximale. */
  high: LayerName;
  /** Mode de composition du calque haut (lighter quand mid et high sont la même image). */
  highOp: GlobalCompositeOperation;
  highAlpha: number;
  /** Calque utilisé pour une batterie faible. */
  low: LayerName;
  /** Teintes appliquées à la puce : froid au repos, chaud en charge (null : pas de teinte). */
  tintCold: string | null;
  tintWarm: string | null;
  /** Teinte des particules selon la position le long de la nappe (0 en haut, 1 en bas). */
  particleHue: (p: number) => [number, number, number];
  mono: boolean;
}

const hsl = (h: number, s: number, l: number): [number, number, number] => [h, s, l];

export const THEME_DEFS: Record<ThemeName, Theme> = {
  rainbow: {
    name: 'rainbow', base: 'base-dark', mid: 'rainbow-mid', high: 'rainbow-high', highOp: 'source-over', highAlpha: 1,
    low: 'sunset', tintCold: '#2b7dff', tintWarm: '#ff4a10',
    particleHue: (p) => hsl(190 - p * 170, 95, 64), mono: false,
  },
  warm: {
    name: 'warm', base: 'base-dark', mid: 'sunset', high: 'warm', highOp: 'source-over', highAlpha: 0.9,
    low: 'sunset', tintCold: '#b0408f', tintWarm: '#ff5a1a',
    particleHue: (p) => hsl(320 + p * 70, 92, 66), mono: false,
  },
  sunset: {
    name: 'sunset', base: 'base-dark', mid: 'sunset', high: 'sunset', highOp: 'lighter', highAlpha: 0.55,
    low: 'warm', tintCold: '#8a3cff', tintWarm: '#ffb020',
    particleHue: (p) => hsl(45 + p * 250, 95, 62), mono: false,
  },
  mono: {
    name: 'mono', base: 'mono-a', mid: 'mono-a', high: 'mono-a', highOp: 'lighter', highAlpha: 0.7,
    low: 'mono-a', tintCold: null, tintWarm: null,
    particleHue: () => hsl(0, 0, 86), mono: true,
  },
};

/** Facteur jour (0 la nuit, 1 en journée) selon l'heure locale, avec transitions d'environ 2 h. */
export function daylight(date = new Date()): number {
  const h = date.getHours() + date.getMinutes() / 60;
  const ss = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  return ss(6.5, 8.5, h) * (1 - ss(18.5, 20.5, h));
}

export function resolveTheme(name: ThemeName | 'auto', date = new Date()): Theme {
  if (name === 'auto') return THEME_DEFS[daylight(date) > 0.5 ? 'warm' : 'rainbow'];
  return THEME_DEFS[name];
}
