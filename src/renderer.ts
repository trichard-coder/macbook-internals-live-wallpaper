// Moteur de rendu Canvas 2D.
// - Le calque de base est pré-rendu une fois par redimensionnement (recadrage « cover »).
// - Chaque zone révèle des sprites colorés pré-masqués avec une opacité pilotée par son intensité.
// - Seuls les rectangles des zones dont l'apparence change sont redessinés (dirty rects).
// - La boucle s'arrête d'elle-même quand rien ne bouge, et la cadence s'adapte (60 / 30 / 24 i/s).

import { loadLayer, type LayerName } from './assets';
import { config } from './config';
import { derive, type Derived } from './signals';
import { makeCanvas, SpriteCache, type RGB, type Sprite, type SpriteVariant } from './sprites';
import type { Theme } from './themes';
import type { NRect, ZoneDef, ZonesFile } from './types';
import { zoneAnchor, zoneBounds } from './zones';
import { effectFor, type Effect } from './effects';
import { clamp01, q, smoothstep } from './util';

export interface PxRect { x: number; y: number; w: number; h: number }

export interface Ripple { u: number; v: number; age: number; strength: number }

export interface ZoneRT {
  def: ZoneDef;
  effect: Effect;
  level: number;
  target: number;
  impulse: number;
  forced: number | null;
  ripples: Ripple[];
  // État propre à l'effet de la zone (phases, particules, caches).
  fx: Record<string, any>;
  lastKey: string;
  paint: PxRect;
  dirty: boolean;
}

const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${clamp01(a).toFixed(3)})`;

function intersects(a: PxRect, b: PxRect) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
/**
 * Pas de fusion en boîte englobante : une nappe haute et fine plus une carte large
 * donneraient presque tout l'écran. Chaque rectangle est redessiné séparément (le recouvrement
 * éventuel est simplement peint deux fois, ce qui reste correct) ; on retire seulement les
 * rectangles entièrement contenus dans un autre.
 */
function pruneRects(rects: PxRect[]): PxRect[] {
  const contains = (a: PxRect, b: PxRect) => a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;
  return rects.filter((r, i) => !rects.some((o, j) => j !== i && contains(o, r) && (!contains(r, o) || j < i)));
}

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  zones: ZoneRT[] = [];
  theme: Theme;
  signals: Derived = derive(null);
  motion = true;
  frameId = 0;
  /** Coordonnées : largeur / hauteur du canevas, échelle et décalage de l'image (recadrage cover). */
  view = { w: 1, h: 1, scale: 1, ox: 0, oy: 0, cssRatio: 1 };
  IW = 2560;
  IH = 1664;
  stats = { fps: 0, renderMs: 0, dirtyPx: 0 };
  /** Jusqu'à quand tenir 60 i/s (impulsion au branchement du secteur, éditeur). */
  interactiveUntil = 0;

  private images = new Map<LayerName, HTMLImageElement>();
  private sprites = new SpriteCache((l) => this.images.get(l) ?? null);
  private baseCache: HTMLCanvasElement | null = null;
  private fullDirty = true;
  private lastFrame = 0;
  private scheduled = false;
  private hidden = false;
  private fpsWindow: number[] = [];
  private dotCache = new Map<string, HTMLCanvasElement>();
  private pendingRebuild = new Set<string>();

  constructor(readonly canvas: HTMLCanvasElement, zones: ZonesFile, theme: Theme) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.theme = theme;
    this.setZones(zones.zones);
  }

  // ------------------------------------------------------------ chargement et géométrie

  async init() {
    const base = await loadLayer(this.theme.base);
    this.images.set(this.theme.base, base);
    this.IW = base.naturalWidth;
    this.IH = base.naturalHeight;
    this.resize();
    this.loadThemeLayers();
  }

  private loadThemeLayers() {
    const t = this.theme;
    const needed: LayerName[] = [t.base, t.mid, t.high, t.low, 'warm'];
    for (const name of new Set(needed)) {
      if (this.images.has(name)) continue;
      loadLayer(name).then((img) => {
        this.images.set(name, img);
        if (name === this.theme.base) this.resize();
        this.invalidateAll();
      }).catch((e) => console.warn(e.message));
    }
  }

  async setTheme(theme: Theme) {
    if (theme.name === this.theme.name) return;
    this.theme = theme;
    if (!this.images.has(theme.base)) this.images.set(theme.base, await loadLayer(theme.base));
    this.sprites.clear();
    this.renderBase();
    this.loadThemeLayers();
    this.invalidateAll();
  }

  resize() {
    const cssW = window.innerWidth, cssH = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    // Résolution plafonnée à celle de l'image source : agrandir au-delà n'apporte aucun détail
    // et multiplierait le coût de remplissage (écran Retina ou 4K).
    const coverCss = Math.max(cssW / this.IW, cssH / this.IH);
    const k = Math.max(0.5, Math.min(dpr, config.quality / coverCss));
    const w = Math.round(cssW * k), h = Math.round(cssH * k);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const scale = Math.max(w / this.IW, h / this.IH);
    this.view = { w, h, scale, ox: (w - this.IW * scale) / 2, oy: (h - this.IH * scale) / 2, cssRatio: k };
    const res = Math.min(1, Math.round(scale * 20) / 20);
    if (Math.abs(res - this.sprites.res) > 0.04) { this.sprites.res = res; this.sprites.clear(); }
    this.renderBase();
    this.computePaintRects();
    this.invalidateAll();
  }

  private renderBase() {
    const base = this.images.get(this.theme.base);
    if (!base) return;
    const { w, h, scale, ox, oy } = this.view;
    if (!this.baseCache || this.baseCache.width !== w || this.baseCache.height !== h) this.baseCache = makeCanvas(w, h);
    const c = this.baseCache.getContext('2d', { alpha: false })!;
    c.fillStyle = '#0b0d12';
    c.fillRect(0, 0, w, h);
    c.imageSmoothingQuality = 'high';
    c.drawImage(base, ox, oy, this.IW * scale, this.IH * scale);
  }

  setZones(defs: ZoneDef[]) {
    const prev = new Map(this.zones.map((z) => [z.def.id, z]));
    this.zones = defs.map((def) => {
      const old = prev.get(def.id);
      if (old) { old.def = def; return old; }
      return {
        def, effect: effectFor(def.id), level: 0, target: 0, impulse: 0, forced: null,
        ripples: [], fx: {}, lastKey: '', paint: { x: 0, y: 0, w: 0, h: 0 }, dirty: true,
      };
    });
    this.computePaintRects();
    this.invalidateAll();
  }

  /** Mise à jour d'une zone depuis l'éditeur ; la reconstruction du sprite peut être différée. */
  updateZoneDef(def: ZoneDef, rebuildNow: boolean) {
    const z = this.zones.find((zz) => zz.def.id === def.id);
    if (!z) return;
    z.def = def;
    if (rebuildNow) { this.sprites.invalidateZone(def.id); this.pendingRebuild.delete(def.id); }
    else this.pendingRebuild.add(def.id);
    this.computePaintRects();
    this.invalidateAll();
  }

  flushRebuilds() {
    for (const id of this.pendingRebuild) this.sprites.invalidateZone(id);
    this.pendingRebuild.clear();
    this.invalidateAll();
  }

  zone(id: string) { return this.zones.find((z) => z.def.id === id); }

  computePaintRects() {
    for (const z of this.zones) {
      const nb = z.effect.bounds?.(z, this) ?? zoneBounds(z.def);
      const m = z.def.feather * 1.3 + 0.004; // marge : fondu + petites ondulations
      const mv = m * (this.IW / this.IH);
      const x0 = Math.floor(this.nx(nb[0] - m)), x1 = Math.ceil(this.nx(nb[1] + m));
      const y0 = Math.floor(this.ny(nb[2] - mv)), y1 = Math.ceil(this.ny(nb[3] + mv));
      const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0);
      z.paint = { x: cx0, y: cy0, w: Math.max(0, Math.min(this.view.w, x1) - cx0), h: Math.max(0, Math.min(this.view.h, y1) - cy0) };
    }
  }

  invalidateAll() { this.fullDirty = true; this.wake(); }

  // ------------------------------------------------------------ conversions

  nx(u: number) { return this.view.ox + u * this.IW * this.view.scale; }
  ny(v: number) { return this.view.oy + v * this.IH * this.view.scale; }
  /** Longueur exprimée en fraction de la largeur de l'image, en pixels du canevas. */
  nlen(du: number) { return du * this.IW * this.view.scale; }
  /** Rapport à appliquer à une distance horizontale normalisée pour l'exprimer verticalement. */
  get aspect() { return this.IW / this.IH; }

  /** Conversions vers / depuis les coordonnées CSS (utilisées par l'éditeur de zones). */
  clientToNorm(cx: number, cy: number): [number, number] {
    const k = this.view.cssRatio;
    return [(cx * k - this.view.ox) / (this.IW * this.view.scale), (cy * k - this.view.oy) / (this.IH * this.view.scale)];
  }
  normToClient(u: number, v: number): [number, number] {
    const k = this.view.cssRatio;
    return [this.nx(u) / k, this.ny(v) / k];
  }

  // ------------------------------------------------------------ primitives de dessin pour les effets

  sprite(z: ZoneRT, layer: LayerName, variantKey = '', variant?: SpriteVariant): Sprite | null {
    return this.sprites.get(z.def, layer, variantKey, variant);
  }

  drawSprite(s: Sprite | HTMLCanvasElement, alpha: number, op: GlobalCompositeOperation = 'source-over', b?: NRect) {
    if (alpha <= 0.003) return;
    const canvas = s instanceof HTMLCanvasElement ? s : s.canvas;
    const bb = b ?? (s as Sprite).b;
    const ctx = this.ctx;
    ctx.globalAlpha = clamp01(alpha);
    ctx.globalCompositeOperation = op;
    ctx.drawImage(canvas, this.nx(bb[0]), this.ny(bb[2]), this.nlen(bb[1] - bb[0]), this.ny(bb[3]) - this.ny(bb[2]));
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Révélation standard : calque moyen puis calque haut selon l'intensité. */
  /** boost : passe additive supplémentaire pour les composants très sombres dans tous les calques. */
  reveal(z: ZoneRT, v: number, boost = 0, mid: LayerName = this.theme.mid, high: LayerName = this.theme.high) {
    const aMid = smoothstep(0, 0.5, v), aHigh = smoothstep(0.42, 1, v);
    if (aMid > 0.003) { const s = this.sprite(z, mid); if (s) this.drawSprite(s, aMid); }
    if (aHigh > 0.003) {
      const s = this.sprite(z, high);
      if (s) {
        this.drawSprite(s, aHigh * this.theme.highAlpha, this.theme.highOp);
        if (boost > 0) this.drawSprite(s, aHigh * boost, 'lighter');
      }
    }
  }

  accent(z: ZoneRT): RGB {
    if (this.theme.mono) return [230, 232, 238];
    return this.sprite(z, this.theme.high)?.accent ?? [200, 210, 230];
  }

  /**
   * Dessine un sprite filtré par un dégradé (bande lumineuse, remplissage, diffusion).
   * Le résultat est mis en cache par zone et par nom tant que cacheKey ne change pas.
   */
  drawMasked(
    z: ZoneRT, name: string, s: Sprite, cacheKey: string,
    gradient: (ctx: CanvasRenderingContext2D, X: (u: number) => number, Y: (v: number) => number) => CanvasGradient,
    alpha: number, op: GlobalCompositeOperation = 'source-over',
  ) {
    if (alpha <= 0.003) return;
    const slot = `__${name}`;
    let entry = z.fx[slot] as { c: HTMLCanvasElement; key: string; src: Sprite } | undefined;
    if (!entry || entry.c.width !== s.canvas.width || entry.c.height !== s.canvas.height) {
      entry = { c: makeCanvas(s.canvas.width, s.canvas.height), key: '', src: s };
      z.fx[slot] = entry;
    }
    const key = cacheKey + '|' + s.canvas.width;
    if (entry.key !== key || entry.src !== s) {
      const c = entry.c.getContext('2d')!;
      const W = s.canvas.width, H = s.canvas.height;
      c.globalCompositeOperation = 'copy';
      c.drawImage(s.canvas, 0, 0);
      c.globalCompositeOperation = 'destination-in';
      const X = (u: number) => ((u - s.b[0]) / (s.b[1] - s.b[0])) * W;
      const Y = (v: number) => ((v - s.b[2]) / (s.b[3] - s.b[2])) * H;
      c.fillStyle = gradient(c, X, Y);
      c.fillRect(0, 0, W, H);
      c.globalCompositeOperation = 'source-over';
      entry.key = key;
      entry.src = s;
    }
    this.drawSprite(entry.c, alpha, op, s.b);
  }

  /** Halo radial additif. */
  glow(u: number, v: number, radiusU: number, c: RGB, alpha: number) {
    if (alpha <= 0.003 || radiusU <= 0) return;
    const ctx = this.ctx, x = this.nx(u), y = this.ny(v), r = this.nlen(radiusU);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(c, alpha));
    g.addColorStop(0.35, rgba(c, alpha * 0.5));
    g.addColorStop(1, rgba(c, 0));
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Anneau additif (ondulations). width en pixels CSS. */
  ring(u: number, v: number, radiusU: number, c: RGB, alpha: number, width = 1.5) {
    if (alpha <= 0.003 || radiusU <= 0) return;
    const ctx = this.ctx, k = this.view.cssRatio;
    ctx.globalCompositeOperation = 'lighter';
    ctx.beginPath();
    ctx.arc(this.nx(u), this.ny(v), this.nlen(radiusU), 0, Math.PI * 2);
    ctx.strokeStyle = rgba(c, alpha * 0.35);
    ctx.lineWidth = width * 3 * k;
    ctx.stroke();
    ctx.strokeStyle = rgba(c, alpha);
    ctx.lineWidth = width * k;
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Point lumineux (particule), éventuellement étiré verticalement. */
  dot(u: number, v: number, sizeU: number, c: RGB, alpha: number, stretch = 1) {
    if (alpha <= 0.003) return;
    const key = `${c[0]},${c[1]},${c[2]}`;
    let d = this.dotCache.get(key);
    if (!d) {
      d = makeCanvas(32, 32);
      const x = d.getContext('2d')!;
      const g = x.createRadialGradient(16, 16, 0, 16, 16, 16);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.25, rgba(c, 0.9));
      g.addColorStop(1, rgba(c, 0));
      x.fillStyle = g;
      x.fillRect(0, 0, 32, 32);
      if (this.dotCache.size > 64) this.dotCache.clear();
      this.dotCache.set(key, d);
    }
    const s = this.nlen(sizeU);
    const ctx = this.ctx;
    ctx.globalAlpha = clamp01(alpha);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(d, this.nx(u) - s / 2, this.ny(v) - (s * stretch) / 2, s, s * stretch);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ------------------------------------------------------------ impulsions et état

  /** Impulsion sur une zone (branchement du secteur, reprise d'activité) avec ondulation. */
  pulse(z: ZoneRT, u?: number, v?: number, strength = 1) {
    z.impulse = Math.max(z.impulse, strength);
    const [au, av] = u != null && v != null ? [u, v] : zoneAnchor(z.def);
    if (this.motion) z.ripples.push({ u: au, v: av, age: 0, strength });
    if (z.ripples.length > 6) z.ripples.shift();
    this.interactiveUntil = performance.now() + 1500;
    this.wake();
  }

  setSignals(d: Derived) { this.signals = d; this.wake(); }

  setHidden(h: boolean) {
    this.hidden = h;
    if (!h) { this.lastFrame = 0; this.invalidateAll(); }
  }

  setMotion(m: boolean) { this.motion = m; this.invalidateAll(); }

  // ------------------------------------------------------------ boucle

  private targetFps(): number {
    const now = performance.now();
    if (now < this.interactiveUntil) return 60;
    const animated = this.motion ? this.zones.filter((z) => z.effect.animating?.(z, this)) : [];
    // Simples fondus (télémétrie à 1 Hz, mouvement réduit) : 12 i/s suffisent.
    if (!animated.length) return 12;
    // Sinon la cadence la plus exigeante parmi les animations en cours, bornée par ?fps
    // (24 par défaut au repos, 30 quand une zone est très active).
    let fps = 12;
    for (const z of animated) fps = Math.max(fps, z.effect.fps?.(z, this) ?? config.idleFps);
    return Math.min(fps, Math.max(config.idleFps, 30), config.idleFpsForced ?? 60) | 0 || 12;
  }

  wake() {
    if (this.hidden || this.scheduled) return;
    this.scheduled = true;
    const fps = this.targetFps();
    const wait = this.lastFrame + 1000 / fps - performance.now() - 4;
    if (fps >= 55 || wait <= 1) requestAnimationFrame(this.tick);
    else setTimeout(() => requestAnimationFrame(this.tick), wait);
  }

  private tick = (now: number) => {
    this.scheduled = false;
    if (this.hidden) return;
    const minGap = 1000 / this.targetFps() - 2;
    if (this.lastFrame && now - this.lastFrame < minGap) {
      // Écran 120 Hz : on saute des images pour tenir la cadence visée.
      this.scheduled = true;
      requestAnimationFrame(this.tick);
      return;
    }
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 1 / 60;
    this.lastFrame = now;
    const busy = this.frame(now / 1000, dt);
    this.fpsWindow.push(now);
    while (this.fpsWindow.length && now - this.fpsWindow[0] > 1000) this.fpsWindow.shift();
    this.stats.fps = this.fpsWindow.length;
    if (busy) this.wake();
  };

  /** Met à jour l'état puis redessine ce qui a changé. Renvoie true si une image suivante est utile. */
  frame(t: number, dt: number): boolean {
    this.frameId++;
    let busy = false;
    const kImp = Math.exp(-dt / 0.45);
    for (const z of this.zones) {
      const target = z.forced ?? this.signals.targets[z.def.id] ?? 0;
      z.target = target;
      const tau = z.effect.tau ?? 0.6;
      const tauEff = this.motion ? tau : Math.max(tau, 1.2);
      z.level += (target - z.level) * (1 - Math.exp(-dt / tauEff));
      if (Math.abs(target - z.level) < 0.003) z.level = target; else busy = true;
      z.impulse = z.impulse > 0.004 ? z.impulse * kImp : 0;
      if (z.impulse > 0) busy = true;
      if (z.ripples.length) {
        for (const r of z.ripples) r.age += dt / 0.9;
        z.ripples = z.ripples.filter((r) => r.age < 1);
        busy = true;
      }
      z.effect.update?.(z, this, dt, t);
      if (z.effect.animating?.(z, this)) busy = true;
      const key = z.effect.key(z, this, t) + '|' + q(z.impulse) + '|' + z.ripples.map((r) => q(r.age)).join(',');
      z.dirty = key !== z.lastKey;
      z.lastKey = key;
    }
    this.render();
    return busy;
  }

  private render() {
    if (!this.baseCache) return;
    const t0 = performance.now();
    const full: PxRect = { x: 0, y: 0, w: this.view.w, h: this.view.h };
    let rects: PxRect[];
    if (this.fullDirty) rects = [full];
    else {
      rects = this.zones.filter((z) => z.dirty && z.paint.w > 0 && z.paint.h > 0).map((z) => z.paint);
      if (!rects.length) { this.stats.dirtyPx = 0; return; }
      rects = pruneRects(rects);
      const area = rects.reduce((s, r) => s + r.w * r.h, 0);
      if (area > full.w * full.h * 0.7) rects = [full];
    }
    this.fullDirty = false;
    const ctx = this.ctx;
    let px = 0;
    for (const R of rects) {
      px += R.w * R.h;
      ctx.save();
      ctx.beginPath();
      ctx.rect(R.x, R.y, R.w, R.h);
      ctx.clip();
      ctx.drawImage(this.baseCache, R.x, R.y, R.w, R.h, R.x, R.y, R.w, R.h);
      for (const z of this.zones) {
        if (!intersects(z.paint, R)) continue;
        ctx.save();
        ctx.beginPath();
        ctx.rect(z.paint.x, z.paint.y, z.paint.w, z.paint.h);
        ctx.clip();
        z.effect.draw(z, this, performance.now() / 1000);
        this.drawRipples(z);
        ctx.restore();
      }
      ctx.restore();
    }
    this.stats.dirtyPx = px;
    const ms = performance.now() - t0;
    this.stats.renderMs = this.stats.renderMs * 0.9 + ms * 0.1;
  }

  private drawRipples(z: ZoneRT) {
    if (!z.ripples.length) return;
    const c = this.accent(z);
    for (const r of z.ripples) {
      for (let i = 0; i < 3; i++) {
        const a = r.age - i * 0.13;
        if (a <= 0) continue;
        const e = 1 - Math.pow(1 - a, 3);
        this.ring(r.u, r.v, 0.004 + e * 0.045, c, Math.pow(1 - a, 1.6) * 0.55 * r.strength, 1.4 - i * 0.3);
      }
    }
  }

  /** Instantané des définitions de zones (pour l'export). */
  zonesFile(): ZonesFile {
    return { version: 1, image: { width: this.IW, height: this.IH }, zones: this.zones.map((z) => z.def) };
  }
}
