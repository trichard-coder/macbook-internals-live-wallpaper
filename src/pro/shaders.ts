// Shaders GLSL ES 3.0 du moteur Pro.
// Passes par image :
//   1. field    (1/4 de résolution) : couleur émissive basse fréquence de toutes les zones
//   2. bright   (1/4) : émissif x (détails + contours) lus dans les mipmaps, source du bloom
//   3. blur H puis blur V (1/4) : flou gaussien du bloom
//   4. composite (pleine résolution) : niveaux, gradient map, rotation des ventilateurs,
//      émissif appliqué aux surfaces (et un peu aux arêtes), bloom, aurore, grain, vignette
// Les coordonnées des zones sont exprimées en « unités de largeur » : P = (u, v * aspect).

export const MAXZ = 40;
export const MAXSEG = 48;
export const MAXPOLY = 64; // sommets (deux par vec4)
export const MAXRIPPLE = 8;

export const EFFECT_ID = {
  glow: 0, chip: 1, frame: 2, fan: 3, vent: 4, heatpipe: 5, plate: 6, power: 7, nand: 8,
  battery: 9, flex: 10, speaker: 11, trackpad: 12, port: 13, control: 14, network: 15,
} as const;
export const KIND_ID = { rect: 0, circle: 1, path: 2, frame: 3, poly: 4 } as const;

export const VS = /* glsl */ `#version 300 es
precision highp float;
uniform vec4 uCover; // échelle (xy) et décalage (zw) écran -> image
out vec2 vImg;       // coordonnées image (v = 0 en haut)
out vec2 vScr;       // coordonnées écran GL (0 en bas)
void main() {
  vec2 a = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vScr = a * 0.5 + 0.5;
  vImg = vec2(vScr.x, 1.0 - vScr.y) * uCover.xy + uCover.zw;
  gl_Position = vec4(a, 0.0, 1.0);
}`;

const COMMON = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
vec3 ramp(sampler2D r, float row, float t) {
  return texture(r, vec2(clamp(t, 0.002, 0.998), (row + 0.5) / 8.0)).rgb;
}
`;

// ------------------------------------------------------------------ assemblage des cartes

export const FS_PACK = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uLum, uDetail, uEdges, uParts;
uniform float uHasParts;
in vec2 vScr;
out vec4 o;
void main() {
  // Ligne 0 du FBO = première ligne de l'image (haut) : même convention que les sources.
  vec2 uv = vScr;
  // Alpha : surface qui reçoit la lumière. 0 sur le circuit imprimé nu d'une zone de carte (code
  // bleu 15 de zones-parts.png), 1 ailleurs (pièces et reste de l'image). Filtré et mipmappé : le
  // halo (bloom) suit la densité de pièces au lieu d'éclairer toute la zone.
  float a = 1.0;
  if (uHasParts > 0.5 && abs(texture(uParts, uv).b * 255.0 - 15.0) < 0.5) a = 0.0;
  o = vec4(texture(uLum, uv).r, texture(uDetail, uv).r, texture(uEdges, uv).r, a);
}`;

// ------------------------------------------------------------------ champ émissif

export const FS_FIELD = /* glsl */ `#version 300 es
precision highp float;
#define MAXZ ${MAXZ}
#define MAXSEG ${MAXSEG}
#define MAXPOLY4 ${MAXPOLY / 2}
#define MAXRIPPLE ${MAXRIPPLE}
uniform sampler2D uRamp;
uniform vec4 uZRect[MAXZ];   // boîte (x0, x1, y0, y1) en unités de largeur
uniform vec4 uZParam[MAXZ];  // effet, forme, fondu, origine / cellule
uniform vec4 uZState[MAXZ];  // niveau, survol, impulsion, auxiliaire
uniform vec4 uZGeom[MAXZ];   // cercle / cadre intérieur / chemin / polygone
uniform vec4 uZAnim[MAXZ];   // phase, drapeau A, drapeau B, premier plan (1 : masque les zones dessous)
uniform int uZCount;
uniform vec4 uSeg[MAXSEG];   // a.xy, b.xy
uniform vec4 uSegInfo[MAXSEG]; // abscisse curviligne au début, longueur
uniform vec4 uPoly[MAXPOLY4];
uniform vec4 uRipple[MAXRIPPLE]; // x, y (unités de largeur), âge, force
uniform int uRippleCount;
uniform float uTime, uAspect, uAmbientGlow, uMotion, uOut;
uniform sampler2D uZoneMask;  // identifiants de zones par pixel (R, G, B : jusqu'à 3 superpositions)
uniform float uZMask[MAXZ];   // identifiant du masque de chaque zone (0 : forme géométrique seule)
uniform float uHasMask;
uniform vec2 uMaskTexel;
in vec2 vImg;
out vec4 o;
${COMMON}

// Quatre échantillons du masque autour du pixel : couverture à 5 niveaux, bords adoucis.
vec3 gT[4];
float maskCov(float k) {
  float c = 0.0;
  for (int t = 0; t < 4; t++) c += any(equal(gT[t], vec3(k))) ? 0.25 : 0.0;
  return c;
}

float sdBox(vec2 p, vec4 r) {
  vec2 c = vec2(r.x + r.y, r.z + r.w) * 0.5, h = vec2(r.y - r.x, r.w - r.z) * 0.5;
  vec2 q = abs(p - c) - h;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}

// Distance au polygone (signée, négative à l'intérieur).
float sdPoly(vec2 p, int start, int count) {
  float d = 1e9; bool inside = false;
  for (int i = 0; i < 2 * MAXPOLY4; i++) {
    if (i >= count) break;
    int j = i == 0 ? count - 1 : i - 1;
    int ii = start + i, jj = start + j;
    vec4 vi4 = uPoly[ii / 2], vj4 = uPoly[jj / 2];
    vec2 a = (ii % 2 == 0) ? vi4.xy : vi4.zw;
    vec2 b = (jj % 2 == 0) ? vj4.xy : vj4.zw;
    vec2 e = b - a, w = p - a;
    vec2 q = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
    d = min(d, dot(q, q));
    if (((a.y > p.y) != (b.y > p.y)) && (p.x < e.x * (p.y - a.y) / e.y + a.x)) inside = !inside;
  }
  return (inside ? -1.0 : 1.0) * sqrt(d);
}

// Distance au chemin et abscisse curviligne du point le plus proche.
vec2 pathDist(vec2 p, int start, int count) {
  float best = 1e9, s = 0.0;
  for (int i = 0; i < MAXSEG; i++) {
    if (i >= count) break;
    vec4 sg = uSeg[start + i];
    vec2 a = sg.xy, e = sg.zw - sg.xy, w = p - a;
    float t = clamp(dot(w, e) / max(dot(e, e), 1e-8), 0.0, 1.0);
    float d = length(w - e * t);
    if (d < best) { best = d; s = uSegInfo[start + i].x + t * uSegInfo[start + i].y; }
  }
  return vec2(best, s);
}

void main() {
  vec2 P = vec2(vImg.x, vImg.y * uAspect);
  float u = vImg.x;
  vec3 board = ramp(uRamp, 0.0, u);
  vec3 acc = board * uAmbientGlow * (0.85 + 0.15 * sin(uTime * 0.25 + u * 4.0) * uMotion);
  float surfW = 0.0, wSum = 1e-4;

  if (uHasMask > 0.5) {
    vec2 h = uMaskTexel * 0.5;
    gT[0] = floor(texture(uZoneMask, vImg + vec2(-h.x, -h.y)).rgb * 255.0 + 0.5);
    gT[1] = floor(texture(uZoneMask, vImg + vec2(h.x, -h.y)).rgb * 255.0 + 0.5);
    gT[2] = floor(texture(uZoneMask, vImg + vec2(-h.x, h.y)).rgb * 255.0 + 0.5);
    gT[3] = floor(texture(uZoneMask, vImg + vec2(h.x, h.y)).rgb * 255.0 + 0.5);
  }

  // Zones au premier plan (caloduc) : leur forme masque la lumière des zones situées dessous,
  // sinon la lueur d'un boîtier traverserait le tube comme s'il était transparent.
  float occ = 0.0;
  for (int i = 0; i < MAXZ; i++) {
    if (i >= uZCount) break;
    if (uZAnim[i].w < 0.5) continue;
    vec4 R = uZRect[i], prm = uZParam[i], G = uZGeom[i];
    float f = max(prm.z, 1e-4);
    if (P.x < R.x - 3.0 * f || P.x > R.y + 3.0 * f || P.y < R.z - 3.0 * f || P.y > R.w + 3.0 * f) continue;
    int kind = int(prm.y + 0.5);
    float mm = 0.0;
    if (kind == 2) {
      vec2 ds = pathDist(P, int(G.x + 0.5), int(G.y + 0.5));
      mm = 1.0 - smoothstep(1.0 - f / G.z, 1.0 + f / G.z, ds.x / max(G.z, 1e-4));
    } else if (kind == 0) mm = 1.0 - smoothstep(-f, f, sdBox(P, R));
    // Forme réelle du tube quand elle est connue (masque) : l'occultation suit exactement le caloduc.
    if (uHasMask > 0.5 && uZMask[i] > 0.5) mm *= maskCov(uZMask[i]);
    occ = max(occ, mm);
  }

  for (int i = 0; i < MAXZ; i++) {
    if (i >= uZCount) break;
    vec4 R = uZRect[i];
    vec4 prm = uZParam[i];
    float f = max(prm.z, 1e-4);
    if (P.x < R.x - 3.0 * f || P.x > R.y + 3.0 * f || P.y < R.z - 3.0 * f || P.y > R.w + 3.0 * f) continue;
    vec4 st = uZState[i], G = uZGeom[i], an = uZAnim[i];
    int effect = int(prm.x + 0.5), kind = int(prm.y + 0.5);
    float L = st.x, hover = st.y, imp = st.z, aux = st.w, phase = an.x;
    vec2 lp = (P - R.xz) / max(R.yw - R.xz, vec2(1e-4)); // coordonnées locales 0..1

    // Masque de forme. Le fondu est entièrement intérieur : la lumière s'estompe avant le bord et
    // ne sort jamais de la zone (un fondu centré débordait de moitié sur les pièces voisines).
    float m = 1.0, across = 0.0, sAlong = 0.0;
    if (kind == 0) m = 1.0 - smoothstep(-2.0 * f, 0.0, sdBox(P, R));
    else if (kind == 3) m = 1.0 - smoothstep(-2.0 * f, 0.0, max(sdBox(P, R), -sdBox(P, G)));
    else if (kind == 4) m = 1.0 - smoothstep(-2.0 * f, 0.0, sdPoly(P, int(G.x + 0.5), int(G.y + 0.5)));
    else if (kind == 1) {
      float r = length(P - G.xy);
      m = 1.0 - smoothstep(G.w - 2.0 * f, G.w, r);
      across = r;
    } else if (kind == 2) {
      vec2 ds = pathDist(P, int(G.x + 0.5), int(G.y + 0.5));
      across = ds.x / max(G.z, 1e-4);
      sAlong = ds.y;
      m = 1.0 - smoothstep(1.0 - 2.0 * f / G.z, 1.0, across);
    }
    // Forme réelle du composant (masque calculé depuis l'image) : la lumière ne déborde pas.
    if (uHasMask > 0.5 && uZMask[i] > 0.5) m *= maskCov(uZMask[i]);
    if (m <= 0.001) continue;

    vec3 col = board;
    float I = 0.0, surf = 0.1;

    if (effect == 1) { // puce : spectre complet, glisse vers le chaud avec la charge
      float t = (lp.x + lp.y) * 0.5, s = lp.x - lp.y;
      vec3 spec = mix(ramp(uRamp, 1.0, t), ramp(uRamp, 2.0, 0.5 + 0.5 * s), smoothstep(0.15, 0.95, s) * 0.75);
      col = mix(spec, ramp(uRamp, 3.0, 0.2 + 0.8 * L), 0.08 + 0.28 * L);
      I = 0.14 + 0.95 * L * (1.0 + 0.06 * sin(phase));
      surf = 0.75;
    } else if (effect == 2) { // cadre : pression mémoire
      col = mix(board, ramp(uRamp, 1.0, lp.x * 0.5 + lp.y * 0.5), 0.5);
      float run = 0.5 + 0.5 * sin((lp.x - lp.y) * 2.5 - phase * 0.6);
      I = 0.06 + L * (0.6 + 0.4 * run);
      surf = 0.18;
    } else if (effect == 3) { // ventilateur : anneau des ailettes
      float rb = G.z, ring = smoothstep(rb * 0.5, rb * 0.8, across) * (1.0 - smoothstep(rb * 0.98, rb * 1.06, across));
      float housing = smoothstep(rb * 1.1, rb * 1.4, across) * (1.0 - smoothstep(G.w * 0.85, G.w, across));
      I = ring * (0.1 + 0.6 * L) + housing * 0.2 * L;
      surf = 0.22;
    } else if (effect == 4) { // grille d'évacuation : air chaud, orange puis rouge
      float n = vnoise(vec2(lp.x * 7.0, lp.y * 1.6 + phase * 0.5));
      col = ramp(uRamp, 5.0, 0.2 + 0.8 * L);
      I = L * (0.45 + 0.9 * n) * (0.6 + 0.4 * lp.y) * 1.6;
      surf = 0.35;
    } else if (effect == 5) { // caloduc : chaleur émise par la puce, qui court vers les ventilateurs
      float total = G.w, o0 = prm.w * total;
      float d = abs(sAlong - o0), dn = d / max(total * max(prm.w, 1.0 - prm.w), 1e-4);
      float g = mix(1.0, 0.5, dn);
      float pulse = pow(0.5 + 0.5 * cos(6.2832 * (d * 3.5 - phase * 0.6)), 2.0);
      float prof = exp(-across * across * 2.2);
      col = ramp(uRamp, 3.0, clamp(L * g * 1.05, 0.0, 1.0));
      I = prof * (0.03 + L * g * (0.45 + 0.85 * pulse * uMotion + 0.4 * (1.0 - uMotion)));
      surf = 0.6;
    } else if (effect == 6) { // plaque : chaleur montante
      float g = mix(1.0, 0.45, lp.y);
      float shimmer = vnoise(vec2(lp.x * 2.5, lp.y * 3.0 - phase * 0.35));
      col = ramp(uRamp, 3.0, clamp(L * (0.55 + 0.45 * g), 0.0, 1.0));
      I = L * g * (0.55 + 0.45 * shimmer) * 0.7;
      surf = 0.3;
    } else if (effect == 7) { // alimentation : l'énergie afflue vers la puce principale
      // x : progression vers la puce (0 au bord opposé, 1 côté puce).
      float x = prm.w > 0.5 ? 1.0 - lp.x : lp.x;
      // Vagues larges et continues (cosinus : aucun saut quand un cycle recommence, contrairement à
      // une bande qui repartait du bord), qui avancent vers la puce à la vitesse de la puissance
      // consommée et se renforcent en l'approchant : la lumière alimente la puce.
      float wave = pow(0.5 + 0.5 * cos(6.2832 * (x * 1.3 - phase * 0.5)), 2.0);
      float g = mix(0.55, 1.0, smoothstep(0.0, 1.0, x));
      I = 0.04 + L * g * (0.35 + 0.9 * wave * uMotion + 0.3 * (1.0 - uMotion));
      surf = 0.25;
    } else if (effect == 8) { // stockage : scintillement proportionnel aux E/S
      float sh = vnoise(lp * vec2(3.0, 2.0) + vec2(phase * 0.12, phase * 0.05));
      I = 0.05 + L * 0.35 + L * 0.65 * smoothstep(0.35, 0.85, sh);
      surf = 0.45;
    } else if (effect == 9) { // batterie : remplissage, flux de charge, alerte
      float fill = aux;
      float y = 1.0 - lp.y;
      float filled = 1.0 - smoothstep(fill - 0.015, fill + 0.015, y);
      float line = exp(-pow((y - fill) * 22.0, 2.0)) * step(0.01, fill) * step(fill, 0.985);
      float flow = an.y * filled * pow(0.5 + 0.5 * sin(y * 5.0 - phase * 0.7), 3.0);
      col = an.z > 0.5 ? ramp(uRamp, 6.0, lp.x) : board;
      I = 0.03 + filled * (0.14 + 0.1 * an.z * (0.5 + 0.5 * sin(uTime * 2.0))) + line * 0.12 + flow * 0.5;
      surf = 0.3;
    } else if (effect == 10) { // nappe : flux lumineux continu le long du chemin
      float total = G.w, sn = sAlong / max(total, 1e-4);
      // Flux continu, sans paquets ni bord net : deux couches de bruit lisse glissent vers le bas à
      // des vitesses différentes, leurs courants s'étirent et se fondent l'un dans l'autre.
      // Échelle en longueur absolue : même rythme sur la nappe Pro (courte) et celle de l'Air.
      float x = sAlong * 18.0;
      float a = vnoise(vec2(x - phase * 1.4, across * 0.9 + 1.7));
      float b = vnoise(vec2(x * 0.45 - phase * 0.8 + 5.3, across * 0.6 + 9.1));
      float flow = smoothstep(0.25, 0.85, a * 0.6 + b * 0.4);
      float prof = exp(-across * across * 1.3);
      col = ramp(uRamp, 0.0, 0.85 - sn * 0.7);
      I = 0.04 + L * 0.18 + prof * (0.06 + 0.25 * L + flow * (0.15 + 0.75 * L)) * uMotion + (1.0 - uMotion) * L * 0.3;
      surf = 0.45;
    } else if (effect == 11) { // haut-parleur : pulsation concentrique
      vec2 q = (lp - 0.5) * 2.0;
      float r = length(q);
      float rings = 0.5 + 0.5 * sin(r * 7.0 - phase * 0.6);
      I = L * (0.2 + 0.75 * rings * (1.0 - smoothstep(0.3, 1.1, r)));
      surf = 0.35;
    } else if (effect == 12) { // trackpad et capteurs : activité du pointeur
      I = 0.03 + L * 0.85;
      surf = 0.4;
    } else if (effect == 13) { // ports : adaptateur secteur
      I = 0.03 + L * 0.3;
      surf = 0.3;
    } else if (effect == 14) { // contrôleur : jour (chaud) ou nuit (spectre)
      vec3 day = ramp(uRamp, 7.0, lp.x), night = ramp(uRamp, 1.0, (lp.x + lp.y) * 0.5);
      col = mix(night, day, L);
      I = 0.32 + 0.06 * sin(phase);
      surf = 0.35;
    } else if (effect == 15) { // réseau : scintillement selon le débit
      float sh = vnoise(lp * vec2(3.0, 2.0) + vec2(phase * 0.15, 0.0));
      I = 0.04 + L * (0.3 + 0.9 * smoothstep(0.4, 0.9, sh));
      surf = 0.45;
    } else {
      I = L;
    }

    I += hover * 0.5 + imp * 1.6;
    float w = I * m * (an.w > 0.5 ? 1.0 : 1.0 - occ);
    acc += col * w;
    surfW += surf * w;
    wSum += w;
  }

  // Ondulations des clics : une onde qui allume les pistes au passage.
  for (int k = 0; k < MAXRIPPLE; k++) {
    if (k >= uRippleCount) break;
    vec4 rp = uRipple[k];
    float d = length(P - rp.xy), rad = rp.z * 0.22;
    float ring = exp(-pow((d - rad) / 0.01, 2.0)) * rp.w * exp(-rp.z * 1.6);
    acc += board * ring * 1.4;
  }

  o = vec4(acc * uOut, surfW / wSum);
}`;

// ------------------------------------------------------------------ bloom

export const FS_BRIGHT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uMaps, uField;
uniform float uDetailK, uEdgeK, uLod, uHasParts;
uniform vec2 uLevels;
in vec2 vImg; in vec2 vScr;
out vec4 o;
void main() {
  vec4 m = textureLod(uMaps, vImg, uLod);
  vec4 f = texture(uField, vScr);
  float l = clamp((m.r - uLevels.x) / (uLevels.y - uLevels.x), 0.0, 1.0);
  float det = max(0.0, (m.g - 0.5) * 2.0), edge = smoothstep(0.05, 0.7, m.b);
  float mask = uDetailK * det * 2.0 + uEdgeK * edge + f.a * (0.15 + 0.85 * l) * 1.5;
  o = vec4(f.rgb * mask * mix(1.0, m.a, uHasParts), 1.0);
}`;

export const FS_BLUR = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uDir; // pas en coordonnées de texture
in vec2 vScr;
out vec4 o;
void main() {
  vec3 c = texture(uSrc, vScr).rgb * 0.2270270;
  c += (texture(uSrc, vScr + uDir * 1.3846153).rgb + texture(uSrc, vScr - uDir * 1.3846153).rgb) * 0.3162162;
  c += (texture(uSrc, vScr + uDir * 3.2307692).rgb + texture(uSrc, vScr - uDir * 3.2307692).rgb) * 0.0702703;
  o = vec4(c, 1.0);
}`;

// ------------------------------------------------------------------ composition finale

export const FS_COMP = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uMaps, uField, uBloom, uRamp, uParts;
uniform vec2 uLevels, uPartsSize;
uniform vec4 uCover;
uniform float uGamma, uExposure, uAmbient, uDetailK, uEdgeK, uBloomK, uGrain, uVignette, uTime, uAspect, uIn, uAurora, uMotionK, uHasParts;
uniform vec4 uFan[2];     // centre (unités de largeur), rayon des ailettes, angle
uniform vec4 uFanBlur[2]; // étendue angulaire du flou, nombre d'échantillons
in vec2 vImg; in vec2 vScr;
out vec4 o;
${COMMON}

vec4 maps(vec2 uv) {
  vec4 m = texture(uMaps, uv);
  vec2 P = vec2(uv.x, uv.y * uAspect);
  for (int k = 0; k < 2; k++) {
    vec4 F = uFan[k];
    vec2 d = P - F.xy;
    float r = length(d);
    if (F.z <= 0.0 || r > F.z + 0.002) continue; // appareil sans ventilateur (Air)
    int n = int(uFanBlur[k].y + 0.5);
    vec4 acc = vec4(0.0);
    for (int s = 0; s < 16; s++) {
      if (s >= n) break;
      float a = F.w + uFanBlur[k].x * ((float(s) + 0.5) / float(n) - 0.5);
      float c = cos(a), sn = sin(a);
      vec2 q = F.xy + vec2(c * d.x + sn * d.y, -sn * d.x + c * d.y);
      acc += texture(uMaps, vec2(q.x, q.y / uAspect));
    }
    m = mix(m, acc / float(n), 1.0 - smoothstep(F.z - 0.0012, F.z + 0.0012, r));
  }
  return m;
}

// Pièce d'une zone de carte : la lumière est lue au centre de la pièce, qui s'allume d'un bloc
// (une puce entière, une bille BGA) au lieu d'être traversée par un dégradé de zone.
// Les pièces reçoivent un peu plus de lumière : le circuit nu qui les entoure n'en porte plus.
float partGain = 1.0;
vec2 fieldUV() {
  if (uHasParts < 0.5) return vScr;
  vec3 q = floor(texture(uParts, vImg).rgb * 255.0 + 0.5);
  if (q.b < 127.5) return vScr;                         // hors pièce
  partGain = 1.35;
  float hi = q.b - 128.0, cxHi = mod(hi, 16.0), cyHi = floor(hi / 16.0);
  if (cxHi > 13.5) return vScr;                         // très grande pièce : lumière lue sur place
  vec2 c = (vec2(q.r + 256.0 * cxHi, q.g + 256.0 * cyHi) + 0.5) / uPartsSize;
  return vScr + vec2(c.x - vImg.x, vImg.y - c.y) / uCover.xy;
}

void main() {
  vec4 m = maps(vImg);
  float l = clamp((m.r - uLevels.x) / (uLevels.y - uLevels.x), 0.0, 1.0);
  float lg = pow(l, uGamma);
  vec3 base = mix(vec3(lg), ramp(uRamp, 4.0, lg), uAmbient) * uExposure;

  vec4 f = texture(uField, fieldUV());
  f.rgb *= uIn;
  float det = max(0.0, (m.g - 0.5) * 2.0), edge = smoothstep(0.05, 0.7, m.b);
  // La lumière colore les surfaces (verre, métal) plus que les arêtes : moins « circuit néon ».
  float mask = uDetailK * det * 2.0 + uEdgeK * edge + f.a * (0.3 + 0.7 * lg) * 1.7;
  // Circuit imprimé nu d'une zone de carte (alpha 0) : aucune lumière, seules les pièces brillent.
  vec3 em = f.rgb * mask * mix(1.0, m.a, uHasParts) * partGain;
  vec3 col = base + em + texture(uBloom, vScr).rgb * uBloomK;

  // Aurore : deux lumières colorées très douces venues des coins, qui dérivent lentement.
  // Elles éclairent surtout le métal (pondération par la luminance), comme un éclairage de studio.
  float ta = uTime * 0.035 * uMotionK;
  vec2 ca = vec2(0.10 + 0.08 * sin(ta), 0.06 + 0.06 * cos(ta * 1.3));
  vec2 cb = vec2(0.90 + 0.06 * cos(ta * 0.9), 0.94 + 0.05 * sin(ta * 1.1));
  vec2 da = (vScr - ca) * vec2(1.0, 0.7), db = (vScr - cb) * vec2(1.0, 0.7);
  vec3 aur = ramp(uRamp, 0.0, 0.45) * exp(-dot(da, da) * 3.0) + ramp(uRamp, 0.0, 0.85) * exp(-dot(db, db) * 3.0);
  col += aur * uAurora * (0.35 + 0.65 * lg);

  // Coude doux : les hautes lumières saturent sans écrêter brutalement.
  vec3 k = vec3(0.75);
  col = mix(col, k + (1.0 - k) * (1.0 - exp(-(col - k) / (1.0 - k))), step(k, col));

  vec2 c = vScr - 0.5;
  col *= 1.0 - uVignette * pow(clamp(length(c * vec2(1.0, 0.8)) * 1.35, 0.0, 1.0), 2.4);
  col += (hash12(gl_FragCoord.xy + fract(uTime) * 517.0) - 0.5) * uGrain;
  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;
