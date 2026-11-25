#!/usr/bin/env node
// Génère les versions WebP optimisées des calques (largeur max 2880 px) dans assets/opt.
// mono-b est ignoré : identique octet pour octet à mono-a (voir analyze-images).
// Les fichiers déjà à jour (plus récents que la source) ne sont pas régénérés.

import sharp from 'sharp';
import { stat, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'assets/src');
const OPT = path.join(root, 'assets/opt');
const MAX_W = 2880;
const FORCE = process.argv.includes('--force');

// Qualité par calque : les fonds sombres à dégradés lents supportent mal une compression forte
// (effet de bandes), on garde donc une qualité élevée.
const LAYERS = {
  'base-dark': 90,
  'rainbow-mid': 88,
  'rainbow-high': 88,
  warm: 86,
  sunset: 88,
  'mono-a': 88,
};

await mkdir(OPT, { recursive: true });
let total = 0;
for (const [name, quality] of Object.entries(LAYERS)) {
  const src = path.join(SRC, `${name}.png`);
  const dst = path.join(OPT, `${name}.webp`);
  const [s, d] = await Promise.all([stat(src).catch(() => null), stat(dst).catch(() => null)]);
  if (!s) {
    // Originaux absents (dépôt cloné) : les WebP fournis suffisent.
    if (!d) throw new Error(`${name} : ni assets/src/${name}.png ni assets/opt/${name}.webp`);
    total += d.size;
    console.log(`${name.padEnd(13)} fourni (${(d.size / 1024).toFixed(0)} Ko, original absent)`);
    continue;
  }
  if (!FORCE && d && d.mtimeMs > s.mtimeMs) {
    total += d.size;
    console.log(`${name.padEnd(13)} à jour (${(d.size / 1024).toFixed(0)} Ko)`);
    continue;
  }
  const img = sharp(src);
  const { width } = await img.metadata();
  const info = await img
    .resize({ width: Math.min(width, MAX_W), withoutEnlargement: true })
    .webp({ quality, effort: 6, smartSubsample: true })
    .toFile(dst);
  total += info.size;
  console.log(`${name.padEnd(13)} ${info.width} x ${info.height}  ${(s.size / 1024).toFixed(0)} Ko -> ${(info.size / 1024).toFixed(0)} Ko`);
}
console.log(`Total : ${(total / 1024 / 1024).toFixed(2)} Mo`);
