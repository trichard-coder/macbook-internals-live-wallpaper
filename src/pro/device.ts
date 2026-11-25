// Appareil affiché par le moteur WebGL : profil de zones, cartes d'image et réglages propres.
// Le moteur est commun aux versions MacBook Pro (pro.html) et MacBook Air (air.html) ;
// chaque page déclare son appareil avant de charger le moteur (src/pro/entry-*.ts).

import type { Profile } from './types';

export interface Device {
  id: 'pro' | 'air';
  name: string;
  profile: Profile;
  /** Cartes générées par scripts/prepare-pro-image.mjs (luminance, détails, contours). */
  maps: { lum: string; detail: string; edges: string };
  meta: { size: number[]; levels: { black: number; white: number } };
  /** Masques de forme calculés par scripts/build-masks.mjs (identifiants de zones par pixel). */
  mask?: { url: string; index: { size: number[]; zones: Record<string, { id: number; refine: string; geom: string }> } };
  /** Zones qui s'illuminent au branchement du secteur, et zone d'où part l'onde. */
  acZones: string[];
  acRipple?: string;
}

let current: Device | null = null;

/** Hauteur / largeur de l'image de l'appareil : convertit les y normalisés en « unités de largeur ». */
export let ASPECT = 0.65;

export function setDevice(d: Device) {
  current = d;
  ASPECT = d.profile.image.height / d.profile.image.width;
}

export function device(): Device {
  if (!current) throw new Error('appareil non défini (setDevice doit être appelé avant le moteur)');
  return current;
}

/** Préfixe des clés localStorage : les deux pages partagent la même origine (localhost:8788). */
export function storagePrefix(): string {
  return device().id === 'pro' ? 'mbp-wallpaper' : 'mba-gl-wallpaper';
}
