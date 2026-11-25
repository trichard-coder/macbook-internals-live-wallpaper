// Palettes : chaque thème est décrit par des rampes de couleurs, regroupées dans une texture
// 256 x 8 (une ligne par rampe) lue par les shaders.
//   ligne 0  carte          couleur selon la position horizontale (gauche vers droite)
//   ligne 1  puce           diagonale de la puce (haut gauche vers bas droite)
//   ligne 2  puce bis       variante du coin haut droit de la puce
//   ligne 3  chaleur        du froid au chaud (puces chargées, caloduc, plaques)
//   ligne 4  ambiance       gradient map de la luminance (ombres vers hautes lumières)
//   ligne 5  évacuation     grilles d'air chaud (orange puis rouge)
//   ligne 6  alerte         batterie faible
//   ligne 7  jour           contrôleur en mode jour

export const THEMES = ['rainbow', 'warm', 'sunset', 'mono'] as const;
export type ThemeName = (typeof THEMES)[number];
export const RAMP_ROWS = 8;

type Stops = string[];

export interface Theme {
  name: ThemeName;
  board: Stops;
  die: Stops;
  dieAlt: Stops;
  heat: Stops;
  ambient: Stops;
  vent: Stops;
  alert: Stops;
  day: Stops;
  /** 1 : thème monochrome (désature les effets dynamiques). */
  mono: boolean;
}

const VENT: Stops = ['#5a1a08', '#ff9a3c', '#ff5a1a', '#e01420'];
const ALERT: Stops = ['#ff2a2a', '#ff4a1a'];
const DAY: Stops = ['#ff9a3c', '#ffc27a', '#ff4f7a'];

export const THEME_DEFS: Record<ThemeName, Theme> = {
  rainbow: {
    name: 'rainbow',
    board: ['#ff7a1a', '#ffc21a', '#7ed957', '#19d3c5'],
    die: ['#ff7a1a', '#ff4fa3', '#b05cff', '#3b8bff', '#19d3c5'],
    dieAlt: ['#ffc21a', '#7ed957', '#19d3c5'],
    heat: ['#3b8bff', '#19d3c5', '#ffc21a', '#ff7a1a', '#ff3b1a'],
    ambient: ['#050609', '#151a24', '#4a5466', '#c4ccd8'],
    vent: VENT, alert: ALERT, day: DAY, mono: false,
  },
  warm: {
    name: 'warm',
    board: ['#ff9a3c', '#ff4f7a', '#8a4fe0'],
    die: ['#ff9a3c', '#ff4f7a', '#8a4fe0'],
    dieAlt: ['#ffc27a', '#ff9a3c', '#ff4f7a'],
    heat: ['#8a4fe0', '#ff4f7a', '#ff9a3c', '#ffd08a'],
    ambient: ['#070508', '#1d1418', '#5a4a4c', '#d8c8c4'],
    vent: VENT, alert: ALERT, day: DAY, mono: false,
  },
  sunset: {
    name: 'sunset',
    board: ['#f2c230', '#e0508a', '#9a4fd8'],
    die: ['#f2c230', '#e0508a', '#9a4fd8'],
    dieAlt: ['#ffe07a', '#f2c230', '#e0508a'],
    heat: ['#9a4fd8', '#e0508a', '#f2c230', '#fff0b0'],
    ambient: ['#06050a', '#18131f', '#504658', '#d4c8d8'],
    vent: VENT, alert: ALERT, day: DAY, mono: false,
  },
  mono: {
    name: 'mono',
    board: ['#8fa3b8', '#8fa3b8'],
    die: ['#7d92a8', '#b6c6d6', '#7d92a8'],
    dieAlt: ['#a8bacb', '#8fa3b8'],
    heat: ['#56677c', '#8fa3b8', '#dde7f1'],
    ambient: ['#050608', '#141820', '#4a5462', '#c8d0da'],
    vent: ['#3a4452', '#8fa3b8', '#c8d6e4', '#ffffff'],
    alert: ['#c8d6e4', '#ffffff'],
    day: ['#b6c6d6', '#dde7f1'],
    mono: true,
  },
};

/** Facteur jour (0 la nuit, 1 en journée) selon l'heure locale, transitions d'environ 2 h. */
export function daylight(date = new Date()): number {
  const h = date.getHours() + date.getMinutes() / 60;
  const ss = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  return ss(6.5, 8.5, h) * (1 - ss(18.5, 20.5, h));
}

export function resolveTheme(name: ThemeName | 'auto', date = new Date()): Theme {
  if (name === 'auto') return THEME_DEFS[daylight(date) > 0.5 ? 'warm' : 'rainbow'];
  return THEME_DEFS[name] ?? THEME_DEFS.rainbow;
}

function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Interpolation linéaire des arrêts régulièrement espacés. */
function sample(stops: Stops, t: number): [number, number, number] {
  if (stops.length === 1) return hex(stops[0]);
  const x = Math.min(0.99999, Math.max(0, t)) * (stops.length - 1);
  const i = Math.floor(x), f = x - i;
  const a = hex(stops[i]), b = hex(stops[i + 1]);
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Pixels RGBA de la texture de rampes (256 x RAMP_ROWS). */
export function rampPixels(t: Theme): Uint8Array {
  const rows = [t.board, t.die, t.dieAlt, t.heat, t.ambient, t.vent, t.alert, t.day];
  const out = new Uint8Array(256 * RAMP_ROWS * 4);
  rows.forEach((stops, r) => {
    for (let i = 0; i < 256; i++) {
      const c = sample(stops, i / 255);
      const o = (r * 256 + i) * 4;
      out[o] = Math.round(c[0]); out[o + 1] = Math.round(c[1]); out[o + 2] = Math.round(c[2]); out[o + 3] = 255;
    }
  });
  return out;
}
