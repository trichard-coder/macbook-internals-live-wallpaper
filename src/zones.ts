import bundled from './zones.json';
import type { ZoneDef, ZonesFile } from './types';

// Les zones modifiées dans l'éditeur sont gardées en localStorage tant qu'elles ne sont pas
// exportées. La surcharge est ignorée si le fichier embarqué a changé depuis.
const KEY = 'mba-wallpaper.zones';
const bundledFile = bundled as ZonesFile;
const signature = JSON.stringify(bundledFile.zones);

export function loadZones(): ZonesFile {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const o = JSON.parse(raw) as { base: string; file: ZonesFile };
      if (o.base === signature && Array.isArray(o.file?.zones)) return o.file;
      localStorage.removeItem(KEY);
    }
  } catch { /* localStorage indisponible (file://) : on reste sur le fichier embarqué */ }
  return structuredClone(bundledFile);
}

export function saveZonesOverride(file: ZonesFile): void {
  try { localStorage.setItem(KEY, JSON.stringify({ base: signature, file })); } catch { /* ignoré */ }
}

export function clearZonesOverride(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignoré */ }
}

export function bundledZones(): ZonesFile {
  return structuredClone(bundledFile);
}

/** Boîte englobante normalisée d'une zone (rectangle ou polygone). */
export function zoneBounds(z: ZoneDef): [number, number, number, number] {
  if (z.polygon && z.polygon.length >= 3) {
    let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
    for (const [x, y] of z.polygon) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return [x0, x1, y0, y1];
  }
  return z.rect;
}

export function zoneContains(z: ZoneDef, u: number, v: number): boolean {
  if (z.polygon && z.polygon.length >= 3) {
    let inside = false;
    const p = z.polygon;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [xi, yi] = p[i], [xj, yj] = p[j];
      if ((yi > v) !== (yj > v) && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  const [x0, x1, y0, y1] = z.rect;
  return u >= x0 && u <= x1 && v >= y0 && v <= y1;
}

export function zoneAnchor(z: ZoneDef): [number, number] {
  if (z.anchor) return z.anchor;
  const [x0, x1, y0, y1] = zoneBounds(z);
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}
