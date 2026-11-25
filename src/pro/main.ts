import './style.css';
import lumUrl from '../../assets/pro/lum.webp';
import { config } from './config';
import { loadProfile } from './profile';
import { Renderer } from './renderer';
import { SignalModel, type Derived } from './signals';
import { createSimulator } from './sim.mjs';
import { TelemetryClient } from './telemetry';
import { resolveTheme } from './themes';
import type { TelemetrySnapshot } from './types';

const canvas = document.getElementById('wallpaper') as HTMLCanvasElement;
const model = new SignalModel();

function fallback(e: unknown) {
  // Sans WebGL2 : image fixe éclaircie, sans animation.
  console.warn('Rendu WebGL2 impossible, image fixe :', (e as Error).message);
  canvas.remove();
  document.body.classList.add('no-webgl');
  document.body.style.backgroundImage = `url("${lumUrl}")`;
}

let renderer: Renderer;
try {
  renderer = new Renderer(canvas, loadProfile(), resolveTheme(config.theme));
} catch (e) {
  fallback(e);
  throw e;
}

// ------------------------------------------------------------ mouvement réduit

const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const motionOk = () => !(config.forceReducedMotion || reduceQuery.matches);
reduceQuery.addEventListener?.('change', () => renderer.setMotion(motionOk()));
renderer.motion = motionOk();

// ------------------------------------------------------------ télémétrie

let prevAc: boolean | null = null;
function apply(d: Derived) {
  // Branchement de l'adaptateur : impulsion sur les ports, onde partant du MagSafe.
  if (prevAc === false && d.battery.ac) {
    for (const id of ['magsafe', 'ports_left', 'ports_right']) {
      const z = renderer.zone(id);
      if (z) renderer.pulse(z, undefined, undefined, 1);
    }
    const m = renderer.zone('magsafe');
    if (m) renderer.ripple(m.def.rect[0], (m.def.rect[2] + m.def.rect[3]) / 2, 1);
  }
  prevAc = d.battery.ac;
  renderer.setSignals(d);
}
const onSnapshot = (s: TelemetrySnapshot) => apply(model.derive(s));
const telemetry = new TelemetryClient(config.telemetryUrl, onSnapshot);

// Jour / nuit (contrôleur, thème auto) : réévalué chaque minute.
setInterval(() => {
  if (config.theme === 'auto') renderer.setTheme(resolveTheme('auto'));
  if (!telemetry.last) apply(model.derive(null));
}, 60000);

// ------------------------------------------------------------ cycle de vie

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => renderer.resize(), 120);
});

document.addEventListener('visibilitychange', () => {
  renderer.setHidden(document.hidden);
  if (document.hidden) telemetry.stop(); else telemetry.start();
});

async function boot() {
  try {
    await renderer.init();
  } catch (e) {
    fallback(e);
    return;
  }
  apply(model.derive(null));
  if (config.still) {
    // Mode figé (captures) : signaux simulés appliqués instantanément, une seule image.
    const sim = createSimulator();
    apply(model.derive(sim.step(1)));
    if (config.forceLevel != null) for (const z of renderer.zones) z.forced = config.forceLevel;
    renderer.renderNow();
  } else if (!document.hidden) telemetry.start();
  renderer.setHidden(document.hidden);

  const w = window as unknown as { __pro: unknown };
  w.__pro = { renderer, telemetry, model };
  if (config.debug) {
    const { startEditor } = await import('./debug/editor');
    startEditor(renderer, telemetry);
  }
  document.documentElement.dataset.ready = '1';
}

boot().catch((e) => console.error('Démarrage impossible :', e));
