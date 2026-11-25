// Effets par composant. Chaque effet fournit :
//   key()       une clé visuelle : si elle change, la zone est redessinée ;
//   animating() vrai tant qu'une animation continue doit garder la boucle active ;
//   draw()      le dessin, toujours limité (clip) au rectangle de peinture de la zone.

import type { Renderer, ZoneRT } from './renderer';
import { clamp01, q, smoothstep } from './util';
import type { RGB } from './sprites';
import { hslToRgb } from './sprites';
import type { NRect } from './types';
import { zoneAnchor, zoneBounds } from './zones';

export interface Effect {
  /** Constante de lissage exponentiel de l'intensité (secondes). */
  tau?: number;
  /** Bornes de peinture normalisées si l'effet déborde de la zone. */
  bounds?(z: ZoneRT, r: Renderer): NRect;
  update?(z: ZoneRT, r: Renderer, dt: number, t: number): void;
  animating?(z: ZoneRT, r: Renderer): boolean;
  /** Cadence suffisante pour l'animation en cours (par défaut : cadence de repos configurée). */
  fps?(z: ZoneRT, r: Renderer): number;
  key(z: ZoneRT, r: Renderer, t: number): string;
  draw(z: ZoneRT, r: Renderer, t: number): void;
}

/** Intensité affichée : niveau lissé + impulsion éventuelle. */
const vis = (z: ZoneRT) => clamp01(z.level + z.impulse * 0.7);
const expand = (b: NRect, du: number, aspect: number): NRect => [b[0] - du, b[1] + du, b[2] - du * aspect, b[3] + du * aspect];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t].map(Math.round) as RGB;
const COLD: RGB = [90, 170, 255];
const HOT: RGB = [255, 104, 40];
const WHITE: RGB = [235, 238, 245];

const DEFAULT: Effect = {
  key: (z) => `${q(vis(z))}`,
  draw: (z, r) => r.reveal(z, vis(z)),
};

// ------------------------------------------------------------------ puce (CPU / GPU)

const soc: Effect = {
  tau: 0.5,
  bounds: (z, r) => expand(zoneBounds(z.def), 0.02, r.aspect),
  update(z, _r, dt) {
    // La pulsation accélère avec la charge (0,35 à 1,75 Hz).
    z.fx.phase = ((z.fx.phase ?? 0) + dt * (0.35 + 1.4 * z.level) * Math.PI * 2) % (Math.PI * 2);
  },
  animating: (z, r) => r.motion && z.level > 0.15,
  fps: (z) => (z.level < 0.5 ? 15 : 30),
  key: (z, r) => `${q(vis(z))}|${r.motion && z.level > 0.15 ? q(Math.sin(z.fx.phase ?? 0) * z.level) : 0}`,
  draw(z, r) {
    const th = r.theme;
    const pulse = r.motion && z.level > 0.15 ? Math.sin(z.fx.phase ?? 0) : 0;
    const v = clamp01(vis(z) + pulse * 0.05 * z.level);
    const aMid = smoothstep(0, 0.5, v), aHigh = smoothstep(0.42, 1, v);
    // Teinte qui glisse du froid (repos) au chaud (pleine charge).
    const mid = th.tintCold ? r.sprite(z, th.mid, 'cold', { tint: th.tintCold, tintOp: 'soft-light', tintAlpha: 0.55 }) : r.sprite(z, th.mid);
    if (mid) r.drawSprite(mid, aMid);
    const high = r.sprite(z, th.high);
    if (high) r.drawSprite(high, aHigh * th.highAlpha, th.highOp);
    const hot = smoothstep(0.55, 1, z.level);
    if (th.tintWarm && hot > 0.003) {
      const s = r.sprite(z, th.high, 'hot', { tint: th.tintWarm, tintOp: 'soft-light', tintAlpha: 0.6 });
      if (s) r.drawSprite(s, aHigh * hot * 0.75, th.highOp);
    }
    // Cœur incandescent centré sur le die.
    const core = z.def.core ?? z.def.rect;
    const [cu, cv] = zoneAnchor(z.def);
    const col = th.mono ? WHITE : mix(COLD, HOT, smoothstep(0.2, 0.9, z.level));
    r.glow(cu, cv, (core[1] - core[0]) * (0.5 + 0.3 * v), col, 0.4 * Math.pow(v, 1.4) * (1 + 0.3 * pulse));
  },
};

// ------------------------------------------------------------------ mémoire / stockage

const memory: Effect = {
  tau: 0.25,
  update(z, r, _dt, t) {
    // Scintillement à 14 Hz, proportionnel aux entrées / sorties disque.
    const io = z.forced != null ? z.forced : r.signals.ioLevel;
    const step = Math.floor(t * 14);
    if (step !== z.fx.step) {
      z.fx.step = step;
      z.fx.flick = r.motion && io > 0.08 ? io * (0.3 + 0.7 * Math.random()) * (Math.random() < 0.35 ? 0.2 : 1) : 0;
    }
  },
  animating: (z, r) => r.motion && (z.forced ?? r.signals.ioLevel) > 0.08,
  fps: () => 14,
  key: (z) => `${q(vis(z))}|${q(z.fx.flick ?? 0)}`,
  draw(z, r) {
    const f = z.fx.flick ?? 0;
    r.reveal(z, clamp01(vis(z) + f * 0.4));
    if (f > 0.04) {
      const [u, v] = zoneAnchor(z.def);
      r.glow(u, v, (z.def.rect[1] - z.def.rect[0]) * 0.7, r.accent(z), f * 0.3);
    }
  },
};

// ------------------------------------------------------------------ Wi-Fi / Bluetooth

const RING_R = 0.045;
const wifi: Effect = {
  tau: 0.4,
  bounds(z, r) {
    const [u, v] = zoneAnchor(z.def), b = zoneBounds(z.def);
    return [Math.min(b[0], u - RING_R), Math.max(b[1], u + RING_R), Math.min(b[2], v - RING_R * r.aspect), Math.max(b[3], v + RING_R * r.aspect)];
  },
  update(z, r, dt) {
    const n = z.forced ?? r.signals.netLevel;
    const rings: number[] = (z.fx.rings ??= []);
    if (r.motion && n > 0.03) {
      // Ondes émises de 0,25 à 2,5 par seconde selon le débit.
      z.fx.emit = (z.fx.emit ?? 0.9) + dt * (0.25 + 2.2 * n);
      if (z.fx.emit >= 1) { z.fx.emit -= 1; rings.push(0); }
    }
    for (let i = 0; i < rings.length; i++) rings[i] += dt / 1.6;
    z.fx.rings = rings.filter((a) => a < 1);
  },
  animating: (z, r) => (z.fx.rings?.length ?? 0) > 0 || (r.motion && (z.forced ?? r.signals.netLevel) > 0.03),
  key: (z) => `${q(vis(z))}|${(z.fx.rings ?? []).map(q).join(',')}`,
  draw(z, r) {
    r.reveal(z, vis(z));
    const [u, v] = zoneAnchor(z.def);
    const c = r.accent(z);
    const n = z.forced ?? r.signals.netLevel;
    for (const a of z.fx.rings ?? []) r.ring(u, v, 0.006 + a * (RING_R - 0.008), c, Math.pow(1 - a, 1.5) * (0.25 + 0.45 * n), 1.3);
  },
};

// ------------------------------------------------------------------ étage d'alimentation

/** Puissance (échelle 0 à 1) au-delà de laquelle le balayage s'anime, environ 17 W. */
const SWEEP_MIN = 0.45;
const power: Effect = {
  tau: 1.0,
  update(z, _r, dt, t) {
    // Balayage lumineux le long des composants, plus rapide quand la puissance monte.
    const tick = Math.floor(t * 15);
    if (tick !== z.fx.tick15) {
      z.fx.sweep = ((z.fx.sweep ?? 0) + (z.fx.acc ?? 0) * (0.08 + 0.45 * z.level)) % 1.5;
      z.fx.acc = 0;
      z.fx.tick15 = tick;
    }
    z.fx.acc = (z.fx.acc ?? 0) + dt;
  },
  animating: (z, r) => r.motion && z.level > SWEEP_MIN,
  // Position du balayage échantillonnée à 15 Hz : fluide pour un reflet lent, deux fois moins de redessins.
  key: (z, r) => `${q(vis(z))}|${r.motion && z.level > SWEEP_MIN ? z.fx.tick15 ?? 0 : 0}`,
  fps: () => 15,
  draw(z, r) {
    r.reveal(z, vis(z) * 0.85);
    if (!(r.motion && z.level > SWEEP_MIN)) return;
    const s = r.sprite(z, r.theme.high);
    if (!s) return;
    const [x0, x1, y0, y1] = z.def.rect;
    const pos = x0 + ((z.fx.sweep ?? 0) - 0.25) * (x1 - x0);
    const half = 0.09 * (x1 - x0);
    r.drawMasked(z, 'sweep', s, String(q(pos)), (c, X, Y) => {
      // Bande inclinée : le dégradé suit la diagonale de la zone.
      const g = c.createLinearGradient(X(pos - half), Y(y0), X(pos + half), Y(y0) + (Y(y1) - Y(y0)) * 0.25);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      return g;
    }, 0.15 + 0.6 * z.level, 'lighter');
  },
};

// ------------------------------------------------------------------ batteries

const LOW_RGB: RGB = [255, 90, 60];
const battery: Effect = {
  tau: 1.5,
  update(z, r, dt, t) {
    const b = r.signals.battery;
    if (b.charging || z.fx.plug > 0) z.fx.flow = ((z.fx.flow ?? 0) + dt * 0.42) % 1.6;
    z.fx.plug = Math.max(0, (z.fx.plug ?? 0) - dt / 2.5);
    z.fx.lowPulse = 0.5 + 0.5 * Math.sin(t * 2.4);
  },
  animating: (z, r) => r.motion && (r.signals.battery.charging || (z.fx.plug ?? 0) > 0 || (r.signals.battery.low && z.forced == null)),
  key(z, r) {
    const b = r.signals.battery;
    const flowing = r.motion && (b.charging || (z.fx.plug ?? 0) > 0);
    const low = b.low && !b.charging && z.forced == null;
    return `${q(z.level)}|${flowing ? q(z.fx.flow ?? 0) : '-'}|${low && r.motion ? q(z.fx.lowPulse ?? 0) : '-'}|${low}`;
  },
  draw(z, r) {
    const b = r.signals.battery;
    const low = b.low && !b.charging && z.forced == null;
    const s = r.sprite(z, low ? r.theme.low : r.theme.high);
    if (!s) return;
    const fill = clamp01(z.level);
    if (fill <= 0.002) return;
    const [x0, x1, y0, y1] = z.def.rect;
    const edge = x0 + fill * (x1 - x0);
    const soft = 0.012;
    const base = (low ? 0.45 + 0.35 * (r.motion ? z.fx.lowPulse ?? 0 : 0.5) : 0.62) + 0.3 * z.impulse;
    // Remplissage des cellules de gauche à droite jusqu'au niveau de charge.
    r.drawMasked(z, 'fill', s, String(q(fill)), (c, X) => {
      const g = c.createLinearGradient(X(x0), 0, X(x1), 0);
      const e = clamp01(fill), e0 = clamp01(fill - soft);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      if (e < 0.999) {
        g.addColorStop(e0, 'rgba(255,255,255,1)');
        g.addColorStop(e, 'rgba(255,255,255,0)');
      }
      g.addColorStop(1, `rgba(255,255,255,${e >= 0.999 ? 1 : 0})`);
      return g;
    }, base);
    // Cellules très sombres dans tous les calques : renfort additif (même canevas en cache).
    const cached = z.fx.__fill as { c: HTMLCanvasElement } | undefined;
    if (cached) r.drawSprite(cached.c, base * (low ? 0.25 : 0.45), 'lighter', s.b);
    const c = low ? LOW_RGB : r.accent(z);
    // Liseré lumineux au niveau de remplissage.
    if (fill < 0.995) {
      const ctx = r.ctx;
      const x = r.nx(edge), w = Math.max(1.5, r.nlen(0.0035));
      const g = ctx.createLinearGradient(x - w * 3, 0, x + w, 0);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.75, `rgba(${c[0]},${c[1]},${c[2]},${0.21})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = g;
      ctx.fillRect(x - w * 3, r.ny(y0) + 2, w * 4, r.ny(y1) - r.ny(y0) - 4);
      ctx.globalCompositeOperation = 'source-over';
    }
    // Flux de charge : bande qui circule de la droite (ports) vers la gauche dans la partie remplie.
    if (r.motion && (b.charging || (z.fx.plug ?? 0) > 0)) {
      const p = 1.25 - (z.fx.flow ?? 0);
      const pos = x0 + p * (x1 - x0), half = 0.06;
      const ctx = r.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.nx(x0) - 2, r.ny(y0) - 2, r.nx(edge) - r.nx(x0) + 2, r.ny(y1) - r.ny(y0) + 4);
      ctx.clip();
      r.drawMasked(z, 'flow', s, String(q(pos)), (cc, X) => {
        const g = cc.createLinearGradient(X(pos - half), 0, X(pos + half), 0);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(0.5, 'rgba(255,255,255,1)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        return g;
      }, 0.5 + 0.4 * (z.fx.plug ?? 0), 'lighter');
      ctx.restore();
    }
  },
};

// ------------------------------------------------------------------ plaque thermique

const HEAT_RGB: RGB = [255, 122, 46];
const thermal: Effect = {
  tau: 4,
  bounds(z, r) {
    const b = zoneBounds(z.def);
    const s = r.zone('soc');
    if (!s) return b;
    const sb = zoneBounds(s.def);
    return [b[0], Math.max(b[1], sb[1]), Math.min(b[2], sb[2]), Math.max(b[3], sb[3])];
  },
  update(z, r, _dt, t) {
    // Ondulation lente de la diffusion, échantillonnée à 6 Hz (peu de redessins).
    const tick = Math.floor(t * 6);
    if (tick !== z.fx.tick) {
      z.fx.tick = tick;
      const tt = tick / 6;
      z.fx.wob = r.motion && z.level > 0.15 ? 0.035 * Math.sin(tt * 0.7) + 0.02 * Math.sin(tt * 1.9 + 1) : 0;
    }
  },
  animating: (z, r) => r.motion && z.level > 0.15,
  fps: () => 6,
  key: (z, r) => `${q(vis(z))}|${r.motion && z.level > 0.15 ? z.fx.tick : 0}`,
  draw(z, r) {
    const v = vis(z);
    if (v < 0.004) return;
    // Variante « chaleur » : la plaque est presque noire dans tous les calques, on l'éclaire en orange.
    const s = r.theme.mono
      ? r.sprite(z, r.theme.high, 'heat', { tint: '#ffffff', tintOp: 'screen', tintAlpha: 0.16 })
      : r.sprite(z, r.theme.high, 'heat', { tint: '#ff6a20', tintOp: 'screen', tintAlpha: 0.3 });
    if (!s) return;
    const [x0, x1] = z.def.rect;
    const reach = clamp01(0.12 + 0.88 * v + (z.fx.wob ?? 0));
    const from = x1, to = x1 - reach * (x1 - x0);
    // Lueur qui part du bord le plus proche de la puce et gagne la plaque avec la charge.
    r.drawMasked(z, 'heat', s, `${q(reach)}`, (c, X) => {
      const g = c.createLinearGradient(X(from), 0, X(to), 0);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.4, 'rgba(255,255,255,0.7)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      return g;
    }, smoothstep(0, 0.35, v) * 0.95);
    const socZ = r.zone('soc');
    if (socZ) {
      const [cu, cv] = zoneAnchor(socZ.def);
      r.glow(cu - 0.04, cv, 0.06 + 0.12 * v, r.theme.mono ? WHITE : HEAT_RGB, 0.2 * v);
    }
  },
};

// ------------------------------------------------------------------ haut-parleurs

const SPK_R = 0.05;
const speaker: Effect = {
  tau: 0.6,
  bounds(z, r) {
    const [u, v] = zoneAnchor(z.def), b = zoneBounds(z.def);
    return [Math.min(b[0], u - SPK_R), Math.max(b[1], u + SPK_R), Math.min(b[2], v - SPK_R * r.aspect), Math.max(b[3], v + SPK_R * r.aspect)];
  },
  update(z, r, dt) {
    z.fx.env = (z.fx.env ?? 0) * Math.exp(-dt * 5);
    const rings: number[] = (z.fx.rings ??= []);
    if (r.motion && z.level > 0.05) {
      // Pulsation rythmée (environ 120 battements par minute, avec variations).
      z.fx.next = (z.fx.next ?? 0) - dt;
      if (z.fx.next <= 0) {
        z.fx.env = 0.6 + Math.random() * 0.4;
        z.fx.next = 0.28 + Math.random() * 0.3;
        if (Math.random() < 0.5) rings.push(0);
      }
    }
    for (let i = 0; i < rings.length; i++) rings[i] += dt / 1.2;
    z.fx.rings = rings.filter((a) => a < 1);
  },
  animating: (z, r) => (r.motion && z.level > 0.05) || (z.fx.env ?? 0) > 0.01 || (z.fx.rings?.length ?? 0) > 0,
  key: (z) => `${q(vis(z))}|${q(z.fx.env ?? 0)}|${(z.fx.rings ?? []).map(q).join(',')}`,
  draw(z, r) {
    const env = r.motion ? z.fx.env ?? 0 : 0.6;
    r.reveal(z, vis(z) * (0.65 + 0.35 * env), 0.6);
    const [u, v] = zoneAnchor(z.def);
    const c = r.accent(z);
    r.glow(u, v, 0.035, c, (0.12 + 0.3 * env) * vis(z));
    for (const a of z.fx.rings ?? []) r.ring(u, v, 0.012 + a * (SPK_R - 0.014), c, Math.pow(1 - a, 2) * 0.4 * z.level, 1.2);
  },
};

// ------------------------------------------------------------------ nappe centrale

interface Particle { p: number; lane: number; speed: number; dir: number; size: number }
const flex: Effect = {
  tau: 0.8,
  update(z, r, dt) {
    const parts: Particle[] = (z.fx.parts ??= []);
    const want = Math.round(4 + 22 * z.level);
    while (parts.length < want) {
      parts.push({ p: Math.random(), lane: (Math.random() * 2 - 1) * 0.55, speed: 0.6 + Math.random() * 0.8, dir: Math.random() < 0.72 ? 1 : -1, size: 0.6 + Math.random() * 0.6 });
    }
    if (parts.length > want) parts.length = want;
    if (!r.motion) return;
    // Vitesse : de 3 % à 50 % de la longueur de la nappe par seconde selon l'activité globale.
    const v = 0.03 + 0.47 * z.level;
    for (const pt of parts) {
      pt.p += pt.dir * pt.speed * v * dt;
      if (pt.p > 1) pt.p -= 1;
      if (pt.p < 0) pt.p += 1;
    }
  },
  animating: (_z, r) => r.motion,
  // Particules lentes à faible activité : 12 i/s suffisent (2 à 3 px par image).
  fps: (z) => (z.level < 0.2 ? 12 : 30),
  key: (z, r) => `${q(vis(z))}|${r.motion ? r.frameId : 0}`,
  draw(z, r) {
    r.reveal(z, vis(z) * 0.7);
    const [x0, x1, y0, y1] = z.def.rect;
    const cu = (x0 + x1) / 2, hw = (x1 - x0) / 2;
    const alpha = 0.35 + 0.65 * z.level;
    for (const pt of z.fx.parts ?? []) {
      const fade = smoothstep(0, 0.06, pt.p) * smoothstep(1, 0.94, pt.p);
      const [h, s, l] = r.theme.particleHue(pt.p);
      r.dot(cu + pt.lane * hw, y0 + pt.p * (y1 - y0), 0.006 * pt.size, hslToRgb(Math.round(h / 10) * 10, s, l), alpha * fade, 3.2);
    }
  },
};

// ------------------------------------------------------------------ ports

const ports: Effect = {
  tau: 0.8,
  key: (z) => `${q(vis(z))}`,
  draw(z, r) {
    const v = vis(z);
    r.reveal(z, v, 0.7);
    const [x0, x1, y0, y1] = z.def.rect;
    r.glow((x0 + x1) / 2, (y0 + y1) / 2, 0.03, r.accent(z), 0.18 * v);
    if (z.impulse > 0.01) {
      // Impulsion qui parcourt les ports de haut en bas au branchement.
      const p = 1 - z.impulse;
      r.glow((x0 + x1) / 2, y0 + p * (y1 - y0), 0.025, r.accent(z), z.impulse * 0.7);
    }
  },
};

// ------------------------------------------------------------------ connecteur d'écran (jour / nuit)

const display: Effect = {
  tau: 3,
  key: (z) => `${q(vis(z))}`,
  draw(z, r) {
    const v = vis(z);
    // Jour : calque warm ; en thème mono, simple éclaircissement pour rester sans couleur.
    const s = r.sprite(z, r.theme.mono ? r.theme.high : 'warm');
    if (s) r.drawSprite(s, smoothstep(0, 1, v) * (r.theme.mono ? 0.5 : 0.9), r.theme.mono ? 'lighter' : 'source-over');
  },
};

// ------------------------------------------------------------------ carte logique (zone parente)

const logic: Effect = {
  tau: 1.5,
  key: (z) => `${q(vis(z))}`,
  draw(z, r) {
    const s = r.sprite(z, r.theme.mid);
    if (s) r.drawSprite(s, smoothstep(0, 1, vis(z)) * 0.8);
  },
};

const trackpad: Effect = { tau: 0.25, key: DEFAULT.key, draw: (z, r) => r.reveal(z, vis(z), 0.5) };

const EFFECTS: Record<string, Effect> = {
  soc, memory_nand: memory, wifi_bt: wifi, power_stage: power,
  battery_top: battery, battery_bl: battery, battery_br: battery,
  thermal_plate: thermal, speaker_left: speaker, speaker_right: speaker,
  flex_cable: flex, ports_right: ports, display_connector: display, logic_board: logic,
  trackpad_taptic: trackpad,
};

export function effectFor(id: string): Effect {
  return EFFECTS[id] ?? DEFAULT;
}
