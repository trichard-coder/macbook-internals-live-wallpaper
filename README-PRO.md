# Fond d'écran vivant, version MacBook Pro

Une seule image sombre et monochrome de l'intérieur d'un MacBook Pro, colorisée et animée par le code (WebGL2) selon l'usage réel de la machine : CPU, GPU, mémoire, disque, réseau, batterie, audio, ventilateurs, chaleur.

Le fond est **purement passif** : il représente l'activité du Mac en temps réel, sans aucune interaction au clic, au survol ou à la molette (choix de l'utilisateur). Seul l'éditeur de zones (`?debug=1`) utilise la souris.

![Repos, thème rainbow](docs/pro-captures/repos-rainbow.webp)

Autres captures dans [docs/pro-captures/](docs/pro-captures/) : les quatre thèmes au repos, l'état en charge, le rendu en direct pendant une boucle CPU et la superposition des zones sur l'image.

## Installation

```sh
npm install              # sharp, vite, vite-plugin-singlefile (déjà présents pour la version Air)
npm run prepare:pro      # génère les cartes de assets/pro/ depuis l'image source
npm run build:pro        # vérifie les types, construit dist-pro/ et dist-pro-single/
```

`prepare:pro` cherche l'image source (suffixe image_7) dans cet ordre : argument de la commande, variable `PRO_SOURCE`, `assets/pro/src/image_7.png`, la racine du projet, `~/Downloads`, `~/Desktop`. Une copie est faite dans `assets/pro/src/` ; l'original n'est jamais modifié.

## Lancement

### Application native (recommandé sur ce Mac, sans Plash)

Plash n'est pas installable sans identifiant Apple. Une petite application native (AppKit + WKWebView, compilée sur place sans Xcode) le remplace :

```sh
npm run app:pro          # compile et installe ~/Applications/MBP Wallpaper.app
open -a "MBP Wallpaper"
```

- Une fenêtre par écran, au niveau du bureau (sous les icônes), transparente aux clics.
- Elle démarre `server/telemetry-pro.mjs` (port 8788) s'il ne tourne pas déjà, et le relance en cas d'arrêt. Journal : `~/Library/Logs/MBP Wallpaper.log`.
- Menu (icône de ventilateur dans la barre des menus) : thème, sur tous les écrans, économie d'énergie (12 i/s), ouverture à l'ouverture de session (LaunchAgent `local.mbp-wallpaper.app`), recharger, éditeur de zones, quitter.
- **Cohabitation avec la version Air** : tant que « MBA Wallpaper » est ouverte, l'application Pro reste en pause sans fenêtre (deux fonds se superposeraient), et reprend automatiquement à la fermeture d'Air. Le menu propose « Utiliser le fond Pro (quitte MBA Wallpaper) » pour basculer.

### Développement

```sh
npm run telemetry:pro    # télémétrie sur http://localhost:8788 (sert aussi dist-pro/)
npm run dev:pro          # serveur Vite sur http://localhost:5174/pro.html (port strict)
```

### Plash (si disponible)

- Avec le serveur : `http://localhost:8788/pro.html` (build) ou `http://localhost:5174/pro.html` (développement).
- Sans serveur web : le fichier unique `dist-pro-single/pro.html` (images en base64, aucune texture chargée depuis `file://`). Il se connecte à `http://localhost:8788/telemetry` ; sans serveur, une simulation réaliste prend le relais.

## Paramètres d'URL

| Paramètre | Effet |
| --- | --- |
| `theme=rainbow\|warm\|sunset\|mono\|auto` | palette (défaut rainbow ; auto : warm le jour, rainbow la nuit) |
| `debug=1` | éditeur de zones |
| `telemetry=<url>\|sim\|off` | source des mesures (sim ou off : simulation locale) |
| `fps=10..30` | cadence au repos (défaut 24) |
| `quality=0.4..1` | résolution du canevas par rapport aux cartes |
| `gamma=0.5..1.5` | surcharge du gamma du profil |
| `motion=reduce` | force le mouvement réduit |
| `static=1` et `level=0..1` | image figée pour les captures, toutes les zones forcées au niveau donné |

## Principe du rendu

1. `scripts/prepare-pro-image.mjs` (sharp) produit dans `assets/pro/` : `lum.webp` (luminance), `detail.webp` (passe-haut signé, 128 = neutre), `edges.webp` (Sobel), `base.webp` (version couleur, largeur max 2880 px) et `meta.json` (points noir et blanc).
2. Au chargement, les trois cartes sont assemblées dans une seule texture RGBA mipmappée.
3. À chaque image (`src/pro/shaders.ts`) :
   - **champ** (1/4 de résolution) : couleur émissive de chaque zone selon son signal, son effet et la palette ;
   - **bloom** (1/4) : émissif x (détails + contours) puis flou gaussien séparable ;
   - **composition** (pleine résolution) : niveaux et gamma, gradient map de la luminance, rotation des ventilateurs, émissif appliqué sur les pistes et les arêtes (pas en aplat), bloom, grain, vignette.
4. Les palettes sont des rampes de couleurs dans une texture 256 x 8 (`src/pro/themes.ts`) : couleur de la carte de gauche à droite, spectre des puces, chaleur, ambiance, évacuation (orange puis rouge), alerte, jour.

## Zones et signaux

Le profil `profiles/pro.json` décrit chaque zone : forme (`rect`, `circle`, `path`, `frame`, polygone optionnel), effet visuel et signal. Coordonnées normalisées `[x0, x1, y0, y1]` ; les rayons et largeurs sont en fraction de la largeur de l'image.

| Zone | Signal | Réaction |
| --- | --- | --- |
| `die_top` | CPU (os.cpus, processus le plus actif, ligne de base adaptative) | émissif et teinte qui glisse du froid vers le chaud |
| `die_bottom` | GPU (ioreg IOAccelerator, « Device Utilization % ») | idem |
| `die_top_frame`, `die_bottom_frame` | pression mémoire (vm_stat) | lueur du cadre |
| `fan_left`, `fan_right` | régime des ventilateurs | rotation du disque, flou de rotation croissant, anneau lumineux |
| `vent_left`, `vent_right` | air chaud (chaleur x ventilation) | grilles orange puis rouge, scintillement montant |
| `heatpipe`, `heat_link` | chaleur simulée (intégration de la charge) | flux de chaleur des puces vers les ventilateurs |
| `heat_plate_*` | chaleur | chaleur montante |
| `power_left`, `power_right` | puissance (SystemLoad ou tension x courant) | balayage lumineux |
| `nand` | E/S disque (iostat) | scintillement |
| `bat_*` (6 cellules) | niveau de batterie (pmset) | remplissage une à une, flux en charge, rouge si faible |
| `flex_center`, `trackpad`, `sensor_*` | activité globale | particules et lueur |
| `speaker_*` | lecture audio et volume | pulsation concentrique |
| `ports_*`, `magsafe` | adaptateur secteur | lueur, impulsion et onde au branchement |
| `control_top` | heure locale | chaud le jour, spectre la nuit |
| `network_cluster` | débit réseau (netstat -ib) | scintillement |

**Choix narratif** : les deux puces centrales ne sont pas identifiées avec certitude sur l'image. La puce du haut est traitée comme le CPU et celle du bas comme le GPU. L'attribution se change dans `profiles/pro.json` (`"narrative": { "die_top": "cpu", "die_bottom": "gpu" }`) ou dans l'éditeur.

Lissage côté client : montée rapide (0,35 s), descente lente (2,2 s). Ventilateurs : inertie de 1,5 s en accélération, 4 s en décélération.

## Réglage des zones (`?debug=1`)

Ouvrir `http://localhost:8788/pro.html?debug=1` (ou via le menu de l'application, ou sur le port 5174 en développement).

- Glisser une zone pour la déplacer ; poignées carrées pour la redimensionner ; poignées rondes jaunes pour le trou d'un cadre.
- Ventilateurs : poignées de rayon (ailettes, moyeu, carter).
- Chemins (caloduc, nappe) et polygones : glisser un sommet, cliquer un point milieu pour en ajouter, Alt + clic ou double-clic pour en retirer. Curseurs de largeur et d'origine du flux.
- Curseurs : intensité forcée de chaque zone (clic sur la valeur pour revenir à la télémétrie), régime des ventilateurs, thème, gamma, exposition, bloom, détails, contours, grain, vignette, attribution CPU / GPU.
- « Tester chaque zone » allume les zones une à une.
- « Exporter » réécrit `profiles/pro.json` via le serveur (`POST /__profile-pro`) ; sans serveur, le fichier est téléchargé. Relancer `npm run build:pro` pour le build statique et l'application.
- Clavier : flèches (Maj x10), H masque le panneau, Z masque les zones, Échap désélectionne.

## Mode powermetrics

```sh
sudo node server/telemetry-pro.mjs --powermetrics
```

Lit `powermetrics --samplers smc,cpu_power,gpu_power` : vraie vitesse des ventilateurs (si l'échantillonneur smc existe) et puissances CPU / GPU, affichées dans l'éditeur. Sur la plupart des Mac Apple Silicon, l'échantillonneur smc n'existe pas : le serveur relance alors powermetrics avec `cpu_power,gpu_power` seulement et garde l'estimation du régime. Bornes de régime : variables `FAN_MIN_RPM` et `FAN_MAX_RPM`.

Sans ce mode, le régime est **estimé** : charge CPU + GPU lissée sur 20 s (un processus qui sature un cœur compte, même noyé dans la moyenne) et pression thermique (`pmset -g therm`).

## Sobriété énergétique

- 24 i/s au repos, 60 i/s pendant une interaction de l'éditeur, 4 i/s en mouvement réduit (`prefers-reduced-motion`), arrêt complet quand la page est masquée (y compris le flux SSE).
- Le serveur arrête d'échantillonner 10 s après le départ du dernier client.
- devicePixelRatio plafonné à 2, et résolution plafonnée à celle des cartes (2880 px).
- Au repos, le champ émissif et le bloom ne sont recalculés qu'une image sur deux.

Mesures (Chrome headless, build de production, M4 Pro) : environ 7 à 9 % d'un cœur au repos à 24 i/s (dont environ 5 % pour le processus GPU de Chrome, qui présente chaque image), environ 5 % à 12 i/s, environ 3 % en mouvement réduit. Le serveur de télémétrie coûte moins de 1 %. **L'objectif de 5 % n'est donc pas atteint à 24 i/s** dans ces mesures ; l'option « Économie d'énergie » de l'application (12 i/s) s'en approche. La mesure dans le vrai WKWebView reste à faire (la session Air a constaté que les mesures headless sont trompeuses).

## Limites connues

- Pas d'interaction souris dans le fond (voulu). Plash, de toute façon, ne transmet pas la souris en mode normal.
- Régime des ventilateurs estimé sans droits administrateur (pas d'accès SMC sur Apple Silicon).
- Sur un écran 60 Hz, la cadence de 24 i/s est arrondie à 20 i/s par la synchronisation d'affichage ; sur un écran ProMotion elle est respectée.
- Les applications Air et Pro ne doivent pas afficher leur fond en même temps : l'application Pro se met en pause d'elle-même, mais l'application Air n'a pas d'équivalent.
- Le profil exporté n'est pris en compte par l'application qu'après `npm run build:pro` (elle sert le build).

## Fichiers

`pro.html`, `src/pro/` (moteur, shaders, signaux, simulation, éditeur), `profiles/pro.json`, `assets/pro/`, `scripts/prepare-pro-image.mjs`, `scripts/build-mac-pro-app.sh`, `mac-pro/`, `server/telemetry-pro.mjs`, `server/profile-pro-io.mjs`, `vite.pro.config.ts`, `tsconfig.pro.json`. Voir aussi [docs/HANDOFF-PRO.md](docs/HANDOFF-PRO.md).
