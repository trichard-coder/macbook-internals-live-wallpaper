// Validation et écriture de profiles/pro.json, partagées par le serveur de dev Vite Pro
// (vite.pro.config.ts) et par server/telemetry-pro.mjs (endpoint POST /__profile-pro).

import { writeFile } from 'node:fs/promises';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isPt = (p) => Array.isArray(p) && p.length === 2 && p.every(isNum);
const r4 = (x) => Math.round(x * 10000) / 10000;
const KINDS = new Set(['rect', 'circle', 'path', 'frame']);

/** Vérifie la structure ; renvoie un message d'erreur ou null. */
export function validateProfile(obj) {
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.zones)) return 'champ "zones" manquant';
  if (!obj.render || typeof obj.render !== 'object') return 'champ "render" manquant';
  const ids = new Set();
  for (const z of obj.zones) {
    if (typeof z.id !== 'string' || !/^[a-z0-9_]+$/.test(z.id)) return `identifiant invalide : ${z.id}`;
    if (ids.has(z.id)) return `identifiant en double : ${z.id}`;
    ids.add(z.id);
    if (!KINDS.has(z.kind)) return `forme invalide pour ${z.id}`;
    if (!Array.isArray(z.rect) || z.rect.length !== 4 || !z.rect.every(isNum)) return `rect invalide pour ${z.id}`;
    if (z.polygon != null && (!Array.isArray(z.polygon) || z.polygon.length < 3 || !z.polygon.every(isPt))) return `polygone invalide pour ${z.id}`;
    if (z.kind === 'path' && (!Array.isArray(z.path) || z.path.length < 2 || !z.path.every(isPt))) return `chemin invalide pour ${z.id}`;
    if (z.kind === 'circle' && (!z.circle || !isPt(z.circle.c))) return `cercle invalide pour ${z.id}`;
  }
  return null;
}

const compact = (v) => JSON.stringify(v).replace(/,(?=["\-\d[{])/g, ', ').replace(/":/g, '": ').replace(/^\{/, '{ ').replace(/\}$/, ' }').replace(/\{"/g, '{ "').replace(/(\d|\]|")\}/g, '$1 }');

function round(v) {
  if (isNum(v)) return r4(v);
  if (Array.isArray(v)) return v.map(round);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)]));
  return v;
}

/** Sérialise avec une zone par ligne, pour des diffs lisibles. */
export function formatProfile(obj) {
  const order = ['id', 'label', 'kind', 'effect', 'signal', 'cell', 'rect', 'feather', 'circle', 'inner', 'path', 'width', 'origin', 'polygon'];
  const zoneLine = (z) => {
    const out = {};
    for (const k of order) if (z[k] != null) out[k] = round(z[k]);
    for (const k of Object.keys(z)) if (!(k in out) && z[k] != null) out[k] = round(z[k]);
    return '    ' + compact(out);
  };
  return [
    '{',
    `  "version": ${obj.version ?? 1},`,
    `  "name": ${JSON.stringify(obj.name ?? 'MacBook Pro')},`,
    `  "image": ${compact(obj.image)},`,
    `  "narrative": ${compact(obj.narrative)},`,
    `  "render": ${compact(round(obj.render))},`,
    '  "zones": [',
    obj.zones.map(zoneLine).join(',\n'),
    '  ]',
    '}',
    '',
  ].join('\n');
}

export async function writeProfileFile(file, obj) {
  const err = validateProfile(obj);
  if (err) throw new Error(err);
  await writeFile(file, formatProfile(obj));
}
