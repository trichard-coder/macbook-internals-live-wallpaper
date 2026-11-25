import './style.css';
import { config } from './config';
import { Renderer } from './renderer';
import { derive } from './signals';
import { TelemetryClient } from './telemetry';
import { resolveTheme } from './themes';
import type { TelemetrySnapshot } from './types';
import { loadZones } from './zones';

// Fond d'écran passif : il reflète l'activité du Mac en temps réel, sans aucune interaction souris.

const canvas = document.getElementById('wallpaper') as HTMLCanvasElement;
const renderer = new Renderer(canvas, loadZones(), resolveTheme(config.theme));

// ------------------------------------------------------------ mouvement réduit

const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const applyMotion = () => renderer.setMotion(!(config.forceReducedMotion || reduceQuery.matches));
reduceQuery.addEventListener?.('change', applyMotion);
renderer.motion = !(config.forceReducedMotion || reduceQuery.matches);

// ------------------------------------------------------------ télémétrie

let prevAc: boolean | null = null;
let prevIdle = 0;
function onSnapshot(s: TelemetrySnapshot) {
  const d = derive(s);
  // Branchement de l'adaptateur secteur : impulsion sur les ports et flux vers les batteries.
  if (prevAc === false && d.battery.ac) {
    const ports = renderer.zone('ports_right');
    if (ports) renderer.pulse(ports, undefined, undefined, 1);
    for (const id of ['battery_top', 'battery_bl', 'battery_br']) {
      const z = renderer.zone(id);
      if (z) z.fx.plug = 1;
    }
  }
  prevAc = d.battery.ac;
  // Reprise d'activité au clavier / trackpad après une pause : ondulation du Taptic Engine.
  if (prevIdle > 8 && d.idleSec < 1.5) {
    const tp = renderer.zone('trackpad_taptic');
    if (tp) renderer.pulse(tp, undefined, undefined, 0.6);
  }
  prevIdle = d.idleSec;
  renderer.setSignals(d);
}
const telemetry = new TelemetryClient(config.telemetryUrl, onSnapshot);

// Jour / nuit (connecteur d'écran, thème auto) : réévalué chaque minute.
setInterval(() => {
  if (config.theme === 'auto') renderer.setTheme(resolveTheme('auto'));
  if (telemetry.last) renderer.setSignals(derive(telemetry.last));
  else renderer.setSignals(derive(null));
}, 60000);

// ------------------------------------------------------------ cycle de vie

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => renderer.resize(), 120);
});

// Page masquée : plus de rendu ni de flux réseau.
document.addEventListener('visibilitychange', () => {
  const hidden = document.hidden;
  renderer.setHidden(hidden);
  if (hidden) telemetry.stop(); else telemetry.start();
});

async function boot() {
  await renderer.init();
  renderer.setSignals(derive(null));
  if (!document.hidden) telemetry.start();
  renderer.setHidden(document.hidden);

  if (config.debug) {
    (window as unknown as { __wallpaper: unknown }).__wallpaper = { renderer, telemetry };
    const { startEditor } = await import('./debug/editor');
    startEditor(renderer, telemetry);
  }
}

boot().catch((e) => console.error('Démarrage impossible :', e));
