// Paramètres d'URL :
//   ?theme=rainbow|warm|sunset|mono|auto   thème des calques révélés (auto : warm le jour, rainbow la nuit)
//   ?debug=1                               éditeur de zones et curseurs de forçage
//   ?telemetry=<url>|sim|off               source des mesures (sim/off : simulation locale)
//   ?quality=0.5..1.5                      résolution du canevas par rapport à l'image source
//   ?fps=10..30                            cadence maximale au repos (24 par défaut, 30 si forte activité)
//   ?motion=reduce                         force le mode « mouvement réduit »

export const THEMES = ['rainbow', 'warm', 'sunset', 'mono'] as const;
export type ThemeName = (typeof THEMES)[number];

const p = new URLSearchParams(location.search);

function telemetryUrl(): string | null {
  const v = p.get('telemetry');
  if (v === 'off' || v === 'sim') return null;
  if (v) return v;
  // En fichier local (build monofichier), on vise le serveur de télémétrie par défaut.
  if (location.protocol === 'file:') return 'http://localhost:8787/telemetry';
  return new URL('telemetry', new URL('/', location.href)).href;
}

const themeParam = p.get('theme') ?? 'rainbow';

export const config = {
  debug: p.get('debug') === '1',
  theme: (THEMES as readonly string[]).includes(themeParam) || themeParam === 'auto' ? (themeParam as ThemeName | 'auto') : 'rainbow',
  telemetryUrl: telemetryUrl(),
  quality: Math.min(1.5, Math.max(0.4, Number(p.get('quality') ?? 1) || 1)),
  idleFps: Math.min(30, Math.max(10, Number(p.get('fps') ?? 24) || 24)),
  /** Plafond explicite de la cadence au repos (?fps=), sinon null. */
  idleFpsForced: p.has('fps') ? Math.min(30, Math.max(10, Number(p.get('fps')) || 24)) : null,
  forceReducedMotion: p.get('motion') === 'reduce',
};

export function zonesEndpointUrl(): string {
  if (location.protocol === 'file:') return 'http://localhost:8787/__zones';
  return new URL('__zones', new URL('/', location.href)).href;
}
