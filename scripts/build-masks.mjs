#!/usr/bin/env node
// Masques de forme des zones, calculés à partir de l'image de l'appareil.
// Les zones du profil sont des formes géométriques (rectangle, cercle, chemin...) ; les composants
// réels ont des coins arrondis, des encoches, des formes libres. Pour chaque zone marquée "refine",
// ce script détermine les pixels qui appartiennent vraiment au composant, et le moteur y limite la
// lumière (plus de débordement sur les pièces voisines).
//
//   refine: "fill"        composant de teinte continue (plaque, batterie, haut-parleur, puce) :
//                         croissance de proche en proche depuis le cœur de la zone (suit les
//                         dégradés), arrêtée par les contours nets, puis trous bouchés (textes).
//                         Seuil de contour réglable par zone : "refineEdge" (28 par défaut).
//   refine: "silhouette"  carte chargée de composants : tout ce qui se détache du fond sombre
//                         (bordure extérieure de la zone), trous bouchés, plus grande composante.
//
// Sorties (dans assets/<appareil>/) :
//   zones-mask.png   RGB, chaque canal porte l'identifiant (1 à 255) d'une zone : jusqu'à trois
//                    zones superposées par pixel ; alpha opaque (pas de prémultiplication).
//   zones-mask.json  identifiant et géométrie de référence de chaque zone (un masque dont la zone a
//                    été modifiée depuis dans l'éditeur est ignoré par le moteur).
//
// Usage : node scripts/build-masks.mjs [--air] [--preview fichier.png]

import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zoneGeometry } from './zone-geom.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const DEV = argv.includes('--air') ? 'air' : 'pro';
const previewIdx = argv.indexOf('--preview');
const PREVIEW = previewIdx >= 0 ? argv[previewIdx + 1] : null;
const OUT = path.join(root, 'assets', DEV);
const profile = JSON.parse(await readFile(path.join(root, 'profiles', `${DEV}.json`), 'utf8'));
const ASPECT = profile.image.height / profile.image.width;

// Travail à mi-résolution des cartes : largement assez pour un champ lumineux calculé au quart.
async function gray(name, w) {
  const { data, info } = await sharp(path.join(OUT, name)).resize({ width: w }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}
const meta = JSON.parse(await readFile(path.join(OUT, 'meta.json'), 'utf8'));
const W = Math.round(meta.size[0] / 2);
const lum = await gray('lum.webp', W);
const edges = await gray('edges.webp', W);
const H = lum.h;
// Contours épaissis d'un pixel (maximum sur 3 x 3) : bouche les brèches d'un pixel dans les liserés,
// par lesquelles une croissance de région s'échapperait.
const edgeMax = new Uint8Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  let m = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const yy = Math.min(H - 1, Math.max(0, y + dy)), xx = Math.min(W - 1, Math.max(0, x + dx));
    m = Math.max(m, edges.data[yy * W + xx]);
  }
  edgeMax[y * W + x] = m;
}

// ------------------------------------------------------------ géométrie des zones

const { inZone, normalize, signature } = zoneGeometry(ASPECT);

// ------------------------------------------------------------ morphologie et remplissage

function dilate(m, r) {
  const o = new Uint8Array(m.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!m[y * W + x]) continue;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < H && xx >= 0 && xx < W && dx * dx + dy * dy <= r * r) o[yy * W + xx] = 1;
    }
  }
  return o;
}
const erode = (m, r) => { const inv = m.map((x) => 1 - x); return dilate(inv, r).map((x) => 1 - x); };

/** Bouche les trous : tout ce qui n'est pas atteignable depuis le bord de la boîte en restant hors du masque. */
function fillHoles(m, box) {
  const [x0, x1, y0, y1] = box;
  const out = new Uint8Array(m.length), seen = new Uint8Array(m.length);
  const stack = [];
  for (let x = x0; x <= x1; x++) for (const y of [y0, y1]) stack.push(y * W + x);
  for (let y = y0; y <= y1; y++) for (const x of [x0, x1]) stack.push(y * W + x);
  while (stack.length) {
    const p = stack.pop();
    if (seen[p] || m[p]) continue;
    seen[p] = 1;
    const x = p % W, y = (p / W) | 0;
    if (x > x0) stack.push(p - 1); if (x < x1) stack.push(p + 1);
    if (y > y0) stack.push(p - W); if (y < y1) stack.push(p + W);
  }
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const p = y * W + x; out[p] = seen[p] ? 0 : 1; }
  return out;
}

/** Garde les régions d'au moins minFrac fois la taille de la plus grande (1 : la plus grande seule). */
function keepComponents(m, box, minFrac) {
  const [x0, x1, y0, y1] = box;
  const lab = new Int32Array(m.length);
  const sizes = [0];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const s = y * W + x;
    if (!m[s] || lab[s]) continue;
    const n = sizes.length; let count = 0; const stack = [s]; lab[s] = n;
    while (stack.length) {
      const p = stack.pop(); count++;
      const px = p % W, py = (p / W) | 0;
      for (const q of [px > x0 ? p - 1 : -1, px < x1 ? p + 1 : -1, py > y0 ? p - W : -1, py < y1 ? p + W : -1]) {
        if (q >= 0 && m[q] && !lab[q]) { lab[q] = n; stack.push(q); }
      }
    }
    sizes.push(count);
  }
  const max = Math.max(0, ...sizes);
  return m.map((v, i) => (v && sizes[lab[i]] >= max * minFrac ? 1 : 0));
}

function largestComponent(m, box) {
  const [x0, x1, y0, y1] = box;
  const lab = new Int32Array(m.length);
  let best = 0, bestN = 0, n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const s = y * W + x;
    if (!m[s] || lab[s]) continue;
    n++; let count = 0; const stack = [s]; lab[s] = n;
    while (stack.length) {
      const p = stack.pop(); count++;
      const px = p % W, py = (p / W) | 0;
      for (const q of [px > x0 ? p - 1 : -1, px < x1 ? p + 1 : -1, py > y0 ? p - W : -1, py < y1 ? p + W : -1]) {
        if (q >= 0 && m[q] && !lab[q]) { lab[q] = n; stack.push(q); }
      }
    }
    if (count > bestN) { bestN = count; best = n; }
  }
  return m.map((v, i) => (v && lab[i] === best ? 1 : 0));
}

const median = (a) => { if (!a.length) return 0; const s = Float32Array.from(a).sort(); return s[s.length >> 1]; };

// ------------------------------------------------------------ segmentation d'une zone

function segment(z) {
  // Masque géométrique et boîte englobante (en pixels).
  const G = new Uint8Array(W * H);
  let bx0 = W, bx1 = 0, by0 = H, by1 = 0, gArea = 0;
  const r = z.rect;
  const px0 = Math.max(0, Math.floor(r[0] * W) - 2), px1 = Math.min(W - 1, Math.ceil(r[1] * W) + 2);
  const py0 = Math.max(0, Math.floor(r[2] * H) - 2), py1 = Math.min(H - 1, Math.ceil(r[3] * H) + 2);
  for (let y = py0; y <= py1; y++) for (let x = px0; x <= px1; x++) {
    if (inZone(z, (x + 0.5) / W, (y + 0.5) / H)) {
      G[y * W + x] = 1; gArea++;
      bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y);
    }
  }
  if (!gArea) return null;
  const box = [Math.max(0, bx0 - 1), Math.min(W - 1, bx1 + 1), Math.max(0, by0 - 1), Math.min(H - 1, by1 + 1)];
  const L = lum.data, E = z.refine === 'silhouette' ? edges.data : edgeMax;
  let S = new Uint8Array(W * H);

  if (z.refine === 'silhouette') {
    // Fond : bordure juste à l'extérieur de la zone.
    const ring = [], inside = [];
    const m = Math.max(3, Math.round(W * 0.006));
    for (let y = Math.max(0, by0 - m); y <= Math.min(H - 1, by1 + m); y++) for (let x = Math.max(0, bx0 - m); x <= Math.min(W - 1, bx1 + m); x++) {
      const p = y * W + x;
      if (G[p]) inside.push(L[p]); else ring.push(L[p]);
    }
    // Fond = partie la plus sombre du pourtour (châssis), pas sa médiane : le pourtour d'une carte
    // contient souvent un cadre métallique clair qui fausserait la référence.
    const pct = (a, q) => { const s = Float32Array.from(a).sort(); return s[Math.floor(q * (s.length - 1))] ?? 0; };
    const bg = pct(ring, 0.15), fg = median(inside);
    const thr = bg + Math.max(4, (fg - bg) * 0.3);
    for (let p = 0; p < S.length; p++) if (G[p] && L[p] > thr) S[p] = 1;
    S = erode(dilate(S, 3), 3);
    S = fillHoles(S, box);
    S = largestComponent(S, box);
  } else {
    // Cœur de la zone : boîte réduite de 30 % autour du centre, référence = médiane.
    const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2, hx = (bx1 - bx0) * 0.35, hy = (by1 - by0) * 0.35;
    const core = [];
    for (let y = Math.round(cy - hy); y <= Math.round(cy + hy); y++) for (let x = Math.round(cx - hx); x <= Math.round(cx + hx); x++) {
      const p = y * W + x; if (G[p]) core.push(L[p]);
    }
    const ref = median(core);
    const mad = median(core.map((v) => Math.abs(v - ref)));
    const tol = Math.max(4, Math.min(30, 2 * mad + 3));
    // Croissance de proche en proche : un pixel rejoint la région s'il ressemble à son voisin
    // (suit les dégradés d'une plaque) et s'il n'est pas sur un contour net (ombre, liseré).
    // Les luminances seules ne suffisent pas : une plaque, le caloduc et la carte voisine ont
    // des valeurs proches ; ce sont les contours qui les séparent.
    const EDGE_STOP = z.refineEdge ?? 28, STEP = 4;
    const stack = [];
    if (z.kind === 'path') {
      // Chemin (caloduc, nappe) : graines le long de la ligne centrale, référence = sa médiane.
      const pts = [];
      for (let i = 0; i < z.path.length - 1; i++) {
        const [ax, ay] = z.path[i], [bx, by] = z.path[i + 1];
        const n = Math.ceil(Math.hypot((bx - ax) * W, (by - ay) * H));
        for (let k = 0; k <= n; k++) pts.push(Math.round((ay + (by - ay) * k / n) * H) * W + Math.round((ax + (bx - ax) * k / n) * W));
      }
      const refLine = median(pts.filter((p) => G[p]).map((p) => L[p]));
      for (const p of pts) if (G[p] && Math.abs(L[p] - refLine) <= tol + 4 && E[p] < EDGE_STOP) { S[p] = 1; stack.push(p); }
    } else {
      for (let y = Math.round(cy - hy); y <= Math.round(cy + hy); y++) for (let x = Math.round(cx - hx); x <= Math.round(cx + hx); x++) {
        const p = y * W + x; if (G[p] && Math.abs(L[p] - ref) <= tol && E[p] < EDGE_STOP) { S[p] = 1; stack.push(p); }
      }
    }
    while (stack.length) {
      const p = stack.pop();
      const x = p % W, y = (p / W) | 0;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) {
        if (q < 0 || S[q] || !G[q]) continue;
        if (E[q] < EDGE_STOP && Math.abs(L[q] - L[p]) <= STEP) { S[q] = 1; stack.push(q); }
      }
    }
    // Le cœur de départ peut chevaucher une pièce voisine (le caloduc sur une plaque) : on écarte
    // les petites régions. Les grandes restent, même séparées (une batterie coupée par la nappe).
    S = keepComponents(S, box, 0.4);
    // Les liserés eux-mêmes appartiennent au composant : on les récupère par une dilatation.
    S = dilate(S, 2);
    S = erode(dilate(S, 2), 2);
    S = fillHoles(S, box);
  }
  // Toujours à l'intérieur de la géométrie de la zone.
  let sArea = 0;
  for (let p = 0; p < S.length; p++) { S[p] &= G[p]; sArea += S[p]; }
  return { S, ratio: sArea / gArea };
}

// ------------------------------------------------------------ assemblage

// Même normalisation que le moteur (voir zone-geom.mjs).
normalize(profile.zones);
const zones = profile.zones.filter((z) => z.refine);
// Les plus grandes d'abord : elles prennent le canal R, les plus petites se superposent en G puis B.
zones.sort((a, b) => (b.rect[1] - b.rect[0]) * (b.rect[3] - b.rect[2]) - (a.rect[1] - a.rect[0]) * (a.rect[3] - a.rect[2]));
const rgb = new Uint8Array(W * H * 3);
const index = {};
let id = 0;
for (const z of zones) {
  const res = segment(z);
  if (!res || res.ratio < 0.2) {
    console.log(`${z.id.padEnd(20)} segmentation incertaine (${res ? Math.round(res.ratio * 100) : 0} %) : forme géométrique conservée`);
    continue;
  }
  id++;
  let overflow = 0;
  for (let p = 0; p < W * H; p++) {
    if (!res.S[p]) continue;
    const o = p * 3;
    if (!rgb[o]) rgb[o] = id; else if (!rgb[o + 1]) rgb[o + 1] = id; else if (!rgb[o + 2]) rgb[o + 2] = id; else overflow++;
  }
  index[z.id] = { id, refine: z.refine, geom: signature(z) };
  console.log(`${z.id.padEnd(20)} ${z.refine.padEnd(10)} couvre ${Math.round(res.ratio * 100)} % de sa forme géométrique${overflow ? ` (${overflow} px au-delà de 3 superpositions)` : ''}`);
}

await sharp(Buffer.from(rgb.buffer), { raw: { width: W, height: H, channels: 3 } }).png({ compressionLevel: 9 }).toFile(path.join(OUT, 'zones-mask.png'));
await writeFile(path.join(OUT, 'zones-mask.json'), JSON.stringify({ size: [W, H], zones: index }, null, 1) + '\n');
console.log(`assets/${DEV}/zones-mask.png ${W} x ${H}, ${id} zones affinées`);

if (PREVIEW) {
  // Aperçu : image d'origine assombrie, zones affinées teintées.
  const colors = [[255, 90, 90], [90, 200, 255], [255, 200, 60], [120, 255, 140], [220, 120, 255], [255, 150, 60], [80, 255, 230]];
  const out = Buffer.alloc(W * H * 3);
  for (let p = 0; p < W * H; p++) {
    const g = lum.data[p] * 0.55;
    let r = g, gg = g, b = g;
    for (let c = 0; c < 3; c++) {
      const k = rgb[p * 3 + c];
      if (k) { const col = colors[(k - 1) % colors.length]; r = r * 0.45 + col[0] * 0.55; gg = gg * 0.45 + col[1] * 0.55; b = b * 0.45 + col[2] * 0.55; }
    }
    out[p * 3] = r; out[p * 3 + 1] = gg; out[p * 3 + 2] = b;
  }
  await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toFile(PREVIEW);
}
