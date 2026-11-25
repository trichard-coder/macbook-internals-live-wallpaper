// Validation et écriture de src/zones.json, partagées par le serveur de dev Vite
// et par le serveur de télémétrie (endpoint POST /__zones).

import { writeFile } from 'node:fs/promises';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const r4 = (x) => Math.round(x * 10000) / 10000;

/** Vérifie la structure ; renvoie un message d'erreur ou null. */
export function validateZones(obj) {
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.zones)) return 'champ "zones" manquant';
  const ids = new Set();
  for (const z of obj.zones) {
    if (typeof z.id !== 'string' || !/^[a-z0-9_]+$/.test(z.id)) return `identifiant invalide : ${z.id}`;
    if (ids.has(z.id)) return `identifiant en double : ${z.id}`;
    ids.add(z.id);
    if (!Array.isArray(z.rect) || z.rect.length !== 4 || !z.rect.every(isNum)) return `rect invalide pour ${z.id}`;
    if (z.polygon != null && (!Array.isArray(z.polygon) || z.polygon.length < 3 || !z.polygon.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNum))))
      return `polygone invalide pour ${z.id}`;
  }
  return null;
}

/** Sérialise avec une zone par ligne, pour des diffs lisibles. */
export function formatZones(obj) {
  const zoneLine = (z) => {
    const out = { id: z.id, label: z.label ?? z.id, rect: z.rect.map(r4), feather: r4(z.feather ?? 0.008) };
    if (z.anchor) out.anchor = z.anchor.map(r4);
    if (z.core) out.core = z.core.map(r4);
    if (z.polygon && z.polygon.length >= 3) out.polygon = z.polygon.map((p) => p.map(r4));
    return '    ' + JSON.stringify(out).replace(/,(?=["\-\d[])/g, ', ').replace(/":/g, '": ').replace(/^\{/, '{ ').replace(/\}$/, ' }');
  };
  return [
    '{',
    `  "version": ${obj.version ?? 1},`,
    `  "image": ${JSON.stringify(obj.image ?? { width: 2560, height: 1664 }).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\{/, '{ ').replace(/\}$/, ' }')},`,
    '  "zones": [',
    obj.zones.map(zoneLine).join(',\n'),
    '  ]',
    '}',
    '',
  ].join('\n');
}

export async function writeZonesFile(file, obj) {
  const err = validateZones(obj);
  if (err) throw new Error(err);
  await writeFile(file, formatZones(obj));
}
