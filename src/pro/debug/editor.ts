// Éditeur de zones (?debug=1), adapté de src/debug/editor.ts (version Air, copié et non modifié).
// - Glisser une zone pour la déplacer, les poignées carrées pour la redimensionner.
// - Cadres : poignées intérieures (rondes) pour le trou de la puce.
// - Cercles (ventilateurs) : centre déplaçable, poignées de rayon (ailettes, moyeu, carter).
// - Chemins : sommets déplaçables, point milieu pour ajouter, Alt + clic ou double-clic pour retirer.
// - « Polygone » convertit un rectangle ; mêmes gestes que pour les chemins.
// - Flèches : déplacement fin (Maj : x10). H : panneau, Z : zones, Échap : désélection.
// - « Exporter » réécrit profiles/pro.json via le serveur ; à défaut, le JSON est téléchargé.

import './editor.css';
import { profileEndpointUrl } from '../config';
import { ASPECT, bundledProfileCopy, clearProfileOverride, normalizeZone, saveProfileOverride } from '../profile';
import type { Renderer, ZoneRT } from '../renderer';
import type { TelemetryClient } from '../telemetry';
import { resolveTheme, THEMES, type ThemeName } from '../themes';
import type { NPoint, NRect, Profile, RenderSettings, ZoneDef } from '../types';

const SVGNS = 'http://www.w3.org/2000/svg';
const COLORS = ['#ff6b6b', '#ffb454', '#ffe066', '#69db7c', '#4dd4ff', '#748ffc', '#da77f2', '#f783ac', '#ffffff', '#a9e34b', '#63e6be', '#ffa8a8', '#91a7ff', '#ffd8a8', '#e599f7'];
const r4 = (x: number) => Math.round(x * 10000) / 10000;
const clampN = (x: number) => Math.min(1, Math.max(0, x));
const clone = <T,>(x: T): T => structuredClone(x);

type Drag =
  | { kind: 'move'; id: string; u0: number; v0: number; orig: ZoneDef }
  | { kind: 'edge'; id: string; edges: string; inner: boolean; orig: ZoneDef }
  | { kind: 'vertex'; id: string; index: number; list: 'path' | 'polygon'; orig: ZoneDef }
  | { kind: 'radius'; id: string; which: 'blades' | 'hub' | 'housing'; orig: ZoneDef };

const SLIDERS: [keyof RenderSettings, string, number, number, number][] = [
  ['gamma', 'Gamma', 0.4, 1.6, 0.01],
  ['exposure', 'Exposition', 0.2, 1.4, 0.01],
  ['ambient', 'Teinte ambiante', 0, 1, 0.01],
  ['ambientGlow', 'Lueur de fond', 0, 0.3, 0.005],
  ['bloom', 'Bloom', 0, 2, 0.01],
  ['detail', 'Détails', 0, 2, 0.01],
  ['edges', 'Contours', 0, 2, 0.01],
  ['grain', 'Grain', 0, 0.06, 0.001],
  ['vignette', 'Vignette', 0, 0.8, 0.01],
];

export function startEditor(r: Renderer, telemetry: TelemetryClient) {
  let selected: string | null = null;
  let drag: Drag | null = null;
  let demoTimer = 0;

  // ------------------------------------------------------------ calque SVG

  const svg = document.createElementNS(SVGNS, 'svg');
  svg.classList.add('dbg-svg');
  document.body.appendChild(svg);

  const color = (id: string) => COLORS[Math.max(0, r.zones.findIndex((z) => z.def.id === id)) % COLORS.length];
  const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element = svg) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    parent.appendChild(e);
    return e;
  };
  const P = (u: number, v: number) => r.normToClient(u, v);
  /** Rayon (unités de largeur) converti en pixels CSS horizontaux. */
  const rpx = (rad: number) => P(rad, 0)[0] - P(0, 0)[0];
  const area = (d: ZoneDef) => (d.rect[1] - d.rect[0]) * (d.rect[3] - d.rect[2]);

  function drawSvg() {
    svg.replaceChildren();
    const ordered = [...r.zones].sort((a, b) => area(b.def) - area(a.def));
    for (const z of ordered) {
      const d = z.def, c = color(d.id), sel = d.id === selected;
      let shape: SVGElement;
      if (d.kind === 'circle' && d.circle) {
        const [cx, cy] = P(d.circle.c[0], d.circle.c[1]);
        shape = el('circle', { cx, cy, r: rpx(d.circle.housing) * 0.62 });
        for (const k of ['blades', 'hub', 'housing'] as const) {
          el('circle', { cx, cy, r: rpx(d.circle[k]), class: 'guide', stroke: c });
        }
      } else if (d.kind === 'path' && d.path) {
        const pts = d.path.map(([u, v]) => P(u, v).join(',')).join(' ');
        el('polyline', { points: pts, class: 'guide wide', stroke: c, 'stroke-width': Math.max(2, rpx(d.width ?? 0.01) * 2) });
        shape = el('polyline', { points: pts, class: 'path' });
      } else if (d.polygon && d.polygon.length >= 3) {
        shape = el('polygon', { points: d.polygon.map(([u, v]) => P(u, v).join(',')).join(' ') });
      } else {
        const [x0, y0] = P(d.rect[0], d.rect[2]), [x1, y1] = P(d.rect[1], d.rect[3]);
        shape = el('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
        if (d.kind === 'frame' && d.inner) {
          const [a0, b0] = P(d.inner[0], d.inner[2]), [a1, b1] = P(d.inner[1], d.inner[3]);
          el('rect', { x: a0, y: b0, width: a1 - a0, height: b1 - b0, class: 'guide', stroke: c });
        }
      }
      shape.setAttribute('class', (shape.getAttribute('class') ?? '') + ' shape' + (sel ? ' sel' : ''));
      shape.setAttribute('stroke', c);
      shape.setAttribute('stroke-dasharray', sel ? '' : '5 3');
      shape.addEventListener('pointerdown', (e) => startDrag(e as PointerEvent, { kind: 'move', id: d.id, u0: 0, v0: 0, orig: clone(d) }));
      const [lx, ly] = P(d.rect[0], d.rect[2]);
      const t = el('text', { x: lx + 4, y: ly + 13, fill: c });
      t.textContent = d.id;
    }
    if (selected) { const z = r.zone(selected); if (z) drawHandles(z); }
  }

  function rectHandles(d: ZoneDef, rect: NRect, inner: boolean) {
    const [x0, x1, y0, y1] = rect;
    const pts: Record<string, [number, number]> = {
      nw: [x0, y0], n: [(x0 + x1) / 2, y0], ne: [x1, y0], e: [x1, (y0 + y1) / 2],
      se: [x1, y1], s: [(x0 + x1) / 2, y1], sw: [x0, y1], w: [x0, (y0 + y1) / 2],
    };
    const cursors: Record<string, string> = { nw: 'nwse', se: 'nwse', ne: 'nesw', sw: 'nesw', n: 'ns', s: 'ns', e: 'ew', w: 'ew' };
    for (const [k, [u, v]] of Object.entries(pts)) {
      const [x, y] = P(u, v);
      const h = inner
        ? el('circle', { cx: x, cy: y, r: 4, class: 'h inner', style: `cursor:${cursors[k]}-resize` })
        : el('rect', { x: x - 4.5, y: y - 4.5, width: 9, height: 9, class: 'h', style: `cursor:${cursors[k]}-resize` });
      h.addEventListener('pointerdown', (e) => startDrag(e as PointerEvent, { kind: 'edge', id: d.id, edges: k, inner, orig: clone(d) }));
    }
  }

  function vertexHandles(d: ZoneDef, list: 'path' | 'polygon') {
    const p = d[list]!;
    const closed = list === 'polygon';
    const min = closed ? 3 : 2;
    p.forEach(([u, v], i) => {
      const [x, y] = P(u, v);
      const h = el('circle', { cx: x, cy: y, r: 5, class: 'h', style: 'cursor:grab' });
      h.addEventListener('pointerdown', (e) => {
        const pe = e as PointerEvent;
        if (pe.altKey && p.length > min) { removeVertex(d, list, i); pe.stopPropagation(); return; }
        startDrag(pe, { kind: 'vertex', id: d.id, index: i, list, orig: clone(d) });
      });
      h.addEventListener('dblclick', () => { if (p.length > min) removeVertex(d, list, i); });
      if (!closed && i === p.length - 1) return;
      const [u2, v2] = p[(i + 1) % p.length];
      const [mx, my] = P((u + u2) / 2, (v + v2) / 2);
      const m = el('circle', { cx: mx, cy: my, r: 3.5, class: 'h mid', style: 'cursor:copy' });
      m.addEventListener('pointerdown', (e) => {
        const nd = clone(d);
        nd[list]!.splice(i + 1, 0, [r4((u + u2) / 2), r4((v + v2) / 2)]);
        commit(nd);
        startDrag(e as PointerEvent, { kind: 'vertex', id: d.id, index: i + 1, list, orig: clone(nd) });
      });
    });
  }

  function drawHandles(z: ZoneRT) {
    const d = z.def;
    if (d.kind === 'circle' && d.circle) {
      const [cx, cy] = P(d.circle.c[0], d.circle.c[1]);
      el('circle', { cx, cy, r: 5, class: 'h center' });
      for (const k of ['blades', 'hub', 'housing'] as const) {
        const h = el('circle', { cx: cx + rpx(d.circle[k]), cy, r: 4.5, class: 'h', style: 'cursor:ew-resize' });
        const t = el('text', { x: cx + rpx(d.circle[k]) + 6, y: cy - 6, fill: '#fff' });
        t.textContent = k;
        h.addEventListener('pointerdown', (e) => startDrag(e as PointerEvent, { kind: 'radius', id: d.id, which: k, orig: clone(d) }));
      }
    } else if (d.kind === 'path' && d.path) {
      vertexHandles(d, 'path');
    } else if (d.polygon && d.polygon.length >= 3) {
      vertexHandles(d, 'polygon');
    } else {
      rectHandles(d, d.rect, false);
      if (d.kind === 'frame' && d.inner) rectHandles(d, d.inner, true);
    }
  }

  function removeVertex(d: ZoneDef, list: 'path' | 'polygon', i: number) {
    const nd = clone(d);
    nd[list] = nd[list]!.filter((_, k) => k !== i);
    commit(nd, true);
  }

  // ------------------------------------------------------------ glisser-déposer

  function startDrag(e: PointerEvent, d: Drag) {
    e.stopPropagation();
    e.preventDefault();
    if (d.kind === 'move') {
      const [u, v] = r.clientToNorm(e.clientX, e.clientY);
      d.u0 = u; d.v0 = v;
    }
    selected = d.id;
    drag = d;
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', endDrag, { once: true });
    drawSvg();
    renderPanel();
  }

  function onDragMove(e: PointerEvent) {
    if (!drag) return;
    const [u, v] = r.clientToNorm(e.clientX, e.clientY);
    const nd = clone(drag.orig);
    if (drag.kind === 'move') {
      translate(nd, u - drag.u0, v - drag.v0);
    } else if (drag.kind === 'edge') {
      const src = drag.inner ? nd.inner! : nd.rect;
      let [x0, x1, y0, y1] = src;
      const ed = drag.edges;
      if (ed.includes('w')) x0 = Math.min(u, x1 - 0.002);
      if (ed.includes('e')) x1 = Math.max(u, x0 + 0.002);
      if (ed.includes('n')) y0 = Math.min(v, y1 - 0.002);
      if (ed.includes('s')) y1 = Math.max(v, y0 + 0.002);
      const out = [x0, x1, y0, y1].map((x) => r4(clampN(x))) as NRect;
      if (drag.inner) nd.inner = out; else nd.rect = out;
    } else if (drag.kind === 'vertex') {
      nd[drag.list]![drag.index] = [r4(clampN(u)), r4(clampN(v))];
    } else if (nd.circle) {
      const [cu, cv] = nd.circle.c;
      nd.circle[drag.which] = r4(Math.max(0.002, Math.hypot(u - cu, (v - cv) * ASPECT)));
    }
    commit(nd);
  }

  function endDrag() {
    window.removeEventListener('pointermove', onDragMove);
    drag = null;
    persist();
  }

  function translate(d: ZoneDef, du: number, dv: number) {
    const b = d.rect;
    du = Math.min(1 - b[1], Math.max(-b[0], du));
    dv = Math.min(1 - b[3], Math.max(-b[2], dv));
    const mv = (p: NPoint): NPoint => [r4(p[0] + du), r4(p[1] + dv)];
    const mr = (q: NRect): NRect => [r4(q[0] + du), r4(q[1] + du), r4(q[2] + dv), r4(q[3] + dv)];
    d.rect = mr(d.rect);
    if (d.inner) d.inner = mr(d.inner);
    if (d.polygon) d.polygon = d.polygon.map(mv);
    if (d.path) d.path = d.path.map(mv);
    if (d.circle) d.circle.c = mv(d.circle.c);
  }

  function commit(d: ZoneDef, save = false) {
    if (!d.polygon) delete d.polygon;
    r.updateZoneDef(normalizeZone(d));
    r.interactiveUntil = performance.now() + 1500;
    drawSvg();
    updateSelInfo();
    if (save) persist();
  }

  function exportProfile(): Profile {
    return { ...clone(r.profile), render: { ...r.settings }, zones: r.zones.map((z) => clone(z.def)) };
  }
  function persist() { saveProfileOverride(exportProfile()); }

  // ------------------------------------------------------------ panneau

  const panel = document.createElement('div');
  panel.className = 'dbg-panel';
  document.body.appendChild(panel);
  panel.addEventListener('pointerdown', (e) => e.stopPropagation());

  panel.innerHTML = `
    <h2>Éditeur de zones · MacBook Pro</h2>
    <div class="status"></div>
    <h3>Rendu</h3>
    <div class="row">
      <select class="theme">${[...THEMES, 'auto'].map((t) => `<option value="${t}">${t}</option>`).join('')}</select>
      <label class="narr">Puce haute <select class="die-top"><option value="cpu">CPU</option><option value="gpu">GPU</option></select></label>
    </div>
    <div class="sliders"></div>
    <h3>Ventilateurs</h3>
    <div class="slider"><span>Régime</span><input type="range" class="fan" min="0" max="1" step="0.01" value="0"><output class="fan-out">auto</output></div>
    <h3>Zone sélectionnée</h3>
    <div class="sel-info">Aucune (cliquez une zone)</div>
    <div class="row sel-tools" hidden>
      <button class="poly">Polygone</button>
      <label class="grow">Fondu <input type="range" class="feather" min="0" max="0.03" step="0.0005"></label>
    </div>
    <div class="row path-tools" hidden>
      <label class="grow">Largeur <input type="range" class="pwidth" min="0.002" max="0.05" step="0.0005"></label>
      <label class="grow">Origine <input type="range" class="porigin" min="0" max="1" step="0.01"></label>
    </div>
    <h3>Intensités (forcer)</h3>
    <div class="zones"></div>
    <div class="buttons" style="margin-top:6px">
      <button class="demo">Tester chaque zone</button>
      <button class="all1">Tout à 1</button>
      <button class="all0">Tout à 0</button>
      <button class="free">Libérer</button>
    </div>
    <h3>Fichier</h3>
    <div class="buttons">
      <button class="export">Exporter</button>
      <button class="download">Télécharger</button>
      <button class="copy">Copier JSON</button>
      <button class="reset">Réinitialiser</button>
    </div>
    <div class="hint">Glisser : déplacer. Poignées : redimensionner. Flèches : ajuster (Maj x10).<br>
    Chemins et polygones : point milieu pour ajouter, Alt + clic pour retirer un sommet.<br>H : panneau, Z : zones, Échap : désélection.</div>
  `;
  const $ = <T extends HTMLElement>(s: string) => panel.querySelector(s) as T;

  const themeSel = $<HTMLSelectElement>('.theme');
  themeSel.value = new URLSearchParams(location.search).get('theme') ?? r.theme.name;
  themeSel.addEventListener('change', () => r.setTheme(resolveTheme(themeSel.value as ThemeName | 'auto')));

  const dieTop = $<HTMLSelectElement>('.die-top');
  dieTop.value = r.profile.narrative.die_top;
  dieTop.addEventListener('change', () => {
    const top = dieTop.value as 'cpu' | 'gpu';
    r.profile.narrative = { die_top: top, die_bottom: top === 'cpu' ? 'gpu' : 'cpu' };
    persist();
    r.wake();
    toast(`Puce haute : ${top.toUpperCase()}, puce basse : ${r.profile.narrative.die_bottom.toUpperCase()}`);
  });

  const sliders = $('.sliders');
  for (const [key, label, min, max, step] of SLIDERS) {
    const row = document.createElement('div');
    row.className = 'slider';
    row.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${r.settings[key]}"><output>${r.settings[key].toFixed(3)}</output>`;
    const input = row.querySelector('input')!, out = row.querySelector('output')!;
    input.addEventListener('input', () => {
      r.settings[key] = Number(input.value);
      out.textContent = r.settings[key].toFixed(3);
      r.wake();
    });
    input.addEventListener('change', persist);
    sliders.appendChild(row);
  }

  const fan = $<HTMLInputElement>('.fan'), fanOut = $('.fan-out');
  fan.addEventListener('input', () => { r.fanForce = Number(fan.value); fanOut.textContent = r.fanForce.toFixed(2); r.wake(); });
  fanOut.style.cursor = 'pointer';
  fanOut.title = 'Clic : revenir à la télémétrie';
  fanOut.addEventListener('click', () => { r.fanForce = null; fanOut.textContent = 'auto'; });

  function renderPanel() {
    const list = $('.zones');
    list.replaceChildren();
    for (const z of r.zones) {
      const row = document.createElement('div');
      row.className = 'zone' + (z.def.id === selected ? ' sel' : '');
      row.innerHTML = `<span class="swatch" style="background:${color(z.def.id)}"></span>
        <span class="name" title="${z.def.label} (signal ${r.signalOf(z.def)})">${z.def.id}</span>
        <input type="range" min="0" max="1" step="0.01" value="${z.forced ?? z.level}">
        <output>${z.forced != null ? z.forced.toFixed(2) : 'auto'}</output>`;
      const range = row.querySelector('input')!, out = row.querySelector('output')!;
      range.addEventListener('input', () => {
        z.forced = Number(range.value);
        out.textContent = z.forced.toFixed(2);
        r.interactiveUntil = performance.now() + 1500;
        r.wake();
      });
      out.style.cursor = 'pointer';
      out.title = 'Clic : revenir à la télémétrie';
      out.addEventListener('click', () => { z.forced = null; out.textContent = 'auto'; r.wake(); });
      row.querySelector('.name')!.addEventListener('click', () => { selected = z.def.id; drawSvg(); renderPanel(); });
      list.appendChild(row);
    }
    updateSelInfo();
  }

  function updateSelInfo() {
    const info = $('.sel-info'), tools = $('.sel-tools'), ptools = $('.path-tools');
    const z = selected ? r.zone(selected) : null;
    if (!z) { info.textContent = 'Aucune (cliquez une zone)'; tools.hidden = true; ptools.hidden = true; return; }
    const d = z.def;
    const extra = d.kind === 'circle' && d.circle
      ? `\ncentre ${d.circle.c.map((x) => x.toFixed(3)).join(' ')}  ailettes ${d.circle.blades.toFixed(3)}  moyeu ${d.circle.hub.toFixed(3)}  carter ${d.circle.housing.toFixed(3)}`
      : d.kind === 'path' && d.path ? `\nchemin ${d.path.length} points` : d.polygon ? `\npolygone ${d.polygon.length} sommets` : '';
    info.textContent = `${d.label}\nsignal ${r.signalOf(d)} · effet ${d.effect} · niveau ${z.level.toFixed(2)}\n${r.signals?.labels[r.signalOf(d)] ?? ''}\nrect ${d.rect.map((x) => x.toFixed(3)).join(' ')}${extra}`;
    tools.hidden = false;
    $('.poly').hidden = d.kind !== 'rect';
    $('.poly').textContent = d.polygon ? 'Rectangle' : 'Polygone';
    $<HTMLInputElement>('.feather').value = String(d.feather);
    ptools.hidden = d.kind !== 'path';
    if (d.kind === 'path') {
      $<HTMLInputElement>('.pwidth').value = String(d.width ?? 0.01);
      $<HTMLInputElement>('.porigin').value = String(d.origin ?? 0);
    }
  }

  const editSel = (fn: (d: ZoneDef) => void, save = false) => {
    const z = selected ? r.zone(selected) : null;
    if (!z) return;
    const nd = clone(z.def);
    fn(nd);
    commit(nd, save);
  };
  $('.poly').addEventListener('click', () => editSel((d) => {
    if (d.polygon) { d.polygon = null; }
    else { const [x0, x1, y0, y1] = d.rect; d.polygon = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; }
  }, true));
  $<HTMLInputElement>('.feather').addEventListener('input', (e) => editSel((d) => { d.feather = r4(Number((e.target as HTMLInputElement).value)); }));
  $<HTMLInputElement>('.pwidth').addEventListener('input', (e) => editSel((d) => { d.width = r4(Number((e.target as HTMLInputElement).value)); }));
  $<HTMLInputElement>('.porigin').addEventListener('input', (e) => editSel((d) => { d.origin = r4(Number((e.target as HTMLInputElement).value)); }));
  for (const s of ['.feather', '.pwidth', '.porigin']) $<HTMLInputElement>(s).addEventListener('change', persist);

  const forceAll = (v: number | null) => { stopDemo(); for (const z of r.zones) z.forced = v; renderPanel(); r.wake(); };
  $('.all1').addEventListener('click', () => forceAll(1));
  $('.all0').addEventListener('click', () => forceAll(0));
  $('.free').addEventListener('click', () => forceAll(null));

  // Démo : chaque zone s'illumine seule à tour de rôle (critère « pilotable indépendamment »).
  function stopDemo() { clearInterval(demoTimer); demoTimer = 0; $('.demo').textContent = 'Tester chaque zone'; }
  $('.demo').addEventListener('click', () => {
    if (demoTimer) { forceAll(null); return; }
    let i = 0;
    const step = () => {
      r.zones.forEach((z, k) => (z.forced = k === i % r.zones.length ? 1 : 0));
      selected = r.zones[i % r.zones.length].def.id;
      r.interactiveUntil = performance.now() + 1700;
      drawSvg(); renderPanel(); r.wake();
      i++;
    };
    step();
    demoTimer = window.setInterval(step, 1600);
    $('.demo').textContent = 'Arrêter la démo';
  });

  const json = () => JSON.stringify(exportProfile(), null, 2);
  $('.export').addEventListener('click', async () => {
    try {
      const res = await fetch(profileEndpointUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json() });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      clearProfileOverride();
      toast('profiles/pro.json mis à jour');
    } catch (e) {
      download();
      toast(`Export serveur impossible (${(e as Error).message}) : fichier téléchargé`);
    }
  });
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json()], { type: 'application/json' }));
    a.download = 'pro.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('.download').addEventListener('click', download);
  $('.copy').addEventListener('click', () => navigator.clipboard?.writeText(json()).then(() => toast('JSON copié'), () => toast('Copie refusée')));
  $('.reset').addEventListener('click', () => {
    clearProfileOverride();
    const p = bundledProfileCopy();
    r.profile.narrative = p.narrative;
    Object.assign(r.settings, p.render);
    r.setZones(p.zones);
    drawSvg(); renderPanel();
    toast('Profil du fichier restauré (rechargez pour les curseurs de rendu)');
  });

  function toast(msg: string) {
    const t = document.createElement('div');
    t.className = 'dbg-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  // Statut : source des mesures, cadence et coût de rendu.
  const status = $('.status');
  setInterval(() => {
    const s = telemetry.last;
    status.textContent =
      `télémétrie  ${telemetry.status}${s ? ` (${s.source}${s.simulated.length && s.source !== 'sim' ? ' : ' + s.simulated.join(',') + ' simulés' : ''})` : ''}\n` +
      `ventilos    ${s?.fan ? `${s.fan.source}${s.fan.rpm != null ? ' ' + Math.round(s.fan.rpm) + ' tr/min' : ''}` : '?'}  régime ${r.fans[0].level.toFixed(2)}\n` +
      `images/s    ${r.stats.fps}   JS ${r.stats.frameMs.toFixed(2)} ms\n` +
      `canevas     ${r.stats.w} x ${r.stats.h}\n` +
      `mouvement   ${r.motion ? 'normal' : 'réduit'}`;
    panel.querySelectorAll<HTMLDivElement>('.zone').forEach((row, k) => {
      const z = r.zones[k];
      if (z && z.forced == null) (row.querySelector('input') as HTMLInputElement).value = String(z.level);
    });
  }, 500);

  // ------------------------------------------------------------ clavier et redimensionnement

  let nudgeTimer = 0;
  window.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT') return;
    if (e.key === 'h' || e.key === 'H') panel.classList.toggle('hidden');
    else if (e.key === 'z' || e.key === 'Z') svg.classList.toggle('hidden');
    else if (e.key === 'Escape') { selected = null; drawSvg(); renderPanel(); }
    else if (selected && e.key.startsWith('Arrow')) {
      const st = e.shiftKey ? 0.01 : 0.001;
      const du = e.key === 'ArrowLeft' ? -st : e.key === 'ArrowRight' ? st : 0;
      const dv = e.key === 'ArrowUp' ? -st : e.key === 'ArrowDown' ? st : 0;
      editSel((d) => translate(d, du, dv));
      clearTimeout(nudgeTimer);
      nudgeTimer = window.setTimeout(persist, 300);
      e.preventDefault();
    }
  });
  window.addEventListener('resize', () => setTimeout(drawSvg, 200));

  drawSvg();
  renderPanel();
}
