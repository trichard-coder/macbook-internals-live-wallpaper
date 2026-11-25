#!/usr/bin/env node
// Préparation de l'image MacBook Pro (suffixe image_7) pour le moteur WebGL2.
// Produit dans assets/pro :
//   base.webp    version couleur optimisée (largeur max 2880 px)
//   lum.webp     luminance (niveaux de gris)
//   detail.webp  carte de détails (passe-haut signé, 128 = neutre)
//   edges.webp   carte de contours (Sobel)
//   meta.json    dimensions et statistiques (points noir et blanc conseillés)
// L'image source n'est jamais modifiée : elle est copiée telle quelle dans assets/pro/src/.
//
// Usage : node scripts/prepare-pro-image.mjs [chemin/vers/image_7.png] [--force]

import sharp from 'sharp';
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'assets/pro');
const CACHE = path.join(OUT, 'src/image_7.png');
const MAX_W = 2880;
const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const explicit = argv.find((a) => !a.startsWith('--')) ?? process.env.PRO_SOURCE;

// ------------------------------------------------------------ recherche de la source

const isImage7 = (name) => /image[_ ]?\(?7\)?\.(png|jpe?g|webp)$/i.test(name) || /image_7/i.test(name);

async function findIn(dir) {
  try {
    const names = await readdir(dir);
    const hit = names.find(isImage7);
    return hit ? path.join(dir, hit) : null;
  } catch { return null; }
}

async function findSource() {
  if (explicit) return path.resolve(explicit);
  if (existsSync(CACHE)) return CACHE;
  for (const dir of [root, path.join(root, 'assets'), path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), 'Desktop')]) {
    const f = await findIn(dir);
    if (f) return f;
  }
  return null;
}

const src = await findSource();
if (!src) {
  console.error('Image source introuvable. Indiquez son chemin : node scripts/prepare-pro-image.mjs "/chemin/image (7).png"');
  process.exit(1);
}
await mkdir(path.dirname(CACHE), { recursive: true });
if (path.resolve(src) !== CACHE) {
  await copyFile(src, CACHE);
  console.log(`source copiée : ${path.relative(root, CACHE)} (depuis ${src})`);
}

// Rien à faire si les sorties sont plus récentes que la source.
const outputs = ['base.webp', 'lum.webp', 'detail.webp', 'edges.webp', 'meta.json'].map((f) => path.join(OUT, f));
if (!FORCE) {
  const s = await stat(CACHE);
  const ds = await Promise.all(outputs.map((f) => stat(f).catch(() => null)));
  if (ds.every((d) => d && d.mtimeMs > s.mtimeMs)) {
    console.log('assets/pro à jour (--force pour régénérer)');
    process.exit(0);
  }
}

// ------------------------------------------------------------ outils de traitement

/** Flou boîte séparable (sommes glissantes), bords répliqués. */
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / n;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / n;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** Approximation gaussienne : trois flous boîte successifs. */
function gauss(src, w, h, sigma) {
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2 - 0.5));
  return boxBlur(boxBlur(boxBlur(src, w, h, r), w, h, r), w, h, r);
}

function percentile(arr, p, step = 7) {
  const sample = [];
  for (let i = 0; i < arr.length; i += step) sample.push(arr[i]);
  sample.sort((a, b) => a - b);
  return sample[Math.min(sample.length - 1, Math.floor(p * (sample.length - 1)))];
}

const toU8 = (f, fn) => { const o = new Uint8Array(f.length); for (let i = 0; i < f.length; i++) o[i] = Math.max(0, Math.min(255, Math.round(fn(f[i])))); return o; };

async function writeGray(name, u8, w, h, quality) {
  const file = path.join(OUT, name);
  await sharp(Buffer.from(u8.buffer), { raw: { width: w, height: h, channels: 1 } })
    .webp({ quality, smartSubsample: false, effort: 6 })
    .toFile(file);
  const { size } = await stat(file);
  console.log(`${name.padEnd(12)} ${w} x ${h}  ${(size / 1024).toFixed(0)} Ko`);
  return size;
}

// ------------------------------------------------------------ traitement

const meta0 = await sharp(CACHE).metadata();
const W = Math.min(MAX_W, meta0.width), H = Math.round((meta0.height * W) / meta0.width);
console.log(`source ${meta0.width} x ${meta0.height} -> ${W} x ${H}`);

// Version couleur optimisée.
await sharp(CACHE).resize(W, H, { kernel: 'lanczos3' }).webp({ quality: 90, effort: 6 }).toFile(path.join(OUT, 'base.webp'));
console.log(`base.webp    ${W} x ${H}  ${((await stat(path.join(OUT, 'base.webp'))).size / 1024).toFixed(0)} Ko`);

// Luminance (Rec. 709 sur les valeurs gamma, suffisant pour une image quasi monochrome).
const { data: rgb } = await sharp(CACHE).resize(W, H, { kernel: 'lanczos3' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const lum = new Float32Array(W * H);
for (let i = 0, j = 0; i < lum.length; i++, j += 3) lum[i] = 0.2126 * rgb[j] + 0.7152 * rgb[j + 1] + 0.0722 * rgb[j + 2];
const black = percentile(lum, 0.005), white = percentile(lum, 0.9995), median = percentile(lum, 0.5);
await writeGray('lum.webp', toU8(lum, (v) => v), W, H, 92);

// Détails : passe-haut à deux échelles (pistes fines et composants), signé autour de 128.
const blurS = gauss(lum, W, H, 2.5), blurL = gauss(lum, W, H, 9);
const det = new Float32Array(W * H);
for (let i = 0; i < det.length; i++) det[i] = 0.6 * (lum[i] - blurS[i]) + 0.4 * (lum[i] - blurL[i]);
const absDet = det.map(Math.abs);
const detScale = 120 / Math.max(1, percentile(absDet, 0.997));
await writeGray('detail.webp', toU8(det, (v) => 128 + v * detScale), W, H, 90);

// Contours : Sobel sur une version légèrement lissée (évite d'amplifier le bruit de l'image).
const sm = gauss(lum, W, H, 0.8);
const edg = new Float32Array(W * H);
for (let y = 1; y < H - 1; y++) {
  for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const a = sm[i - W - 1], b = sm[i - W], c = sm[i - W + 1], d = sm[i - 1], f = sm[i + 1], g = sm[i + W - 1], hh = sm[i + W], k = sm[i + W + 1];
    const gx = c + 2 * f + k - a - 2 * d - g;
    const gy = g + 2 * hh + k - a - 2 * b - c;
    edg[i] = Math.hypot(gx, gy);
  }
}
const edgRef = Math.max(1, percentile(edg, 0.995));
await writeGray('edges.webp', toU8(edg, (v) => 255 * Math.pow(Math.min(1, v / edgRef), 0.75)), W, H, 90);

const meta = {
  source: path.basename(src),
  sourceSize: [meta0.width, meta0.height],
  size: [W, H],
  levels: { black: Math.round(black), white: Math.round(white), median: Math.round(median) },
  detailScale: Number(detScale.toFixed(3)),
  edgeRef: Number(edgRef.toFixed(1)),
  generated: new Date().toISOString(),
};
await writeFile(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
console.log('meta.json   ', JSON.stringify(meta.levels));
