// Paramètres d'URL de pro.html :
//   ?theme=rainbow|warm|sunset|mono|auto   palette (auto : warm le jour, rainbow la nuit)
//   ?debug=1                               éditeur de zones et curseurs de forçage
//   ?telemetry=<url>|sim|off               source des mesures (sim/off : simulation locale)
//   ?quality=0.4..1                        résolution du canevas par rapport à l'image source
//   ?fps=10..60                            cadence au repos (60 par défaut, synchronisée sur l'écran)
//   ?motion=reduce                         force le mode « mouvement réduit »
//   ?gamma=0.5..1.5                        surcharge le gamma du profil
//   ?static=1                              rendu figé (captures) : une seule image, pas d'animation
//   ?level=0..1                            avec static=1 : force toutes les zones à ce niveau

import { device } from './device';
import { THEMES, type ThemeName } from './themes';

const p = new URLSearchParams(location.search);

/** Port par défaut du serveur de télémétrie Pro. */
export const TELEMETRY_PORT = 8788;

function telemetryUrl(): string | null {
  const v = p.get('telemetry');
  if (v === 'off' || v === 'sim') return null;
  if (v) return v;
  // Build monofichier ouvert en file:// : on vise le serveur de télémétrie Pro.
  if (location.protocol === 'file:') return `http://localhost:${TELEMETRY_PORT}/telemetry`;
  return new URL('telemetry', new URL('/', location.href)).href;
}

const themeParam = p.get('theme') ?? 'rainbow';
const num = (k: string) => (p.get(k) != null && Number.isFinite(Number(p.get(k))) ? Number(p.get(k)) : null);

export const config = {
  debug: p.get('debug') === '1',
  theme: ((THEMES as readonly string[]).includes(themeParam) || themeParam === 'auto' ? themeParam : 'rainbow') as ThemeName | 'auto',
  telemetryUrl: telemetryUrl(),
  quality: Math.min(1, Math.max(0.4, num('quality') ?? 1)),
  idleFps: Math.min(60, Math.max(10, num('fps') ?? 60)),
  forceReducedMotion: p.get('motion') === 'reduce',
  gamma: num('gamma'),
  still: p.get('static') === '1',
  forceLevel: num('level'),
};

export function serverBase(): string {
  if (config.telemetryUrl) return new URL('/', config.telemetryUrl).href;
  return `http://localhost:${TELEMETRY_PORT}/`;
}

export function profileEndpointUrl(): string {
  const name = `__profile-${device().id}`;
  if (location.protocol === 'file:') return `http://localhost:${TELEMETRY_PORT}/${name}`;
  return new URL(name, new URL('/', location.href)).href;
}
