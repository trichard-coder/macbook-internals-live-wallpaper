// Calques optimisés (générés par scripts/optimize-images.mjs).
// En build monofichier, Vite les embarque en base64 dans le HTML.
import baseDark from '../assets/opt/base-dark.webp';
import rainbowMid from '../assets/opt/rainbow-mid.webp';
import rainbowHigh from '../assets/opt/rainbow-high.webp';
import warm from '../assets/opt/warm.webp';
import sunset from '../assets/opt/sunset.webp';
import monoA from '../assets/opt/mono-a.webp';

export type LayerName = 'base-dark' | 'rainbow-mid' | 'rainbow-high' | 'warm' | 'sunset' | 'mono-a';

const URLS: Record<LayerName, string> = {
  'base-dark': baseDark,
  'rainbow-mid': rainbowMid,
  'rainbow-high': rainbowHigh,
  warm,
  sunset,
  'mono-a': monoA,
};

const cache = new Map<LayerName, Promise<HTMLImageElement>>();

export function loadLayer(name: LayerName): Promise<HTMLImageElement> {
  let p = cache.get(name);
  if (!p) {
    p = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => img.decode().then(() => resolve(img), () => resolve(img));
      img.onerror = () => reject(new Error(`calque introuvable : ${name}`));
      img.src = URLS[name];
    });
    cache.set(name, p);
  }
  return p;
}
