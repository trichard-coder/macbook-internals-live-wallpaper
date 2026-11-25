// Chargement du profil de l'appareil (profiles/pro.json ou profiles/air.json) et géométrie des zones.
// Les modifications faites dans l'éditeur restent en localStorage tant qu'elles ne sont pas
// exportées ; la surcharge est ignorée si le fichier embarqué a changé entre-temps.

import { ASPECT, device, storagePrefix } from './device';
import type { NPoint, NRect, Profile, ZoneDef } from './types';

export { ASPECT };
const KEY = () => `${storagePrefix()}.profile`;
const signature = () => JSON.stringify(device().profile);

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY());
    if (raw) {
      const o = JSON.parse(raw) as { base: string; profile: Profile };
      if (o.base === signature() && Array.isArray(o.profile?.zones)) return o.profile;
      localStorage.removeItem(KEY());
    }
  } catch { /* localStorage indisponible (file://) : profil embarqué */ }
  return bundledProfileCopy();
}

export function bundledProfileCopy(): Profile {
  return structuredClone(device().profile);
}

export function saveProfileOverride(p: Profile): void {
  try { localStorage.setItem(KEY(), JSON.stringify({ base: signature(), profile: p })); } catch { /* ignoré */ }
}

export function clearProfileOverride(): void {
  try { localStorage.removeItem(KEY()); } catch { /* ignoré */ }
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;

/** Recalcule la boîte englobante des zones dont la forme n'est pas un rectangle. */
export function normalizeZone(z: ZoneDef): ZoneDef {
  if (z.kind === 'circle' && z.circle) {
    const { c, housing } = z.circle;
    z.rect = [r4(c[0] - housing), r4(c[0] + housing), r4(c[1] - housing / ASPECT), r4(c[1] + housing / ASPECT)];
  } else if (z.kind === 'path' && z.path && z.path.length >= 2) {
    const w = z.width ?? 0.01;
    let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
    for (const [x, y] of z.path) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    z.rect = [r4(x0 - w), r4(x1 + w), r4(y0 - w / ASPECT), r4(y1 + w / ASPECT)];
  } else if (z.polygon && z.polygon.length >= 3) {
    z.rect = polygonBounds(z.polygon);
  }
  return z;
}

export function polygonBounds(p: NPoint[]): NRect {
  let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
  for (const [x, y] of p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return [r4(x0), r4(x1), r4(y0), r4(y1)];
}

/** Distance d'un point au chemin, en unités de largeur. */
function distToPath(z: ZoneDef, u: number, v: number): number {
  const p = z.path!;
  let best = Infinity;
  for (let i = 0; i < p.length - 1; i++) {
    const ax = p[i][0], ay = p[i][1] * ASPECT, bx = p[i + 1][0], by = p[i + 1][1] * ASPECT;
    const px = u, py = v * ASPECT;
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy));
  }
  return best;
}

export function zoneContains(z: ZoneDef, u: number, v: number): boolean {
  if (z.kind === 'circle' && z.circle) {
    return Math.hypot(u - z.circle.c[0], (v - z.circle.c[1]) * ASPECT) <= z.circle.housing * 0.62;
  }
  if (z.kind === 'path' && z.path) return distToPath(z, u, v) <= (z.width ?? 0.01);
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
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  if (z.kind === 'frame' && z.inner) {
    const [a0, a1, b0, b1] = z.inner;
    return !(u > a0 && u < a1 && v > b0 && v < b1);
  }
  return true;
}

/** Surface approximative (pour le test de survol : la plus petite zone gagne). */
export function zoneArea(z: ZoneDef): number {
  const [x0, x1, y0, y1] = z.rect;
  if (z.kind === 'path' && z.path) {
    let len = 0;
    for (let i = 0; i < z.path.length - 1; i++) len += Math.hypot(z.path[i + 1][0] - z.path[i][0], (z.path[i + 1][1] - z.path[i][1]) * ASPECT);
    return len * 2 * (z.width ?? 0.01);
  }
  if (z.kind === 'circle' && z.circle) return Math.PI * (z.circle.housing * 0.62) ** 2;
  return (x1 - x0) * (y1 - y0) * ASPECT;
}

export function zoneAnchor(z: ZoneDef): NPoint {
  if (z.kind === 'circle' && z.circle) return z.circle.c;
  const [x0, x1, y0, y1] = z.rect;
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}
