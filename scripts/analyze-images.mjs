#!/usr/bin/env node
// Analyse des calques : dimensions, empreintes, alignement pixel à pixel,
// signature colorimétrique et suggestion automatique du masque de la puce (SoC).
// Usage : node scripts/analyze-images.mjs [--write]
//   --write : met à jour la zone "soc" de src/zones.json avec la suggestion.

import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'assets/src');
const OUT = path.join(root, 'assets/analysis');
const LAYERS = ['base-dark', 'rainbow-high', 'rainbow-mid', 'warm', 'sunset', 'mono-a', 'mono-b'];
const WRITE = process.argv.includes('--write');

async function load(name) {
  const file = path.join(SRC, `${name}.png`);
  const buf = await readFile(file);
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { name, data, w: info.width, h: info.height, md5: createHash('md5').update(buf).digest('hex') };
}

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max / 255];
}

// Signature : luminance moyenne, saturation moyenne, teinte dominante dans 3 bandes verticales.
function signature(img) {
  const { data, w, h } = img;
  let lum = 0, sat = 0, n = 0;
  const bands = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]; // somme x, somme y (vecteur teinte), poids, n
  for (let y = 0; y < h; y += 4) {
    for (let x = 0; x < w; x += 4) {
      const i = (y * w + x) * 3;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const [hh, s, v] = rgbToHsv(r, g, b);
      lum += 0.2126 * r + 0.7152 * g + 0.0722 * b; sat += s; n++;
      const band = bands[Math.min(2, Math.floor((x / w) * 3))];
      const wgt = s * v;
      band[0] += Math.cos((hh * Math.PI) / 180) * wgt;
      band[1] += Math.sin((hh * Math.PI) / 180) * wgt;
      band[2] += wgt; band[3]++;
    }
  }
  const hueName = (deg, chroma) => {
    if (chroma < 0.015) return 'neutre';
    const names = [[15, 'rouge'], [45, 'orange'], [70, 'jaune'], [160, 'vert'], [200, 'cyan'], [250, 'bleu'], [290, 'violet'], [335, 'magenta'], [360, 'rouge']];
    return names.find(([lim]) => deg < lim)[1];
  };
  return {
    lum: lum / n / 255,
    sat: sat / n,
    bands: bands.map(([cx, cy, wsum, cnt]) => {
      const deg = ((Math.atan2(cy, cx) * 180) / Math.PI + 360) % 360;
      return hueName(deg, wsum / cnt);
    }),
  };
}

// Carte de contours (gradient de luminance) sur une région, pour comparer des calques
// dont l'étalonnage diffère mais dont la géométrie doit être identique.
function edgeMap(img, rx, ry, rw, rh) {
  const { data, w } = img;
  const L = new Float32Array(rw * rh);
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const i = ((ry + y) * w + rx + x) * 3;
    L[y * rw + x] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  const E = new Float32Array(rw * rh);
  let mean = 0;
  for (let y = 1; y < rh - 1; y++) for (let x = 1; x < rw - 1; x++) {
    const gx = L[y * rw + x + 1] - L[y * rw + x - 1];
    const gy = L[(y + 1) * rw + x] - L[(y - 1) * rw + x];
    const e = Math.hypot(gx, gy); E[y * rw + x] = e; mean += e;
  }
  mean /= rw * rh;
  let sd = 0; for (let k = 0; k < E.length; k++) { E[k] -= mean; sd += E[k] * E[k]; }
  sd = Math.sqrt(sd / E.length) || 1;
  for (let k = 0; k < E.length; k++) E[k] /= sd;
  return E;
}

// Recherche du décalage (dx, dy) qui maximise la corrélation des contours.
function bestShift(ref, img, R = 3) {
  const rx = Math.round(ref.w * 0.34), ry = Math.round(ref.h * 0.1);
  const rw = Math.round(ref.w * 0.32), rh = Math.round(ref.h * 0.28);
  const A = edgeMap(ref, rx, ry, rw, rh);
  let best = { dx: 0, dy: 0, corr: -Infinity }, corr00 = 0;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const B = edgeMap(img, rx + dx, ry + dy, rw, rh);
    let s = 0; for (let k = 0; k < A.length; k += 2) s += A[k] * B[k];
    const c = s / (A.length / 2);
    if (dx === 0 && dy === 0) corr00 = c;
    if (c > best.corr) best = { dx, dy, corr: c };
  }
  return { ...best, corr00 };
}

function meanAbsDiff(a, b) {
  let s = 0; for (let k = 0; k < a.data.length; k += 7) s += Math.abs(a.data[k] - b.data[k]);
  return s / Math.ceil(a.data.length / 7);
}

// Suggestion du masque de la puce : seuillage de saturation dans rainbow-high,
// composante connexe qui contient le centre présumé de la puce.
async function suggestSocMask(img, seedN) {
  const { data, w, h } = img;
  const mask = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 3;
    const [, s, v] = rgbToHsv(data[i], data[i + 1], data[i + 2]);
    if (s > 0.45 && v > 0.55) mask[p] = 1;
  }
  // Ouverture morphologique légère (érosion puis dilatation 1 px) pour couper les pistes fines.
  const morph = (src, erode) => {
    const dst = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      let acc = erode ? 1 : 0;
      for (let k = -1; k <= 1; k++) for (let j = -1; j <= 1; j++) {
        const q = src[p + k * w + j];
        acc = erode ? acc & q : acc | q;
      }
      dst[p] = acc;
    }
    return dst;
  };
  let m = morph(morph(morph(mask, true), true), false); m = morph(m, false);
  // Remplissage par diffusion depuis le pixel saturé le plus proche du centre présumé.
  let sx = Math.round(seedN.x * w), sy = Math.round(seedN.y * h);
  let seed = -1, bestD = Infinity;
  for (let y = sy - 60; y <= sy + 60; y++) for (let x = sx - 60; x <= sx + 60; x++) {
    if (m[y * w + x]) { const d = (x - sx) ** 2 + (y - sy) ** 2; if (d < bestD) { bestD = d; seed = y * w + x; } }
  }
  if (seed < 0) return null;
  const comp = new Uint8Array(w * h), stack = [seed]; comp[seed] = 1;
  let x0 = w, x1 = 0, y0 = h, y1 = 0, area = 0;
  while (stack.length) {
    const p = stack.pop(); area++;
    const x = p % w, y = (p / w) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    for (const q of [p - 1, p + 1, p - w, p + w]) if (m[q] && !comp[q]) { comp[q] = 1; stack.push(q); }
  }
  await mkdir(OUT, { recursive: true });
  const png = Buffer.alloc(w * h);
  for (let p = 0; p < w * h; p++) png[p] = comp[p] ? 255 : mask[p] ? 60 : 0;
  await sharp(png, { raw: { width: w, height: h, channels: 1 } })
    .extract({ left: Math.max(0, x0 - 120), top: Math.max(0, y0 - 120), width: Math.min(w - x0 + 120, x1 - x0 + 240), height: Math.min(h - y0 + 120, y1 - y0 + 240) })
    .png().toFile(path.join(OUT, 'soc-mask.png'));
  const r = (v) => Math.round(v * 1000) / 1000;
  return { x0: r(x0 / w), x1: r((x1 + 1) / w), y0: r(y0 / h), y1: r((y1 + 1) / h), areaPx: area, fill: area / ((x1 - x0 + 1) * (y1 - y0 + 1)) };
}

// Les PNG originaux ne sont pas versionnés : à télécharger sur le blog de Basic Apple Guy (voir README).
const missing = [];
for (const n of LAYERS) { try { await readFile(path.join(SRC, `${n}.png`)); } catch { missing.push(n); } }
if (missing.length) {
  console.error(`PNG originaux absents dans assets/src : ${missing.join(', ')}.\nTéléchargez-les depuis https://www.basicappleguy.com/basicappleblog/m4-macbook-air-internals-13-inch (voir README).`);
  process.exit(1);
}

const pad = (s, n) => String(s).padEnd(n);
const imgs = await Promise.all(LAYERS.map(load));
const ref = imgs[0];

console.log('\n== Dimensions et empreintes ==');
for (const im of imgs) {
  const ratio = (im.w / im.h).toFixed(4);
  console.log(`${pad(im.name, 14)} ${im.w} x ${im.h}  ratio ${ratio}  md5 ${im.md5.slice(0, 12)}`);
}
const sameSize = imgs.every((im) => im.w === ref.w && im.h === ref.h);
console.log(sameSize ? 'Toutes les images ont la même taille.' : 'ATTENTION : tailles différentes.');

console.log('\n== Alignement (corrélation des contours, référence base-dark) ==');
for (const im of imgs.slice(1)) {
  const s = bestShift(ref, im);
  const ok = s.dx === 0 && s.dy === 0;
  console.log(`${pad(im.name, 14)} meilleur décalage (${s.dx}, ${s.dy})  corrélation ${s.corr.toFixed(3)}  à (0,0) ${s.corr00.toFixed(3)}  ${ok ? 'aligné' : 'DÉCALÉ'}`);
}

console.log('\n== Signature colorimétrique ==');
console.log(`${pad('calque', 14)} ${pad('lum', 6)} ${pad('sat', 6)} gauche / centre / droite`);
for (const im of imgs) {
  const s = signature(im);
  console.log(`${pad(im.name, 14)} ${pad(s.lum.toFixed(3), 6)} ${pad(s.sat.toFixed(3), 6)} ${s.bands.join(' / ')}`);
}

console.log('\n== Calques monochromes redondants ==');
const ma = imgs.find((i) => i.name === 'mono-a'), mb = imgs.find((i) => i.name === 'mono-b');
const mad = meanAbsDiff(ma, mb);
if (ma.md5 === mb.md5) console.log('mono-a et mono-b sont identiques octet pour octet : mono-b est redondant, on garde mono-a.');
else console.log(`mono-a / mono-b : écart moyen ${mad.toFixed(2)} niveaux. ${mad < 2 ? 'Quasi identiques, mono-b redondant.' : 'Différents.'}`);

console.log('\n== Suggestion de masque pour la puce (rainbow-high, seuil de saturation) ==');
const zonesFile = path.join(root, 'src/zones.json');
const zones = JSON.parse(await readFile(zonesFile, 'utf8'));
const soc = zones.zones.find((z) => z.id === 'soc');
const seed = { x: (soc.rect[0] + soc.rect[1]) / 2, y: (soc.rect[2] + soc.rect[3]) / 2 };
const sug = await suggestSocMask(imgs.find((i) => i.name === 'rainbow-high'), seed);
if (!sug) console.log('Aucune région saturée trouvée près du centre présumé.');
else {
  console.log(`rect suggéré  x0 ${sug.x0}  x1 ${sug.x1}  y0 ${sug.y0}  y1 ${sug.y1}  (remplissage ${(sug.fill * 100).toFixed(0)} %)`);
  console.log(`rect actuel   x0 ${soc.rect[0]}  x1 ${soc.rect[1]}  y0 ${soc.rect[2]}  y1 ${soc.rect[3]}`);
  console.log('Masque écrit dans assets/analysis/soc-mask.png');
  if (WRITE) {
    soc.rect = [sug.x0, sug.x1, sug.y0, sug.y1];
    await writeFile(zonesFile, JSON.stringify(zones, null, 2) + '\n');
    console.log('src/zones.json mis à jour.');
  }
}
console.log('');
