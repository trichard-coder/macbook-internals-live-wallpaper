// Géométrie des zones d'un profil, commune à build-masks.mjs et build-parts.mjs.
// Coordonnées normalisées : u (0..1 en largeur), v (0..1 en hauteur) ; les distances des chemins et
// des cercles sont en « unités de largeur » (v multiplié par ASPECT), comme dans le moteur.

const r4 = (x) => Math.round(x * 10000) / 10000;

export function zoneGeometry(ASPECT) {
  function inPoly(poly, u, v) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > v) !== (yj > v) && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function distPath(p, u, v) {
    let best = Infinity;
    for (let i = 0; i < p.length - 1; i++) {
      const ax = p[i][0], ay = p[i][1] * ASPECT, bx = p[i + 1][0], by = p[i + 1][1] * ASPECT;
      const ex = bx - ax, ey = by - ay, wx = u - ax, wy = v * ASPECT - ay;
      const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey || 1)));
      best = Math.min(best, Math.hypot(wx - ex * t, wy - ey * t));
    }
    return best;
  }
  const inR = (r, u, v) => u >= r[0] && u <= r[1] && v >= r[2] && v <= r[3];
  function inZone(z, u, v) {
    if (z.polygon && z.polygon.length >= 3) return inPoly(z.polygon, u, v);
    switch (z.kind) {
      case 'circle': return Math.hypot(u - z.circle.c[0], (v - z.circle.c[1]) * ASPECT) <= z.circle.housing;
      case 'path': return distPath(z.path, u, v) <= (z.width ?? 0.01);
      case 'frame': return inR(z.rect, u, v) && !(z.inner && inR(z.inner, u, v));
      default: return inR(z.rect, u, v);
    }
  }

  // Même normalisation que le moteur (src/pro/profile.ts, normalizeZone) : la boîte des chemins et
  // des cercles est recalculée. Sans cela, la géométrie de référence enregistrée ne correspondrait
  // pas à celle du moteur, qui ignorerait alors le masque.
  function normalize(zones) {
    for (const z of zones) {
      if (z.kind === 'circle' && z.circle) {
        const { c, housing } = z.circle;
        z.rect = [r4(c[0] - housing), r4(c[0] + housing), r4(c[1] - housing / ASPECT), r4(c[1] + housing / ASPECT)];
      } else if (z.kind === 'path' && z.path && z.path.length >= 2) {
        const w = z.width ?? 0.01;
        const xs = z.path.map((p) => p[0]), ys = z.path.map((p) => p[1]);
        z.rect = [r4(Math.min(...xs) - w), r4(Math.max(...xs) + w), r4(Math.min(...ys) - w / ASPECT), r4(Math.max(...ys) + w / ASPECT)];
      } else if (z.polygon && z.polygon.length >= 3) {
        const xs = z.polygon.map((p) => p[0]), ys = z.polygon.map((p) => p[1]);
        z.rect = [r4(Math.min(...xs)), r4(Math.max(...xs)), r4(Math.min(...ys)), r4(Math.max(...ys))];
      }
    }
    return zones;
  }

  /** Signature de la géométrie d'une zone, identique à celle que calcule le moteur (renderer.ts). */
  const signature = (z) => JSON.stringify({ kind: z.kind, rect: z.rect, inner: z.inner ?? null, circle: z.circle ?? null, path: z.path ?? null, width: z.width ?? null, polygon: z.polygon ?? null });

  return { inZone, normalize, signature };
}
