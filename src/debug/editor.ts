// Éditeur de zones (?debug=1).
// - Glisser une zone pour la déplacer, les poignées pour la redimensionner.
// - « Polygone » convertit la zone sélectionnée ; clic sur un point milieu pour ajouter un sommet,
//   Alt + clic (ou double-clic) sur un sommet pour le supprimer.
// - Le point d'ancrage (cercle) se déplace aussi : il sert d'origine aux effets.
// - Flèches : déplacement fin (Maj : x10). Touches : H masque le panneau, Z masque les zones.
// - « Exporter » réécrit src/zones.json via le serveur ; à défaut, le JSON est téléchargé.

import './editor.css';
import { THEMES, zonesEndpointUrl, type ThemeName } from '../config';
import type { Renderer, ZoneRT } from '../renderer';
import type { TelemetryClient } from '../telemetry';
import { resolveTheme } from '../themes';
import type { NPoint, NRect, ZoneDef } from '../types';
import { bundledZones, clearZonesOverride, saveZonesOverride, zoneAnchor, zoneBounds } from '../zones';

const SVGNS = 'http://www.w3.org/2000/svg';
const COLORS = ['#ff6b6b', '#ffb454', '#ffe066', '#69db7c', '#4dd4ff', '#748ffc', '#da77f2', '#f783ac', '#ffffff', '#a9e34b', '#63e6be', '#ffa8a8', '#91a7ff', '#ffd8a8', '#e599f7'];
const r4 = (x: number) => Math.round(x * 10000) / 10000;
const clampN = (x: number) => Math.min(1, Math.max(0, x));

type Drag =
  | { kind: 'move'; id: string; u0: number; v0: number; orig: ZoneDef }
  | { kind: 'edge'; id: string; edges: string; orig: ZoneDef }
  | { kind: 'vertex'; id: string; index: number; orig: ZoneDef }
  | { kind: 'anchor'; id: string; orig: ZoneDef };

export function startEditor(r: Renderer, telemetry: TelemetryClient) {
  let selected: string | null = null;
  let drag: Drag | null = null;
  let demoTimer = 0;

  // ------------------------------------------------------------ calque SVG

  const svg = document.createElementNS(SVGNS, 'svg');
  svg.classList.add('dbg-svg');
  document.body.appendChild(svg);

  const color = (id: string) => COLORS[r.zones.findIndex((z) => z.def.id === id) % COLORS.length];
  const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element = svg) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    parent.appendChild(e);
    return e;
  };

  function drawSvg() {
    svg.replaceChildren();
    // Les zones les plus grandes d'abord, pour que les petites restent cliquables au-dessus.
    const ordered = [...r.zones].sort((a, b) => area(b.def) - area(a.def));
    for (const z of ordered) {
      const d = z.def, c = color(d.id), sel = d.id === selected;
      let shape: SVGElement;
      if (d.polygon && d.polygon.length >= 3) {
        shape = el('polygon', { points: d.polygon.map(([u, v]) => r.normToClient(u, v).join(',')).join(' ') });
      } else {
        const [x0, y0] = r.normToClient(d.rect[0], d.rect[2]), [x1, y1] = r.normToClient(d.rect[1], d.rect[3]);
        shape = el('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
      }
      shape.setAttribute('class', 'shape' + (sel ? ' sel' : ''));
      shape.setAttribute('stroke', c);
      shape.setAttribute('stroke-dasharray', sel ? '' : '5 3');
      shape.addEventListener('pointerdown', (e) => startDrag(e as PointerEvent, { kind: 'move', id: d.id, u0: 0, v0: 0, orig: d }));
      const [lx, ly] = r.normToClient(zoneBounds(d)[0], zoneBounds(d)[2]);
      const t = el('text', { x: lx + 4, y: ly + 13, fill: c });
      t.textContent = d.id;
    }
    if (selected) drawHandles(r.zone(selected)!);
  }

  function drawHandles(z: ZoneRT) {
    const d = z.def, c = color(d.id);
    if (d.polygon && d.polygon.length >= 3) {
      const p = d.polygon;
      p.forEach(([u, v], i) => {
        const [x, y] = r.normToClient(u, v);
        const h = el('circle', { cx: x, cy: y, r: 5, class: 'h', style: 'cursor:grab' });
        h.addEventListener('pointerdown', (e) => {
          const pe = e as PointerEvent;
          if (pe.altKey && p.length > 3) { removeVertex(d, i); pe.stopPropagation(); return; }
          startDrag(pe, { kind: 'vertex', id: d.id, index: i, orig: d });
        });
        h.addEventListener('dblclick', () => { if (p.length > 3) removeVertex(d, i); });
        // Point milieu : ajoute un sommet entre i et i+1.
        const [u2, v2] = p[(i + 1) % p.length];
        const [mx, my] = r.normToClient((u + u2) / 2, (v + v2) / 2);
        const m = el('circle', { cx: mx, cy: my, r: 3.5, class: 'h mid', style: 'cursor:copy' });
        m.addEventListener('pointerdown', (e) => {
          const poly = [...p.map((q) => [...q] as NPoint)];
          poly.splice(i + 1, 0, [(u + u2) / 2, (v + v2) / 2]);
          const nd = withPolygon(d, poly);
          commit(nd, false);
          startDrag(e as PointerEvent, { kind: 'vertex', id: d.id, index: i + 1, orig: nd });
        });
      });
    } else {
      const [x0, x1, y0, y1] = d.rect;
      const pts: Record<string, [number, number]> = {
        nw: [x0, y0], n: [(x0 + x1) / 2, y0], ne: [x1, y0], e: [x1, (y0 + y1) / 2],
        se: [x1, y1], s: [(x0 + x1) / 2, y1], sw: [x0, y1], w: [x0, (y0 + y1) / 2],
      };
      const cursors: Record<string, string> = { nw: 'nwse', se: 'nwse', ne: 'nesw', sw: 'nesw', n: 'ns', s: 'ns', e: 'ew', w: 'ew' };
      for (const [k, [u, v]] of Object.entries(pts)) {
        const [x, y] = r.normToClient(u, v);
        const h = el('rect', { x: x - 4.5, y: y - 4.5, width: 9, height: 9, class: 'h', style: `cursor:${cursors[k]}-resize` });
        h.addEventListener('pointerdown', (e) => startDrag(e as PointerEvent, { kind: 'edge', id: d.id, edges: k, orig: d }));
      }
    }
    const [au, av] = zoneAnchor(d);
    const [ax, ay] = r.normToClient(au, av);
    const a = el('circle', { cx: ax, cy: ay, r: 7, class: 'anchor', stroke: c });
    a.addEventListener('pointerdown', (e) => startDrag(e as PointerEvent, { kind: 'anchor', id: d.id, orig: d }));
  }

  const area = (d: ZoneDef) => { const b = zoneBounds(d); return (b[1] - b[0]) * (b[3] - b[2]); };

  function withPolygon(d: ZoneDef, poly: NPoint[]): ZoneDef {
    const nd: ZoneDef = { ...d, polygon: poly };
    nd.rect = zoneBounds(nd).map(r4) as NRect;
    return nd;
  }

  function removeVertex(d: ZoneDef, i: number) {
    const poly = d.polygon!.filter((_, k) => k !== i);
    commit(withPolygon(d, poly), true);
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
    (e.target as Element).setPointerCapture?.(e.pointerId);
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', endDrag, { once: true });
    drawSvg();
    renderPanel();
  }

  function onDragMove(e: PointerEvent) {
    if (!drag) return;
    const [u, v] = r.clientToNorm(e.clientX, e.clientY);
    const o = drag.orig;
    let nd: ZoneDef;
    if (drag.kind === 'move') {
      const du = u - drag.u0, dv = v - drag.v0;
      nd = translate(o, du, dv);
    } else if (drag.kind === 'edge') {
      let [x0, x1, y0, y1] = o.rect;
      const ed = drag.edges;
      if (ed.includes('w')) x0 = Math.min(u, x1 - 0.002);
      if (ed.includes('e')) x1 = Math.max(u, x0 + 0.002);
      if (ed.includes('n')) y0 = Math.min(v, y1 - 0.002);
      if (ed.includes('s')) y1 = Math.max(v, y0 + 0.002);
      nd = { ...o, rect: [x0, x1, y0, y1].map((x) => r4(clampN(x))) as NRect };
    } else if (drag.kind === 'vertex') {
      const poly = o.polygon!.map((p) => [...p] as NPoint);
      poly[drag.index] = [r4(clampN(u)), r4(clampN(v))];
      nd = withPolygon(o, poly);
    } else {
      nd = { ...o, anchor: [r4(clampN(u)), r4(clampN(v))] };
    }
    commit(nd, false);
  }

  function endDrag() {
    window.removeEventListener('pointermove', onDragMove);
    drag = null;
    r.flushRebuilds();
    persist();
  }

  function translate(o: ZoneDef, du: number, dv: number): ZoneDef {
    const b = zoneBounds(o);
    du = Math.min(1 - b[1], Math.max(-b[0], du));
    dv = Math.min(1 - b[3], Math.max(-b[2], dv));
    const mv = (p: NPoint): NPoint => [r4(p[0] + du), r4(p[1] + dv)];
    return {
      ...o,
      rect: [r4(o.rect[0] + du), r4(o.rect[1] + du), r4(o.rect[2] + dv), r4(o.rect[3] + dv)],
      polygon: o.polygon ? o.polygon.map(mv) : o.polygon,
      anchor: o.anchor ? mv(o.anchor) : undefined,
      core: o.core ? [r4(o.core[0] + du), r4(o.core[1] + du), r4(o.core[2] + dv), r4(o.core[3] + dv)] : undefined,
    };
  }

  function commit(d: ZoneDef, rebuildNow: boolean) {
    if (!d.polygon) delete d.polygon;
    if (!d.anchor) delete d.anchor;
    if (!d.core) delete d.core;
    r.updateZoneDef(d, rebuildNow);
    drawSvg();
    updateSelInfo();
    if (rebuildNow) persist();
  }

  function persist() {
    saveZonesOverride(r.zonesFile());
  }

  // ------------------------------------------------------------ panneau

  const panel = document.createElement('div');
  panel.className = 'dbg-panel';
  document.body.appendChild(panel);
  panel.addEventListener('pointerdown', (e) => e.stopPropagation());

  panel.innerHTML = `
    <h2>Éditeur de zones</h2>
    <div class="status"></div>
    <h3>Thème</h3>
    <div class="row">
      <select class="theme">${[...THEMES, 'auto'].map((t) => `<option value="${t}">${t}</option>`).join('')}</select>
      <button class="demo">Tester chaque zone</button>
    </div>
    <h3>Zone sélectionnée</h3>
    <div class="sel-info">Aucune (cliquez une zone)</div>
    <div class="row sel-tools" hidden>
      <button class="poly">Polygone</button>
      <label style="flex:1">Fondu <input type="range" class="feather" min="0" max="0.03" step="0.0005"></label>
    </div>
    <h3>Intensités (forcer)</h3>
    <div class="zones"></div>
    <div class="buttons" style="margin-top:6px">
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
    Polygone : point milieu pour ajouter, Alt + clic pour retirer un sommet.<br>H : panneau, Z : zones.</div>
  `;
  const $ = <T extends HTMLElement>(s: string) => panel.querySelector(s) as T;
  const themeSel = $<HTMLSelectElement>('.theme');
  themeSel.value = new URLSearchParams(location.search).get('theme') ?? r.theme.name;
  themeSel.addEventListener('change', () => r.setTheme(resolveTheme(themeSel.value as ThemeName | 'auto')));

  function renderPanel() {
    const list = $('.zones');
    list.replaceChildren();
    for (const z of r.zones) {
      const row = document.createElement('div');
      row.className = 'zone' + (z.def.id === selected ? ' sel' : '');
      row.innerHTML = `<span class="swatch" style="background:${color(z.def.id)}"></span>
        <span class="name" title="${z.def.label}">${z.def.id}</span>
        <input type="range" min="0" max="1" step="0.01" value="${z.forced ?? z.level}">
        <output>${z.forced != null ? z.forced.toFixed(2) : 'auto'}</output>`;
      const range = row.querySelector('input')!, out = row.querySelector('output')!;
      range.addEventListener('input', () => {
        z.forced = Number(range.value);
        out.textContent = z.forced.toFixed(2);
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
    const info = $('.sel-info'), tools = $('.sel-tools');
    const z = selected ? r.zone(selected) : null;
    if (!z) { info.textContent = 'Aucune (cliquez une zone)'; tools.hidden = true; return; }
    const d = z.def;
    info.textContent = `${d.label}\nrect ${d.rect.map((x) => x.toFixed(3)).join(' ')}${d.polygon ? `\npolygone ${d.polygon.length} sommets` : ''}`;
    info.style.whiteSpace = 'pre';
    tools.hidden = false;
    $('.poly').textContent = d.polygon ? 'Rectangle' : 'Polygone';
    $<HTMLInputElement>('.feather').value = String(d.feather);
  }

  $('.poly').addEventListener('click', () => {
    const z = selected ? r.zone(selected) : null;
    if (!z) return;
    const d = z.def;
    if (d.polygon) {
      const nd = { ...d, rect: zoneBounds(d).map(r4) as NRect, polygon: null };
      commit(nd, true);
    } else {
      const [x0, x1, y0, y1] = d.rect;
      commit(withPolygon(d, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]), true);
    }
  });
  $<HTMLInputElement>('.feather').addEventListener('input', (e) => {
    const z = selected ? r.zone(selected) : null;
    if (z) commit({ ...z.def, feather: r4(Number((e.target as HTMLInputElement).value)) }, false);
  });
  $<HTMLInputElement>('.feather').addEventListener('change', () => { r.flushRebuilds(); persist(); });

  const forceAll = (v: number | null) => { stopDemo(); for (const z of r.zones) z.forced = v; renderPanel(); r.wake(); };
  $('.all1').addEventListener('click', () => forceAll(1));
  $('.all0').addEventListener('click', () => forceAll(0));
  $('.free').addEventListener('click', () => forceAll(null));

  // Démo : chaque zone s'illumine seule à tour de rôle (critère « chaque zone indépendamment »).
  function stopDemo() { clearInterval(demoTimer); demoTimer = 0; $('.demo').textContent = 'Tester chaque zone'; }
  $('.demo').addEventListener('click', () => {
    if (demoTimer) { forceAll(null); return; }
    let i = 0;
    const step = () => {
      r.zones.forEach((z, k) => (z.forced = k === i % r.zones.length ? 1 : 0));
      selected = r.zones[i % r.zones.length].def.id;
      drawSvg(); renderPanel(); r.wake();
      i++;
    };
    step();
    demoTimer = window.setInterval(step, 1600);
    $('.demo').textContent = 'Arrêter la démo';
  });

  const json = () => JSON.stringify(r.zonesFile(), null, 2);
  $('.export').addEventListener('click', async () => {
    try {
      const res = await fetch(zonesEndpointUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json() });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      clearZonesOverride();
      toast('src/zones.json mis à jour');
    } catch (e) {
      download();
      toast(`Export serveur impossible (${(e as Error).message}) : fichier téléchargé`);
    }
  });
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json()], { type: 'application/json' }));
    a.download = 'zones.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('.download').addEventListener('click', download);
  $('.copy').addEventListener('click', () => navigator.clipboard?.writeText(json()).then(() => toast('JSON copié'), () => toast('Copie refusée')));
  $('.reset').addEventListener('click', () => {
    clearZonesOverride();
    r.setZones(bundledZones().zones);
    r.flushRebuilds();
    for (const z of r.zones) r.updateZoneDef(z.def, true);
    drawSvg(); renderPanel();
    toast('Zones du fichier restaurées');
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
    const px = r.stats.dirtyPx / (r.view.w * r.view.h);
    status.textContent =
      `télémétrie  ${telemetry.status}${s ? ` (${s.source}${s.simulated.length && s.source !== 'sim' ? ' : ' + s.simulated.join(',') + ' simulés' : ''})` : ''}\n` +
      `images/s    ${r.stats.fps}   rendu ${r.stats.renderMs.toFixed(2)} ms\n` +
      `surface     ${(px * 100).toFixed(1)} % redessinée\n` +
      `canevas     ${r.view.w} x ${r.view.h}  (x${r.view.cssRatio.toFixed(2)})\n` +
      `mouvement   ${r.motion ? 'normal' : 'réduit'}`;
    // Valeurs « auto » rafraîchies sans reconstruire la liste.
    panel.querySelectorAll<HTMLDivElement>('.zone').forEach((row, k) => {
      const z = r.zones[k];
      if (z && z.forced == null) (row.querySelector('input') as HTMLInputElement).value = String(z.level);
    });
  }, 500);

  // ------------------------------------------------------------ clavier et redimensionnement

  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
    if (e.key === 'h' || e.key === 'H') panel.classList.toggle('hidden');
    else if (e.key === 'z' || e.key === 'Z') svg.classList.toggle('hidden');
    else if (e.key === 'Escape') { selected = null; drawSvg(); renderPanel(); }
    else if (selected && e.key.startsWith('Arrow')) {
      const st = e.shiftKey ? 0.01 : 0.001;
      const du = e.key === 'ArrowLeft' ? -st : e.key === 'ArrowRight' ? st : 0;
      const dv = e.key === 'ArrowUp' ? -st : e.key === 'ArrowDown' ? st : 0;
      const z = r.zone(selected)!;
      commit(translate(z.def, du, dv), false);
      clearTimeout(nudgeTimer);
      nudgeTimer = window.setTimeout(() => { r.flushRebuilds(); persist(); }, 300);
      e.preventDefault();
    }
  });
  let nudgeTimer = 0;
  window.addEventListener('resize', () => setTimeout(drawSvg, 150));

  drawSvg();
  renderPanel();
}
