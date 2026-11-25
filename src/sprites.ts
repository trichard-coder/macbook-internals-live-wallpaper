// Sprites de zone : découpe d'un calque coloré à travers le masque adouci d'une zone.
// Construits une seule fois (paresseusement) puis simplement dessinés avec une opacité variable,
// ce qui garde le coût par image très bas en Canvas 2D.

import type { LayerName } from './assets';
import type { NRect, ZoneDef } from './types';
import { zoneBounds } from './zones';

export type RGB = [number, number, number];

export interface Sprite {
  canvas: HTMLCanvasElement;
  /** Bornes normalisées [x0, x1, y0, y1] couvertes par le canevas du sprite. */
  b: NRect;
  accent: RGB;
}

export interface SpriteVariant {
  tint: string;
  tintOp?: GlobalCompositeOperation;
  tintAlpha?: number;
}

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

// Flou en boîte séparable, 3 passes (approximation d'un flou gaussien), bords à zéro.
function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = 0; k <= r && k < w; k++) acc += src[row + k];
    for (let x = 0; x < w; x++) {
      dst[row + x] = acc * inv;
      const add = x + r + 1, rem = x - r;
      if (add < w) acc += src[row + add];
      if (rem >= 0) acc -= src[row + rem];
    }
  }
}
function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const inv = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = 0; k <= r && k < h; k++) acc += src[k * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc * inv;
      const add = y + r + 1, rem = y - r;
      if (add < h) acc += src[add * w + x];
      if (rem >= 0) acc -= src[rem * w + x];
    }
  }
}

/** Masque blanc à bords adoucis ; blur en pixels du sprite. */
function buildMask(w: number, h: number, path: (ctx: CanvasRenderingContext2D) => void, blur: number): HTMLCanvasElement {
  const ds = blur > 6 ? 0.5 : 1; // le masque flou supporte bien une demi-résolution
  const mw = Math.max(1, Math.ceil(w * ds)), mh = Math.max(1, Math.ceil(h * ds));
  const c = makeCanvas(mw, mh);
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.setTransform(ds, 0, 0, ds, 0, 0);
  x.fillStyle = '#fff';
  x.beginPath();
  path(x);
  x.fill();
  const r = Math.round((blur * ds) / 3);
  if (r >= 1) {
    const id = x.getImageData(0, 0, mw, mh);
    const d = id.data;
    const a = new Float32Array(mw * mh), t = new Float32Array(mw * mh);
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
    for (let pass = 0; pass < 3; pass++) { boxH(a, t, mw, mh, r); boxV(t, a, mw, mh, r); }
    for (let i = 0; i < a.length; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255; d[i * 4 + 3] = a[i]; }
    x.putImageData(id, 0, 0);
  }
  return c;
}

/** Couleur d'accent d'un sprite : moyenne pondérée, saturation et luminosité relevées. */
function accentOf(c: HTMLCanvasElement): RGB {
  const s = makeCanvas(12, 12);
  const x = s.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(c, 0, 0, 12, 12);
  const d = x.getImageData(0, 0, 12, 12).data;
  let r = 0, g = 0, b = 0, wsum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
    const w = a * (0.15 + (mx - mn) / 255); // privilégie les pixels colorés
    r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; wsum += w;
  }
  if (wsum <= 0) return [200, 210, 230];
  return boost([r / wsum, g / wsum, b / wsum]);
}

function boost([r, g, b]: RGB): RGB {
  // RGB -> HSL, saturation >= 0.65 et luminosité 0.62, puis retour en RGB.
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  if (s < 0.08) return [225, 230, 240]; // quasi neutre : accent blanc froid
  return hslToRgb(h * 360, Math.max(s, 0.65) * 100, 62);
}

export function hslToRgb(h: number, s: number, l: number): RGB {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export function buildSprite(img: HTMLImageElement, zone: ZoneDef, res: number, variant?: SpriteVariant): Sprite {
  const IW = img.naturalWidth, IH = img.naturalHeight;
  const featherPx = Math.max(0, zone.feather) * IW;
  const pad = featherPx * 1.2 + 2;
  const [x0, x1, y0, y1] = zoneBounds(zone);
  const bx0 = Math.max(0, Math.floor(x0 * IW - pad)), bx1 = Math.min(IW, Math.ceil(x1 * IW + pad));
  const by0 = Math.max(0, Math.floor(y0 * IH - pad)), by1 = Math.min(IH, Math.ceil(y1 * IH + pad));
  const sw = Math.max(1, bx1 - bx0), sh = Math.max(1, by1 - by0);
  const cw = Math.max(1, Math.round(sw * res)), ch = Math.max(1, Math.round(sh * res));

  const c = makeCanvas(cw, ch);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, bx0, by0, sw, sh, 0, 0, cw, ch);
  if (variant) {
    ctx.globalCompositeOperation = variant.tintOp ?? 'soft-light';
    ctx.globalAlpha = variant.tintAlpha ?? 0.5;
    ctx.fillStyle = variant.tint;
    ctx.fillRect(0, 0, cw, ch);
    ctx.globalAlpha = 1;
  }
  const X = (u: number) => (u * IW - bx0) * res, Y = (v: number) => (v * IH - by0) * res;
  const mask = buildMask(cw, ch, (m) => {
    if (zone.polygon && zone.polygon.length >= 3) {
      zone.polygon.forEach(([u, v], i) => (i ? m.lineTo(X(u), Y(v)) : m.moveTo(X(u), Y(v))));
      m.closePath();
    } else {
      const [rx0, rx1, ry0, ry1] = zone.rect;
      m.rect(X(rx0), Y(ry0), X(rx1) - X(rx0), Y(ry1) - Y(ry0));
    }
  }, featherPx * res);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask, 0, 0, cw, ch);
  ctx.globalCompositeOperation = 'source-over';
  return { canvas: c, b: [bx0 / IW, bx1 / IW, by0 / IH, by1 / IH], accent: accentOf(c) };
}

export class SpriteCache {
  private map = new Map<string, Sprite>();
  res = 1;
  constructor(private image: (l: LayerName) => HTMLImageElement | null) {}

  get(zone: ZoneDef, layer: LayerName, variantKey = '', variant?: SpriteVariant): Sprite | null {
    const key = `${zone.id}|${layer}|${variantKey}`;
    let s = this.map.get(key);
    if (!s) {
      const img = this.image(layer);
      if (!img) return null;
      s = buildSprite(img, zone, this.res, variant);
      this.map.set(key, s);
    }
    return s;
  }

  invalidateZone(id: string) {
    for (const k of [...this.map.keys()]) if (k.startsWith(id + '|')) this.map.delete(k);
  }

  clear() { this.map.clear(); }
}
