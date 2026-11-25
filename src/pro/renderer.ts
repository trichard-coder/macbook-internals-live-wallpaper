// Moteur de rendu WebGL2 de la version Pro.
// - Les cartes (luminance, détails, contours) sont assemblées une fois dans une texture RGBA
//   mipmappée ; tout le reste est calculé par pixel à chaque image.
// - Cadence adaptative : 60 i/s pendant une interaction, 24 à 30 i/s au repos, quelques images
//   par seconde en mouvement réduit, arrêt complet quand la page est masquée.

import { config } from './config';
import { device } from './device';
import { dropTarget, loadImage, program, target, texture, type Program, type Target } from './gl';
import { ASPECT, normalizeZone, zoneArea, zoneContains } from './profile';
import { EFFECT_ID, FS_BLUR, FS_BRIGHT, FS_COMP, FS_FIELD, FS_PACK, KIND_ID, MAXPOLY, MAXRIPPLE, MAXSEG, MAXZ, VS } from './shaders';
import type { Derived } from './signals';
import { rampPixels, RAMP_ROWS, type Theme } from './themes';
import type { NPoint, Profile, RenderSettings, SignalName, ZoneDef } from './types';

export interface ZoneRT {
  def: ZoneDef;
  level: number;
  target: number;
  forced: number | null;
  hover: number;
  hoverTarget: number;
  impulse: number;
  /** Vitesse du niveau (amortissement critique : départ et arrivée en douceur). */
  vel: number;
  phase: number;
  aux: number;
  flagA: number;
  flagB: number;
}

interface Ripple { x: number; y: number; age: number; strength: number }

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Amortissement critique (ressort sans rebond) : contrairement au lissage exponentiel, la valeur
 * accélère puis ralentit, sans démarrage sec. smooth : temps caractéristique en secondes.
 */
function smoothDamp(cur: number, target: number, vel: number, smooth: number, dt: number): [number, number] {
  const omega = 2 / Math.max(1e-3, smooth), x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target, temp = (vel + omega * change) * dt;
  let out = target + (change + temp) * exp;
  let v = (vel - omega * temp) * exp;
  if ((target - cur > 0) === (out > target)) { out = target; v = 0; } // pas de dépassement
  return [out, v];
}

/** Vitesse de phase de chaque effet (unités par seconde) en fonction du niveau. */
function phaseSpeed(effect: ZoneDef['effect'], L: number, z: ZoneRT): number {
  switch (effect) {
    case 'chip': return 1.2 + 4 * L;
    case 'frame': return 0.5 + 2.5 * L;
    case 'vent': return 0.5 + 2.8 * L;
    case 'heatpipe': return 0.12 + 1.3 * L;
    case 'plate': return 0.5 + 3 * L;
    case 'power': return 0.1 + 0.9 * L;
    case 'nand': return 3 + 22 * L;
    case 'battery': return z.flagA ? 3 : 0;
    case 'flex': return 0.06 + 0.8 * L;
    case 'speaker': return L > 0 ? 4 + 10 * L : 0;
    case 'control': return 0.8;
    case 'network': return 2 + 14 * L;
    default: return 0;
  }
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  profile: Profile;
  settings: RenderSettings;
  zones: ZoneRT[] = [];
  theme: Theme;
  signals: Derived | null = null;
  motion = true;
  /** Forçage du régime des ventilateurs (éditeur). */
  fanForce: number | null = null;
  fans = [{ angle: 0, level: 0.1 }, { angle: 1.7, level: 0.1 }];
  interactiveUntil = 0;
  stats = { fps: 0, frameMs: 0, w: 0, h: 0 };
  view = { cssW: 1, cssH: 1, cover: [1, 1, 0, 0] as [number, number, number, number] };

  private progs!: { pack: Program; field: Program; bright: Program; blur: Program; comp: Program };
  private maps: WebGLTexture | null = null;
  private ramp: WebGLTexture | null = null;
  private field: Target | null = null;
  private bloomA: Target | null = null;
  private bloomB: Target | null = null;
  private floatOk = false;
  private ripples: Ripple[] = [];
  private hidden = false;
  private timer = 0;
  private raf = 0;
  private lastFrame = 0;
  private fpsCount = 0;
  private fpsT = 0;
  private time = 0;
  private ready = false;
  private geo = {
    rect: new Float32Array(MAXZ * 4), param: new Float32Array(MAXZ * 4), geom: new Float32Array(MAXZ * 4),
    state: new Float32Array(MAXZ * 4), anim: new Float32Array(MAXZ * 4), mask: new Float32Array(MAXZ),
    seg: new Float32Array(MAXSEG * 4), segInfo: new Float32Array(MAXSEG * 4), poly: new Float32Array(MAXPOLY * 2),
    ripple: new Float32Array(MAXRIPPLE * 4),
  };
  private zoneCount = 0;
  /** Uniformes statiques (formes, chemins) à renvoyer au GPU. */
  private geoDirty = true;
  private frameNo = 0;
  private levels: [number, number] = [device().meta.levels.black / 255, device().meta.levels.white / 255];
  private mapSize: [number, number] = [device().meta.size[0], device().meta.size[1]];
  private maskTex: WebGLTexture | null = null;
  private maskTexel: [number, number] = [0, 0];
  /** Nombre de cellules de batterie (remplies l'une après l'autre). */
  private batteryCells = 1;

  constructor(readonly canvas: HTMLCanvasElement, profile: Profile, theme: Theme) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'low-power', preserveDrawingBuffer: config.still });
    if (!gl) throw new Error('WebGL2 indisponible');
    this.gl = gl;
    this.profile = profile;
    this.settings = { ...profile.render };
    if (config.gamma != null) this.settings.gamma = config.gamma;
    this.theme = theme;
    this.setZones(profile.zones);
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.ready = false; this.stop(); });
    canvas.addEventListener('webglcontextrestored', () => { this.init().catch((err) => console.error(err)); });
  }

  // ------------------------------------------------------------ initialisation

  async init() {
    const gl = this.gl;
    this.floatOk = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    this.progs = {
      pack: program(gl, VS, FS_PACK),
      field: program(gl, VS, FS_FIELD),
      bright: program(gl, VS, FS_BRIGHT),
      blur: program(gl, VS, FS_BLUR),
      comp: program(gl, VS, FS_COMP),
    };
    gl.bindVertexArray(gl.createVertexArray());
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    const { maps } = device();
    const [lum, det, edg] = await Promise.all([loadImage(maps.lum), loadImage(maps.detail), loadImage(maps.edges)]);
    this.mapSize = [lum.naturalWidth, lum.naturalHeight];
    this.buildMaps([lum, det, edg]);
    const mk = device().mask;
    if (mk) {
      try {
        const img = await loadImage(mk.url);
        // Identifiants, pas des couleurs : filtrage au plus proche, aucune conversion.
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        const t = texture(gl, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
        this.maskTex = t;
        this.maskTexel = [1 / img.naturalWidth, 1 / img.naturalHeight];
      } catch (e) { console.warn('Masques de forme indisponibles :', (e as Error).message); }
      this.buildGeometry(); // les identifiants de masque dépendent de la texture chargée
    }
    this.uploadRamp();
    this.geoDirty = true;
    this.ready = true;
    this.resize();
  }

  /** Assemble luminance, détails et contours dans une seule texture RGBA mipmappée. */
  private buildMaps(imgs: HTMLImageElement[]) {
    const gl = this.gl;
    const [w, h] = this.mapSize;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    const src = imgs.map((img) => {
      const t = texture(gl, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, img);
      return t;
    });
    const tgt = target(gl, w, h, false, true);
    const p = this.progs.pack;
    gl.useProgram(p.prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, tgt.fb);
    gl.viewport(0, 0, w, h);
    gl.uniform4f(p.u.uCover, 1, 1, 0, 0);
    ['uLum', 'uDetail', 'uEdges'].forEach((name, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, src[i]);
      gl.uniform1i(p.u[name], i);
    });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, tgt.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.deleteFramebuffer(tgt.fb);
    src.forEach((t) => gl.deleteTexture(t));
    if (this.maps) gl.deleteTexture(this.maps);
    this.maps = tgt.tex;
  }

  private uploadRamp() {
    const gl = this.gl;
    if (!this.ramp) this.ramp = texture(gl, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, this.ramp);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, RAMP_ROWS, 0, gl.RGBA, gl.UNSIGNED_BYTE, rampPixels(this.theme));
  }

  setTheme(theme: Theme) {
    this.theme = theme;
    if (this.ready) this.uploadRamp();
    this.wake();
  }

  // ------------------------------------------------------------ géométrie et zones

  setZones(defs: ZoneDef[]) {
    const prev = new Map(this.zones.map((z) => [z.def.id, z]));
    this.zones = defs.slice(0, MAXZ).map((d) => {
      const def = normalizeZone(structuredClone(d));
      const o = prev.get(d.id);
      return o ? { ...o, def } : { def, level: 0, target: 0, forced: null, hover: 0, hoverTarget: 0, impulse: 0, vel: 0, phase: Math.random() * 10, aux: 0, flagA: 0, flagB: 0 };
    });
    this.profile.zones = this.zones.map((z) => z.def);
    this.buildGeometry();
  }

  updateZoneDef(def: ZoneDef) {
    const z = this.zone(def.id);
    if (!z) return;
    z.def = normalizeZone(def);
    this.profile.zones = this.zones.map((zz) => zz.def);
    this.buildGeometry();
    this.wake();
  }

  zone(id: string) { return this.zones.find((z) => z.def.id === id); }

  signalOf(def: ZoneDef): SignalName {
    const n = (this.profile.narrative as Record<string, SignalName | undefined>)[def.id];
    return n ?? def.signal;
  }

  /** Remplit les tableaux d'uniformes statiques (formes, chemins, polygones). */
  private buildGeometry() {
    const g = this.geo;
    g.rect.fill(0); g.param.fill(0); g.geom.fill(0); g.seg.fill(0); g.segInfo.fill(0); g.poly.fill(0); g.mask.fill(0);
    // Masque de forme : utilisé seulement si la géométrie de la zone n'a pas changé depuis son calcul.
    const maskIdx = device().mask?.index.zones ?? {};
    this.zones.forEach((z, i) => {
      const d = z.def.maskOf ? this.zones.find((o) => o.def.id === z.def.maskOf)?.def : z.def;
      if (!d) return;
      const m = maskIdx[d.id];
      const geom = JSON.stringify({ kind: d.kind, rect: d.rect, inner: d.inner ?? null, circle: d.circle ?? null, path: d.path ?? null, width: d.width ?? null, polygon: d.polygon ?? null });
      if (m && m.geom === geom && this.maskTex) g.mask[i] = m.id;
    });
    let seg = 0, poly = 0;
    const W = (p: NPoint): NPoint => [p[0], p[1] * ASPECT];
    this.zones.forEach((z, i) => {
      const d = z.def;
      const [x0, x1, y0, y1] = d.rect;
      g.rect.set([x0, x1, y0 * ASPECT, y1 * ASPECT], i * 4);
      let kind: number = KIND_ID[d.kind] ?? 0;
      let aux = d.effect === 'power' ? ((x0 + x1) / 2 < 0.5 ? 1 : 0) : (d.origin ?? 0);
      if (d.kind === 'circle' && d.circle) {
        const c = W(d.circle.c);
        g.geom.set([c[0], c[1], d.circle.blades, d.circle.housing], i * 4);
      } else if (d.kind === 'frame' && d.inner) {
        const [a0, a1, b0, b1] = d.inner;
        g.geom.set([a0, a1, b0 * ASPECT, b1 * ASPECT], i * 4);
      } else if (d.kind === 'path' && d.path && d.path.length >= 2) {
        const pts = d.path.map(W);
        const start = seg;
        let s = 0;
        for (let k = 0; k < pts.length - 1 && seg < MAXSEG; k++, seg++) {
          const len = Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
          g.seg.set([pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]], seg * 4);
          g.segInfo.set([s, len, 0, 0], seg * 4);
          s += len;
        }
        g.geom.set([start, seg - start, d.width ?? 0.01, s], i * 4);
      } else if (d.polygon && d.polygon.length >= 3) {
        kind = KIND_ID.poly;
        const start = poly;
        for (const p of d.polygon) {
          if (poly >= MAXPOLY) break;
          const q = W(p);
          g.poly.set(q, poly * 2);
          poly++;
        }
        g.geom.set([start, poly - start, 0, 0], i * 4);
      }
      if (d.effect === 'battery') aux = d.cell ?? 0;
      g.param.set([EFFECT_ID[d.effect] ?? 0, kind, d.feather ?? 0.004, aux], i * 4);
    });
    this.zoneCount = this.zones.length;
    this.batteryCells = Math.max(1, ...this.zones.filter((z) => z.def.effect === 'battery').map((z) => (z.def.cell ?? 0) + 1));
    this.geoDirty = true;
  }

  // ------------------------------------------------------------ dimensions et coordonnées

  resize() {
    const cssW = window.innerWidth, cssH = window.innerHeight;
    const [MW, MH] = this.mapSize;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // Au-delà de la résolution des cartes, aucun détail supplémentaire : on plafonne.
    const sCss = Math.max(cssW / MW, cssH / MH);
    const k = Math.max(0.5, Math.min(dpr, config.quality / sCss));
    const w = Math.max(2, Math.round(cssW * k)), h = Math.max(2, Math.round(cssH * k));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    // Recadrage « cover » : fraction visible de l'image et décalage.
    const s = Math.max(cssW / MW, cssH / MH);
    const fx = cssW / (MW * s), fy = cssH / (MH * s);
    this.view = { cssW, cssH, cover: [fx, fy, (1 - fx) / 2, (1 - fy) / 2] };
    this.stats.w = w; this.stats.h = h;
    if (!this.ready) return;
    const gl = this.gl;
    const fw = Math.max(16, Math.round(w / 4)), fh = Math.max(16, Math.round(h / 4));
    if (!this.field || this.field.w !== fw || this.field.h !== fh) {
      dropTarget(gl, this.field); dropTarget(gl, this.bloomA); dropTarget(gl, this.bloomB);
      this.field = target(gl, fw, fh, this.floatOk);
      this.bloomA = target(gl, fw, fh, this.floatOk);
      this.bloomB = target(gl, fw, fh, this.floatOk);
    }
    this.wake();
  }

  clientToNorm(x: number, y: number): [number, number] {
    const [fx, fy, ox, oy] = this.view.cover;
    return [ox + (x / this.view.cssW) * fx, oy + (y / this.view.cssH) * fy];
  }

  normToClient(u: number, v: number): [number, number] {
    const [fx, fy, ox, oy] = this.view.cover;
    return [((u - ox) / fx) * this.view.cssW, ((v - oy) / fy) * this.view.cssH];
  }

  /** Zone sous le pointeur : la plus petite qui le contient. */
  hitTest(x: number, y: number): ZoneRT | null {
    const [u, v] = this.clientToNorm(x, y);
    let best: ZoneRT | null = null, area = Infinity;
    for (const z of this.zones) {
      if (!zoneContains(z.def, u, v)) continue;
      const a = zoneArea(z.def);
      if (a < area) { area = a; best = z; }
    }
    return best;
  }

  /** Flash bref d'une zone (branchement secteur, éditeur). */
  pulse(z: ZoneRT | null, _u?: number, _v?: number, strength = 1) {
    if (z) z.impulse = Math.min(1.5, z.impulse + strength);
    this.interactiveUntil = performance.now() + 2500;
    this.wake();
  }

  /** Onde qui parcourt les pistes depuis un point (coordonnées normalisées). */
  ripple(u: number, v: number, strength = 1) {
    this.ripples.push({ x: u, y: v * ASPECT, age: 0, strength });
    if (this.ripples.length > MAXRIPPLE) this.ripples.shift();
    this.interactiveUntil = performance.now() + 2500;
    this.wake();
  }

  setSignals(d: Derived) {
    this.signals = d;
    this.wake();
  }

  // ------------------------------------------------------------ boucle

  setHidden(h: boolean) {
    this.hidden = h;
    if (h) this.stop(); else this.wake();
  }

  setMotion(m: boolean) {
    this.motion = m;
    this.wake();
  }

  private stop() {
    clearTimeout(this.timer); this.timer = 0;
    cancelAnimationFrame(this.raf); this.raf = 0;
  }

  /** Programme la prochaine image selon la cadence voulue. */
  wake() {
    if (this.hidden || !this.ready || this.raf || this.timer) return;
    const now = performance.now();
    const interval = this.frameInterval(now);
    // Dès 30 i/s, la boucle suit le rafraîchissement de l'écran (requestAnimationFrame) :
    // les images tombent sur la synchronisation verticale, sans à-coups. Les cadences plus basses
    // (économie d'énergie) passent par un minuteur.
    if (interval <= 1000 / 29) { this.raf = requestAnimationFrame((t) => this.frame(t)); return; }
    const wait = Math.max(0, interval - (now - this.lastFrame) - 2);
    if (wait < 4) this.raf = requestAnimationFrame((t) => this.frame(t));
    else this.timer = window.setTimeout(() => { this.timer = 0; this.raf = requestAnimationFrame((t) => this.frame(t)); }, wait);
  }

  private frameInterval(now: number) {
    if (config.still) return 1000;
    if (now < this.interactiveUntil) return 1000 / 60;
    if (!this.motion) return 250;
    return 1000 / config.idleFps;
  }

  private frame(t: number) {
    this.raf = 0;
    if (this.hidden || !this.ready) return;
    // Écran 120 Hz et cible 60 i/s : une image sur deux, à intervalle constant.
    const interval = this.frameInterval(t);
    if (this.lastFrame && interval <= 1000 / 29 && t - this.lastFrame < interval - 3) {
      this.raf = requestAnimationFrame((tt) => this.frame(tt));
      return;
    }
    const dt = this.lastFrame ? Math.min(0.1, (t - this.lastFrame) / 1000) : 1 / 30;
    this.lastFrame = t;
    const t0 = performance.now();
    this.update(dt);
    this.draw();
    this.stats.frameMs = this.stats.frameMs * 0.9 + (performance.now() - t0) * 0.1;
    this.fpsCount++;
    if (t - this.fpsT > 1000) { this.stats.fps = Math.round((this.fpsCount * 1000) / (t - this.fpsT)); this.fpsT = t; this.fpsCount = 0; }
    if (!config.still) this.wake();
  }

  /** Rendu immédiat d'une image (captures, mode figé). */
  renderNow() {
    if (!this.ready) return;
    this.update(config.still ? 2 : 1 / 30);
    this.draw();
  }

  private update(dt: number) {
    const motion = this.motion && !config.still ? 1 : 0;
    this.time += dt * motion;
    const sig = this.signals;
    const b = sig?.battery;
    for (const z of this.zones) {
      const name = this.signalOf(z.def);
      let target = sig?.values[name] ?? 0;
      if (z.forced != null) target = z.forced;
      z.target = target;
      // Montée en ~1 s et descente en ~2 s, avec accélération et décélération (pas d'à-coup).
      const smooth = z.def.effect === 'battery' || z.def.effect === 'control' ? 1.6 : target > z.level ? 0.9 : 1.8;
      if (config.still) { z.level = target; z.vel = 0; }
      else [z.level, z.vel] = smoothDamp(z.level, target, z.vel ?? 0, smooth, dt);
      z.hover += (z.hoverTarget - z.hover) * (1 - Math.exp(-dt / 0.15));
      z.impulse *= Math.exp(-dt / 0.9);
      if (z.impulse < 0.002) z.impulse = 0;
      if (z.def.effect === 'battery') {
        z.aux = clamp01(z.level * this.batteryCells - (z.def.cell ?? 0));
        z.flagA = b?.charging ? 1 : 0;
        z.flagB = b?.low && z.forced == null ? 1 : 0;
      }
      z.phase += dt * phaseSpeed(z.def.effect, z.level, z) * motion;
    }

    // Ventilateurs : régime issu de leur zone (télémétrie ou forçage de l'éditeur).
    this.fans.forEach((f, k) => {
      const z = this.zone(k === 0 ? 'fan_left' : 'fan_right');
      const target = this.fanForce ?? z?.level ?? 0.1;
      // Inertie mécanique : accélère en ~1,5 s, ralentit en ~4 s.
      f.level += (target - f.level) * (config.still ? 1 : 1 - Math.exp(-dt / (target > f.level ? 1.5 : 4)));
      const rps = 0.12 + 5.5 * Math.pow(f.level, 1.3);
      f.angle = (f.angle + 2 * Math.PI * rps * dt * motion * (k === 0 ? 1 : -1)) % (2 * Math.PI * 1000);
    });

    for (const r of this.ripples) r.age += dt;
    this.ripples = this.ripples.filter((r) => r.age < 2.5);
  }

  private draw() {
    const gl = this.gl, g = this.geo, s = this.settings;
    const { field, bloomA, bloomB } = this;
    if (!field || !bloomA || !bloomB || !this.maps || !this.ramp) return;
    const cover = this.view.cover;
    const fieldOut = this.floatOk ? 1 : 0.25;

    this.zones.forEach((z, i) => {
      // gain : atténuation propre à la zone (zone parente discrète, par exemple).
      g.state.set([z.level * (z.def.gain ?? 1), z.hover, z.impulse, z.aux], i * 4);
      g.anim.set([z.phase, z.flagA, z.flagB, z.def.above ? 1 : 0], i * 4);
    });
    g.ripple.fill(0);
    this.ripples.forEach((r, i) => g.ripple.set([r.x, r.y, r.age, r.strength], i * 4));

    const bindTex = (p: Program, name: string, tex: WebGLTexture, unit: number) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(p.u[name], unit);
    };

    // Au repos, le champ émissif et le bloom (basse fréquence) ne sont recalculés qu'une image
    // sur deux ; les ventilateurs et la composition restent à pleine cadence.
    // En économie d'énergie (cadence < 30 i/s), le champ émissif et le bloom ne sont recalculés
    // qu'une image sur deux ; sinon à chaque image, pour des lumières parfaitement fluides.
    const eco = !config.still && config.idleFps < 30 && performance.now() >= this.interactiveUntil;
    const refresh = !eco || this.geoDirty || this.frameNo++ % 2 === 0;
    let p = this.progs.comp;
    if (refresh) {
      // 1. champ émissif
      p = this.progs.field;
      gl.useProgram(p.prog);
      gl.bindFramebuffer(gl.FRAMEBUFFER, field.fb);
      gl.viewport(0, 0, field.w, field.h);
      gl.uniform4fv(p.u.uCover, cover);
      bindTex(p, 'uRamp', this.ramp, 0);
      if (this.geoDirty) {
        gl.uniform4fv(p.u.uZRect, g.rect);
        gl.uniform4fv(p.u.uZParam, g.param);
        gl.uniform4fv(p.u.uZGeom, g.geom);
        gl.uniform1i(p.u.uZCount, this.zoneCount);
        gl.uniform4fv(p.u.uSeg, g.seg);
        gl.uniform4fv(p.u.uSegInfo, g.segInfo);
        gl.uniform4fv(p.u.uPoly, g.poly);
        this.geoDirty = false;
      }
      gl.uniform4fv(p.u.uZState, g.state);
      gl.uniform4fv(p.u.uZAnim, g.anim);
      gl.uniform1fv(p.u.uZMask, g.mask);
      gl.uniform1f(p.u.uHasMask, this.maskTex ? 1 : 0);
      gl.uniform2fv(p.u.uMaskTexel, this.maskTexel);
      if (this.maskTex) bindTex(p, 'uZoneMask', this.maskTex, 1);
      gl.uniform4fv(p.u.uRipple, g.ripple);
      gl.uniform1i(p.u.uRippleCount, this.ripples.length);
      gl.uniform1f(p.u.uTime, this.time);
      gl.uniform1f(p.u.uAspect, ASPECT);
      gl.uniform1f(p.u.uAmbientGlow, s.ambientGlow);
      gl.uniform1f(p.u.uMotion, this.motion ? 1 : 0);
      gl.uniform1f(p.u.uOut, fieldOut);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // 2. source du bloom
      p = this.progs.bright;
      gl.useProgram(p.prog);
      gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fb);
      gl.uniform4fv(p.u.uCover, cover);
      bindTex(p, 'uMaps', this.maps, 0);
      bindTex(p, 'uField', field.tex, 1);
      gl.uniform1f(p.u.uDetailK, s.detail);
      gl.uniform1f(p.u.uEdgeK, s.edges);
      gl.uniform1f(p.u.uLod, Math.log2(Math.max(1, (this.mapSize[0] * cover[0]) / field.w)));
      gl.uniform2fv(p.u.uLevels, this.levels);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // 3. flou séparable (trois allers-retours : halo large et diffus, lumière « studio »)
      p = this.progs.blur;
      gl.useProgram(p.prog);
      gl.uniform4fv(p.u.uCover, cover);
      for (let k = 0; k < 3; k++) {
        const spread = [1.2, 2.6, 4.8][k];
        gl.bindFramebuffer(gl.FRAMEBUFFER, bloomB.fb);
        bindTex(p, 'uSrc', bloomA.tex, 0);
        gl.uniform2f(p.u.uDir, spread / field.w, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fb);
        bindTex(p, 'uSrc', bloomB.tex, 0);
        gl.uniform2f(p.u.uDir, 0, spread / field.h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }

    // 4. composition
    p = this.progs.comp;
    gl.useProgram(p.prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.uniform4fv(p.u.uCover, cover);
    bindTex(p, 'uMaps', this.maps, 0);
    bindTex(p, 'uField', field.tex, 1);
    bindTex(p, 'uBloom', bloomA.tex, 2);
    bindTex(p, 'uRamp', this.ramp, 3);
    gl.uniform2fv(p.u.uLevels, this.levels);
    gl.uniform1f(p.u.uGamma, s.gamma);
    gl.uniform1f(p.u.uExposure, s.exposure);
    gl.uniform1f(p.u.uAmbient, s.ambient);
    gl.uniform1f(p.u.uDetailK, s.detail);
    gl.uniform1f(p.u.uEdgeK, s.edges);
    gl.uniform1f(p.u.uBloomK, s.bloom / fieldOut);
    gl.uniform1f(p.u.uIn, 1 / fieldOut);
    gl.uniform1f(p.u.uGrain, s.grain);
    gl.uniform1f(p.u.uVignette, s.vignette);
    gl.uniform1f(p.u.uAurora, s.aurora ?? 0.06);
    gl.uniform1f(p.u.uMotionK, this.motion && !config.still ? 1 : 0);
    gl.uniform1f(p.u.uTime, this.time);
    gl.uniform1f(p.u.uAspect, ASPECT);
    const fan = new Float32Array(8), blur = new Float32Array(8);
    this.fans.forEach((f, k) => {
      const z = this.zone(k === 0 ? 'fan_left' : 'fan_right');
      const c = z?.def.circle;
      if (!c) return;
      fan.set([c.c[0], c.c[1] * ASPECT, c.blades, f.angle], k * 4);
      // Flou de rotation : arc parcouru pendant la durée d'une image (obturateur à 180°), plafonné.
      const omega = 2 * Math.PI * (0.12 + 5.5 * Math.pow(f.level, 1.3));
      const shutter = 0.5 * Math.min(1 / 24, this.frameInterval(performance.now()) / 1000);
      const arc = this.motion ? Math.min(1.5, omega * shutter) : 0;
      blur.set([arc, Math.max(1, Math.min(16, Math.ceil(arc / 0.07))), 0, 0], k * 4);
    });
    gl.uniform4fv(p.u.uFan, fan);
    gl.uniform4fv(p.u.uFanBlur, blur);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
