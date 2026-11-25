export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
/** Quantification des valeurs visuelles pour les clés de redessin (pas de 1/160, sous le seuil visible). */
export const q = (x: number) => Math.round(x * 160);
