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

// Palettes inspirées des couleurs système d'Apple (orange, rose, violet, indigo, bleu, cyan) :
// pas de jaune ni de vert phosphore, qui donnaient un aspect « terminal ». Fond graphite neutre.
const VENT: Stops = ['#1a0806', '#ff6b3d', '#ff375f', '#ff2d55'];
const ALERT: Stops = ['#ff375f', '#ff6b3d'];
const DAY: Stops = ['#ff9f0a', '#ffc58a', '#ff6482'];

export const THEME_DEFS: Record<ThemeName, Theme> = {
  rainbow: {
    name: 'rainbow',
    board: ['#ff7a5c', '#ff375f', '#bf5af2', '#5e5ce6', '#0a84ff', '#40c8e0'],
    die: ['#40c8e0', '#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#ff9f0a'],
    dieAlt: ['#64d2ff', '#7d7aff', '#da8fff'],
    heat: ['#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#ff8a3d', '#ffd9b0'],
    ambient: ['#030406', '#0b0e13', '#363c47', '#d4d9e1'],
    vent: VENT, alert: ALERT, day: DAY, mono: false,
  },
  warm: {
    name: 'warm',
    board: ['#ff9f0a', '#ff6b4a', '#ff375f', '#bf5af2'],
    die: ['#ffb340', '#ff6482', '#da8fff'],
    dieAlt: ['#ffd08a', '#ff9f0a', '#ff6482'],
    heat: ['#bf5af2', '#ff375f', '#ff8a3d', '#ffe2c0'],
    ambient: ['#050404', '#100d0e', '#3f393b', '#ded6d3'],
    vent: VENT, alert: ALERT, day: DAY, mono: false,
  },
  sunset: {
    name: 'sunset',
    board: ['#ffb340', '#ff6482', '#bf5af2', '#7d7aff'],
    die: ['#ffb340', '#ff6482', '#bf5af2', '#7d7aff'],
    dieAlt: ['#ffd60a', '#ffb340', '#ff6482'],
    heat: ['#7d7aff', '#bf5af2', '#ff6482', '#ffb340', '#fff0d0'],
    ambient: ['#040408', '#0d0c13', '#3b3946', '#d8d4e2'],
    vent: VENT, alert: ALERT, day: DAY, mono: false,
  },
  mono: {
    name: 'mono',
    board: ['#9aa6b6', '#d9dfe7'],
    die: ['#8e9bad', '#e6ebf1', '#8e9bad'],
    dieAlt: ['#b8c3d0', '#9aa6b6'],
    heat: ['#5d6a7b', '#a9b5c4', '#f2f5f8'],
    ambient: ['#030405', '#0d1014', '#3c424b', '#d4d9df'],
    vent: ['#2e3540', '#9aa6b6', '#d9dfe7', '#ffffff'],
    alert: ['#d9dfe7', '#ffffff'],
    day: ['#c3ccd7', '#eef1f5'],
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
