#!/usr/bin/env node
// Pièces électroniques des zones de carte, détectées dans l'image à pleine résolution.
//
// Une zone marquée "parts": true (alimentation, stockage, réseau, carte mère...) n'éclaire plus une
// surface : seules ses pièces (puces, résistances, billes BGA, selfs) s'allument, le circuit imprimé
// entre elles reste sombre, et chaque pièce s'allume d'un bloc (le moteur lit la lumière au centre de
// la pièce), si bien que les puces scintillent une à une.
//
// Détection, zone par zone :
//   1. fond du circuit = luminance la plus fréquente de la moitié sombre de la zone ;
//      une pièce = ce qui dépasse nettement ce fond ;
//   2. corps des puces sombres bouchés (intérieur d'un contour fermé), pistes fines supprimées
//      (ouverture d'un pixel) ;
//   3. ne sont pas des pièces, donc écartés : les cadres métalliques (grandes formes creuses), les
//      formes filiformes (liserés, arcs) et les pièces coupées par le bord de la zone ;
//      les très grandes pièces gardent une lumière variable (pas de lecture au centre).
// Les zones non marquées qui chevauchent une zone de carte (puce principale, connecteur) gardent
// leur rendu habituel.
//
// Sorties (dans assets/<appareil>/) :
//   zones-parts.png   RGB opaque, pleine résolution. Par pixel :
//                       (0, 0, 0)       hors des zones de carte : rendu habituel ;
//                       (0, 0, 15)      circuit imprimé d'une zone de carte : aucune lumière ;
//                       (x, y, 128 + h) pièce : centre (x + 256 * (h & 15), y + 256 * (h >> 4)) ;
//                       (0, 0, 142)     très grande pièce : lumière lue sur place.
//   zones-parts.json  taille et géométrie de référence des zones concernées.
//
// Usage : node scripts/build-parts.mjs [--air] [--preview fichier.png]

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
const { inZone, normalize, signature } = zoneGeometry(ASPECT);
normalize(profile.zones);

const { data: L, info } = await sharp(path.join(OUT, 'lum.webp')).greyscale().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height;

// Masques de forme (mi-résolution) : la région d'une zone affinée suit sa forme réelle.
const maskIndex = JSON.parse(await readFile(path.join(OUT, 'zones-mask.json'), 'utf8'));
const mk = await sharp(path.join(OUT, 'zones-mask.png')).raw().toBuffer({ resolveWithObject: true });
const MW = mk.info.width, MH = mk.info.height, MC = mk.info.channels;
function shapeOf(z) {
  const src = z.maskOf ? profile.zones.find((o) => o.id === z.maskOf) : z;
  const m = src && maskIndex.zones[src.id];
  if (m && m.geom === signature(src)) {
    return (x, y) => {
      const o = (Math.min(MH - 1, ((y * MH) / H) | 0) * MW + Math.min(MW - 1, ((x * MW) / W) | 0)) * MC;
      return mk.data[o] === m.id || mk.data[o + 1] === m.id || mk.data[o + 2] === m.id;
    };
  }
  return (x, y) => inZone(z, (x + 0.5) / W, (y + 0.5) / H);
}
const boxOf = (z) => [Math.max(0, Math.floor(z.rect[0] * W) - 1), Math.min(W - 1, Math.ceil(z.rect[1] * W) + 1), Math.max(0, Math.floor(z.rect[2] * H) - 1), Math.min(H - 1, Math.ceil(z.rect[3] * H) + 1)];

const partsZones = profile.zones.filter((z) => z.parts);
if (!partsZones.length) {
  console.log(`assets/${DEV} : aucune zone "parts"`);
  process.exit(0);
}

// ------------------------------------------------------------ région et seuil de détection

const REG = new Uint8Array(W * H);   // 1 : zone de carte
const THR = new Uint8Array(W * H);   // seuil de luminance d'une pièce
let bx0 = W, bx1 = 0, by0 = H, by1 = 0;
// Les plus petites d'abord : là où les zones se chevauchent, la plus grande impose son seuil. Une
// petite zone (une puce de stockage) est surtout couverte par sa puce, qui fausserait le « fond ».
const bySize = [...partsZones].sort((a, b) => (a.rect[1] - a.rect[0]) * (a.rect[3] - a.rect[2]) - (b.rect[1] - b.rect[0]) * (b.rect[3] - b.rect[2]));
for (const z of bySize) {
  const inside = shapeOf(z), [x0, x1, y0, y1] = boxOf(z);
  const hist = new Uint32Array(256), px = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inside(x, y)) { hist[L[y * W + x]]++; px.push(y * W + x); }
  if (!px.length) continue;
  const pct = (q) => { let n = 0; for (let v = 0; v < 256; v++) { n += hist[v]; if (n >= q * px.length) return v; } return 255; };
  const med = pct(0.5), p95 = pct(0.95);
  let bg = 0;
  for (let v = 0; v <= med; v++) if (hist[v] > hist[bg]) bg = v;
  const thr = Math.min(254, bg + Math.max(5, Math.round((p95 - bg) * 0.15)));
  for (const p of px) { REG[p] = 1; THR[p] = thr; }
  bx0 = Math.min(bx0, x0); bx1 = Math.max(bx1, x1); by0 = Math.min(by0, y0); by1 = Math.max(by1, y1);
  console.log(`${z.id.padEnd(18)} fond ${bg}, seuil ${thr} (médiane ${med}, 95e centile ${p95})`);
}
// Marge de détection autour des zones : une pièce dont le centre est dans la zone garde sa forme
// entière même si elle déborde un peu (sinon la zone découperait les pièces de son bord).
const M = Math.round(W * 0.015);
bx0 = Math.max(1, bx0 - M); bx1 = Math.min(W - 2, bx1 + M); by0 = Math.max(1, by0 - M); by1 = Math.min(H - 2, by1 + M);
const BOX = [bx0, bx1, by0, by1];

// Les autres zones (puce principale, connecteur...) gardent leur rendu : retirées de la région,
// et la marge ne s'y étend pas.
const EXC = new Uint8Array(W * H);
for (const z of profile.zones) {
  if (z.parts) continue;
  const [x0, x1, y0, y1] = boxOf(z);
  if (x1 < bx0 || x0 > bx1 || y1 < by0 || y0 > by1) continue;
  const inside = shapeOf(z);
  for (let y = Math.max(y0, by0); y <= Math.min(y1, by1); y++) for (let x = Math.max(x0, bx0); x <= Math.min(x1, bx1); x++) {
    const p = y * W + x;
    if (inside(x, y)) { EXC[p] = 1; REG[p] = 0; }
  }
}
const REG0 = new Uint8Array(REG); // zones elles-mêmes (sans la marge)
{
  let front = [];
  for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) if (REG[y * W + x]) front.push(y * W + x);
  for (let k = 0; k < M && front.length; k++) {
    const next = [];
    for (const p of front) for (const d of [-1, 1, -W, W]) {
      const q = p + d, qx = q % W, qy = (q / W) | 0;
      if (qx < bx0 || qx > bx1 || qy < by0 || qy > by1 || REG[q] || EXC[q]) continue;
      REG[q] = 1; THR[q] = THR[p]; next.push(q);
    }
    front = next;
  }
}

// ------------------------------------------------------------ morphologie (sur la boîte des régions)

function each(fn) { for (let y = BOX[2]; y <= BOX[3]; y++) for (let x = BOX[0]; x <= BOX[1]; x++) fn(y * W + x); }
const N4 = [-1, 1, -W, W], N8 = [-1, 1, -W, W, -W - 1, -W + 1, W - 1, W + 1];
function dilate(m) { const o = new Uint8Array(m); each((p) => { if (!m[p]) for (const d of N4) if (m[p + d]) { o[p] = 1; break; } }); return o; }
function erode(m) { const o = new Uint8Array(m); each((p) => { if (m[p]) for (const d of N4) if (!m[p + d]) { o[p] = 0; break; } }); return o; }

/** Composantes connexes (8 voisins) : étiquettes et statistiques. */
function label(m) {
  const lab = new Int32Array(W * H), comps = [null];
  each((s) => {
    if (!m[s] || lab[s]) return;
    const id = comps.length, c = { n: 0, sx: 0, sy: 0, x0: W, x1: 0, y0: H, y1: 0 };
    const stack = [s]; lab[s] = id;
    while (stack.length) {
      const p = stack.pop(), x = p % W, y = (p / W) | 0;
      c.n++; c.sx += x; c.sy += y;
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      for (const d of N8) { const q = p + d; if (m[q] && !lab[q]) { lab[q] = id; stack.push(q); } }
    }
    comps.push(c);
  });
  return { lab, comps };
}

// 1. Pixels plus clairs que le fond du circuit.
let P = new Uint8Array(W * H);
each((p) => { if (REG[p] && L[p] > THR[p]) P[p] = 1; });

// 2. Cadres métalliques : grandes formes creuses, ce ne sont pas des pièces.
const FRAME = Math.round(W * 0.08);
{
  const { lab, comps } = label(P);
  const drop = comps.map((c) => c && (c.x1 - c.x0 > FRAME || c.y1 - c.y0 > FRAME) && c.n < 0.3 * (c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1));
  let n = 0;
  each((p) => { if (P[p] && drop[lab[p]]) { P[p] = 0; } });
  drop.forEach((d) => { if (d) n++; });
  if (n) console.log(`${n} cadre(s) métallique(s) écarté(s)`);
}

// 3. Corps des puces sombres : l'intérieur d'un contour fermé fait partie de la pièce.
{
  const open = new Uint8Array(W * H), stack = [];
  each((p) => { if (!REG[p] && !P[p]) { open[p] = 1; stack.push(p); } });
  for (let x = BOX[0]; x <= BOX[1]; x++) for (const y of [BOX[2], BOX[3]]) { const p = y * W + x; if (!P[p] && !open[p]) { open[p] = 1; stack.push(p); } }
  for (let y = BOX[2]; y <= BOX[3]; y++) for (const x of [BOX[0], BOX[1]]) { const p = y * W + x; if (!P[p] && !open[p]) { open[p] = 1; stack.push(p); } }
  while (stack.length) {
    const p = stack.pop(), x = p % W, y = (p / W) | 0;
    for (const d of N4) {
      const q = p + d, qx = q % W, qy = (q / W) | 0;
      if (qx < BOX[0] || qx > BOX[1] || qy < BOX[2] || qy > BOX[3] || Math.abs(qx - x) > 1) continue;
      if (!P[q] && !open[q]) { open[q] = 1; stack.push(q); }
    }
  }
  // Trous bouchés, sauf les très grands (zone de circuit entourée de pièces, pas un boîtier).
  const holes = new Uint8Array(W * H);
  each((p) => { if (!P[p] && !open[p] && REG[p]) holes[p] = 1; });
  const { lab, comps } = label(holes);
  const HOLE_MAX = (W * 0.06) ** 2;
  each((p) => { if (holes[p] && comps[lab[p]].n <= HOLE_MAX) P[p] = 1; });
}

// 4. Ouverture d'un pixel : les pistes fines (deux pixels ou moins) disparaissent, pas les pièces.
P = dilate(erode(P));
each((p) => { if (!REG[p]) P[p] = 0; });

// 5. Ce qui n'est pas une pièce entière :
//    - formes filiformes (liserés, arcs, bords de cadre) : rien ne survit à une érosion de deux
//      pixels alors qu'elles s'étendent loin (une bille BGA, petite, est conservée) ;
//    - pièces coupées par le bord de la marge (vis, connecteur à cheval) : à moitié éclairées,
//      elles dessineraient le contour de la zone ;
//    - pièces dont le centre est hors de la zone : elles appartiennent à la voisine.
{
  const core = erode(erode(P));
  const { lab, comps } = label(P);
  const thick = new Uint8Array(comps.length), edge = new Uint8Array(comps.length);
  each((p) => {
    if (!P[p]) return;
    if (core[p]) thick[lab[p]] = 1;
    for (const d of N4) if (!REG[p + d]) { edge[lab[p]] = 1; break; }
  });
  let thin = 0, cut = 0;
  const drop = comps.map((c, i) => {
    if (!c) return false;
    const w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1, ext = Math.max(w, h), fill = c.n / (w * h);
    // Filiforme, très allongée (bord de carte) ou très creuse et étendue (coin de cadre en L) :
    // une pièce est compacte et remplit sa boîte.
    if ((!thick[i] && ext > 20) || (ext > 40 && ext > 10 * Math.min(w, h)) || (fill < 0.35 && ext > 30)) { thin++; return true; }
    if (edge[i]) { cut++; return true; }
    return !REG0[Math.round(c.sy / c.n) * W + Math.round(c.sx / c.n)];
  });
  each((p) => { if (P[p] && drop[lab[p]]) P[p] = 0; });
  console.log(`${thin} forme(s) filiforme(s) et ${cut} pièce(s) coupée(s) par le bord écartées`);
}

// ------------------------------------------------------------ pièces et encodage

const MIN_AREA = 10, SELF = Math.round(W * 0.06);
const { lab, comps } = label(P);
const rgb = new Uint8Array(W * H * 3);
let parts = 0, big = 0, area = 0, regArea = 0;
const code = comps.map((c) => {
  if (!c || c.n < MIN_AREA) return null;
  parts++;
  if (c.x1 - c.x0 > SELF || c.y1 - c.y0 > SELF) { big++; return [0, 0, 142]; }
  const cx = Math.round(c.sx / c.n), cy = Math.round(c.sy / c.n);
  return [cx & 255, cy & 255, 128 + ((cy >> 8) << 4) + (cx >> 8)];
});
each((p) => {
  const c = P[p] ? code[lab[p]] : null, o = p * 3;
  if (REG0[p]) regArea++;
  if (c) { rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2]; area++; } else if (REG0[p]) rgb[o + 2] = 15;
});

await sharp(Buffer.from(rgb.buffer), { raw: { width: W, height: H, channels: 3 } }).png({ compressionLevel: 9 }).toFile(path.join(OUT, 'zones-parts.png'));
const index = { size: [W, H], zones: Object.fromEntries(partsZones.map((z) => [z.id, signature(z)])) };
await writeFile(path.join(OUT, 'zones-parts.json'), JSON.stringify(index, null, 1) + '\n');
console.log(`assets/${DEV}/zones-parts.png ${W} x ${H} : ${parts} pièces (${big} très grandes), ${Math.round((100 * area) / Math.max(1, regArea))} % de la surface des zones de carte`);

if (PREVIEW) {
  // Aperçu : image assombrie, circuit des zones de carte en bleu nuit, chaque pièce d'une couleur.
  const out = Buffer.alloc(W * H * 3);
  const hue = (i) => { const h = (i * 0.618034) % 1; const k = (n) => (n + h * 6) % 6; const f = (n) => 1 - Math.max(0, Math.min(k(n), 4 - k(n), 1)); return [f(5), f(3), f(1)].map((v) => 60 + 195 * v); };
  for (let p = 0; p < W * H; p++) {
    const g = L[p] * 0.6, o = p * 3;
    if (P[p] && code[lab[p]]) { const c = hue(lab[p]); out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; }
    else if (REG0[p]) { out[o] = g * 0.4; out[o + 1] = g * 0.4; out[o + 2] = g * 0.4 + 40; }
    else { out[o] = g; out[o + 1] = g; out[o + 2] = g; }
  }
  await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toFile(PREVIEW);
}
