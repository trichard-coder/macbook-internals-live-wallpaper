# MacBook Air, version classique (Canvas 2D)

> **Note.** La version MacBook Air par défaut tourne désormais sur le moteur WebGL commun avec la version Pro (`air.html`, `npm run build:air`, application MBA Wallpaper) : voir [README-PRO.md](README-PRO.md). Ce document décrit la version d'origine en Canvas 2D (`index.html`), qui révèle les sept calques pré-colorés par l'auteur ; elle reste disponible avec `npm run build` puis `npm run telemetry` (port 8787).

> Illustrations : © [Basic Apple Guy](https://www.basicappleguy.com/basicappleblog/m4-macbook-air-internals-13-inch). Le dépôt fournit les calques optimisés (`assets/opt/*.webp`), suffisants pour tout construire. Les PNG originaux (`assets/src/`) ne sont pas versionnés : téléchargez-les sur son blog si vous voulez relancer `npm run analyze-images` ou régénérer les WebP. Retour au [README principal](README.md).

Fond d'écran vivant pour macOS, affiché par une petite application native fournie (`mac/`) ou par [Plash](https://sindresorhus.com/plash), toutes deux basées sur WKWebView. La vue intérieure d'un MacBook Air s'illumine composant par composant selon l'activité réelle de la machine (CPU, GPU, mémoire, disque, réseau, batterie, puissance, chaleur, audio, utilisation du clavier et du trackpad). Le fond est entièrement passif : aucun clic ni survol n'est nécessaire, il se contente de refléter l'usage du Mac en temps réel.

- Rendu : Vite + TypeScript, Canvas 2D, sans framework UI.
- Télémétrie : `server/telemetry.mjs`, Node.js sans aucune dépendance externe, flux SSE à 1 ou 2 Hz.
- Deux builds : statique servi en `http://localhost` (`dist/`) et fichier unique avec images en base64 (`dist-single/index.html`).

## Les images

`npm run analyze-images` vérifie les dimensions, les empreintes, l'alignement pixel à pixel (corrélation des contours entre calques, recherche du meilleur décalage sur ±3 px) et propose un masque pour la puce.

Résultats :

- Les 7 images font **2560 x 1664 px** (ratio 1,5385), et non 2380 x 1547 comme prévu au départ.
- Toutes sont alignées au pixel près : le meilleur décalage est (0, 0) pour chaque calque, avec une corrélation des contours de 0,97 à 0,99.
- **image_9 et image_10 sont identiques octet pour octet** (même MD5). On garde `mono-a` (image_10) ; `mono-b` (image_9) est redondant, conservé dans `assets/src` mais exclu des images optimisées et du build.

| Fichier d'origine | Nom sémantique | Rôle | Signature mesurée (lum. / sat. / gauche, centre, droite) |
|---|---|---|---|
| image (13).png | `base-dark` | **Calque de base**, toujours visible | 0,120 / 0,192 / bleu-gris uniforme |
| image (12).png | `rainbow-high` | État « charge maximale » (thème rainbow) | 0,138 / 0,376 / orange-magenta, vert, cyan |
| image (11).png | `rainbow-mid` | État « charge moyenne » (thème rainbow) | 0,114 / 0,362 / rouge, jaune, cyan |
| image (14).png | `warm` | Thème warm (calque haut), jour du connecteur d'écran | 0,309 / 0,226 / rouge, rouge, magenta |
| image (8).png | `sunset` | Thème sunset, calque moyen du thème warm, batterie faible | 0,114 / 0,429 / orange, rouge, magenta |
| image (10).png | `mono-a` | Thème mono (base et révélation par éclaircissement) | 0,097 / 0,018 / neutre |
| image (9).png | `mono-b` | Redondant (identique à mono-a) | identique |

`npm run optimize-images` (lancé aussi par `npm run build`) produit les WebP de `assets/opt` (largeur max 2880 px, donc 2560 ici) : 1 Mo au total pour les 6 calques utiles, contre 31 Mo en PNG.

Suggestion automatique du masque de la puce (seuillage de saturation dans `rainbow-high`, composante connexe autour du centre présumé) : `x0 0,484  x1 0,575  y0 0,243  y1 0,328`, écrite dans `assets/analysis/soc-mask.png`. Elle ne couvre que le die coloré, pas la mémoire unifiée en haut du boîtier : la zone `soc` garde donc le rectangle du boîtier entier, et la suggestion est stockée dans `core` pour centrer la lueur incandescente. `node scripts/analyze-images.mjs --write` remplace le rectangle de la zone par la suggestion si vous préférez.

## Installation

Prérequis : macOS, Node.js 20 ou plus récent.

```sh
npm install
npm run build          # dist/ et dist-single/index.html
npm run telemetry      # sert dist/ et le flux sur http://localhost:8787
```

Ouvrez http://localhost:8787 dans un navigateur pour vérifier.

### Scripts

| Commande | Rôle |
|---|---|
| `npm run dev` | Serveur de dev Vite (http://localhost:5173), avec proxy vers la télémétrie et endpoint d'export des zones |
| `npm run build` | Optimise les images, vérifie les types, construit `dist/` puis `dist-single/index.html` |
| `npm run telemetry` | Serveur de télémétrie et de fichiers statiques (port 8787) |
| `npm run analyze-images` | Analyse des calques (voir plus haut) |
| `npm run optimize-images` | Génère les WebP (`--force` pour tout régénérer) |

En développement, lancez `npm run telemetry` et `npm run dev` dans deux terminaux.

### Options du serveur

```sh
node server/telemetry.mjs --port 8787 --hz 2 --verbose
node server/telemetry.mjs --sim        # tout simuler (démo, autre machine)
```

Variables équivalentes : `PORT`, `HOST`, `TELEMETRY_HZ`, `TELEMETRY_SIM=1`.

## Affichage en fond d'écran : application MBA Wallpaper (sans Plash)

Plash n'est disponible que sur l'App Store, donc inaccessible sans identifiant Apple (cas d'un Mac professionnel). Le projet fournit son propre remplaçant, une petite application native compilée sur place avec les outils en ligne de commande d'Apple (`swiftc`) : ni Xcode, ni compte Apple, ni droits administrateur.

```sh
npm run build   # si ce n'est pas déjà fait
npm run app     # compile et installe ~/Applications/MBA Wallpaper.app
open ~/Applications/MBA\ Wallpaper.app
```

Ce que fait l'application (`mac/main.swift`) :

- une fenêtre par écran, placée au niveau du bureau : sous les icônes et les fenêtres, présente sur tous les bureaux (Spaces), transparente aux clics ;
- elle charge `http://localhost:8787/` dans un WKWebView (le même moteur que Plash) ;
- elle démarre elle-même le serveur de télémétrie s'il ne tourne pas, et le relance s'il s'arrête (vérification toutes les 10 s) ; journal dans `~/Library/Logs/MBA Wallpaper.log`. Inutile donc de garder un Terminal ouvert ;
- icône dans la barre des menus (puce) : thème, « Sur tous les écrans », « Ouvrir à l'ouverture de session » (crée ou retire `~/Library/LaunchAgents/local.mba-wallpaper.app.plist`), « Recharger », « Éditeur de zones » (ouvre `?debug=1` dans le navigateur), « Quitter » ;
- pas d'icône dans le Dock.

Le chemin du projet et celui de Node sont figés à la compilation : si vous déplacez le dossier, relancez `npm run app`.

### Avec Plash (si vous avez un compte Apple)

1. `npm run build`, puis `npm run telemetry` (à laisser tourner).
2. Dans Plash : *Add Website*, URL `http://localhost:8787/` (avec paramètres éventuels, par exemple `http://localhost:8787/?theme=sunset`). Laissez *Browsing Mode* désactivé : le fond n'a besoin d'aucune interaction.

Variante : le fichier `dist-single/index.html`, avec les images embarquées en base64, ce qui contourne le blocage des textures en `file://`. Sans serveur, la page bascule sur la simulation ; ajoutez `?telemetry=sim` pour ne même pas tenter la connexion.

## Paramètres d'URL

| Paramètre | Effet |
|---|---|
| `?theme=rainbow` | Thème par défaut : base sombre, révélation rainbow-mid puis rainbow-high |
| `?theme=warm` | Révélation sunset puis warm |
| `?theme=sunset` | Révélation sunset, renforcée en mode additif à forte intensité |
| `?theme=mono` | Base mono-a, composants révélés par éclaircissement, sans couleur |
| `?theme=auto` | warm le jour, rainbow la nuit (heure locale) |
| `?debug=1` | Éditeur de zones, curseurs de forçage, statistiques |
| `?telemetry=sim` (ou `off`) | Simulation locale, aucune connexion |
| `?telemetry=<url>` | Autre adresse de flux SSE |
| `?quality=0.5..1.5` | Résolution du canevas par rapport à l'image source (1 par défaut) |
| `?fps=10..30` | Plafond de cadence au repos |
| `?motion=reduce` | Force le mode mouvement réduit |

## Principe de rendu

1. Le calque de base est pré-rendu une fois par redimensionnement, recadré en « cover » (échelle `max(largeur/2560, hauteur/1664)`, centré, sans déformation).
2. Pour chaque zone et chaque calque coloré, un **sprite** est découpé une fois pour toutes à travers un masque aux bords adoucis (rectangle ou polygone, flou en boîte à 3 passes, équivalent gaussien). Les sprites sont construits à la demande, à la résolution d'affichage.
3. À chaque image, l'intensité de chaque zone (0 à 1) est lissée par interpolation exponentielle (constante propre à chaque composant : 0,25 s pour la mémoire, 4 s pour la chaleur), puis le sprite `mid` est dessiné avec une opacité `smoothstep(0; 0,5)` et le sprite `high` avec `smoothstep(0,42; 1)`.
4. Seuls les rectangles des zones dont l'apparence change sont redessinés (dirty rects, découpage par `clip`). Chaque effet fournit une clé visuelle quantifiée : si elle ne change pas, rien n'est redessiné.

Effets : pulsation, balayage lumineux le long des composants de l'étage d'alimentation, particules sur la nappe centrale, diffusion de chaleur depuis la puce vers la plaque, ondes Wi-Fi, ondulation du Taptic Engine quand vous reprenez le clavier après une pause, impulsion des ports au branchement du secteur, remplissage et flux de charge des batteries.

## Signaux et réactions

| Zone | Source (serveur) | Réaction |
|---|---|---|
| `soc` | `os.cpus()` (delta entre deux mesures), `ps` (processus le plus actif), `ioreg -r -c IOAccelerator` (« Device Utilization % ») | Révélation rainbow-mid puis rainbow-high, teinte qui glisse du froid au chaud, cœur incandescent, pulsation qui accélère avec la charge |
| `memory_nand` | `vm_stat` (mémoire app + câblée + compressée), `iostat -Id` (delta des Mo transférés) | Intensité selon la pression mémoire, scintillement à 14 Hz proportionnel aux E/S |
| `power_stage` | `ioreg -rn AppleSmartBattery` : `SystemPowerIn` / `SystemLoad` (puissance système réelle, sur secteur comme sur batterie), sinon tension x courant, sinon proxy CPU / GPU | Intensité logarithmique de 5 à 60 W, balayage lumineux au-delà d'environ 17 W |
| `battery_*` | `pmset -g batt` (+ `ExternalConnected` d'ioreg) | Les cellules se remplissent jusqu'au niveau de charge, flux animé pendant la charge, calque sunset et pulsation sous 20 % |
| `thermal_plate` | `pmset -g therm`, `notifyutil -g com.apple.system.thermalpressurelevel`, charge CPU moyenne sur 30 s | Lueur orange qui part du bord proche de la puce et gagne la plaque |
| `speaker_left`, `speaker_right` | `pmset -g assertions` (assertion de coreaudiod), `osascript` (volume, mute) | Pulsation rythmée et ondes depuis la grille pendant la lecture |
| `wifi_bt` | `netstat -ib` (delta des octets des interfaces `en*`) | Intensité et fréquence des ondes selon le débit (échelle logarithmique) |
| `trackpad_taptic` | `ioreg -c IOHIDSystem` (`HIDIdleTime` : temps depuis la dernière action clavier, trackpad ou souris, dans toutes les applications) | S'allume quand vous utilisez le Mac et s'éteint en quelques secondes d'inactivité, ondulation à la reprise après plus de 8 s de pause |
| `flex_cable` | Activité globale (puce, disque, réseau) | Nombre et vitesse des particules |
| `ports_right` | Adaptateur secteur | Lueur constante branché, impulsion qui parcourt les ports au branchement (avec flux vers les batteries) |
| `display_connector` | Heure locale | Calque warm le jour, base sombre la nuit, transitions d'environ 2 h vers 7 h 30 et 19 h 30 |
| `logic_board` | Activité globale | Révélation douce de la carte entière (zone parente) |

Chaque source a son propre rythme (CPU, réseau et activité clavier / trackpad chaque seconde, GPU, disque et processus toutes les 2 s, mémoire et puissance toutes les 5 s, batterie toutes les 10 s, thermique toutes les 15 s ; `osascript`, la commande la plus coûteuse, toutes les 15 s pendant la lecture audio, sinon toutes les 60 s). Une source qui échoue trois fois de suite est remplacée par la simulation, champ par champ (champ `simulated` du flux, visible dans le panneau du mode debug). L'échantillonnage s'arrête 10 s après la déconnexion du dernier client.

Format d'un message : voir `src/types.ts` (`TelemetrySnapshot`), ou http://localhost:8787/telemetry.json.

### Pourquoi la puce réagit à une seule boucle infinie

Une boucle `while :; do :; done` occupe un cœur à 100 %, soit 8 % seulement de la moyenne d'une puce à 12 cœurs. Sur la machine de test, le bruit au repos (applications ouvertes) est du même ordre : 1 à 2 cœurs occupés. La charge perçue combine donc trois indicateurs :

1. le processus le plus actif, hors WindowServer et kernel_task (`ps -A -o %cpu`) : au repos aucun ne dépasse 25 à 30 %, une boucle est à 100 % ;
2. l'excédent de « cœurs occupés » par rapport à une ligne de base adaptative (20e centile sur 10 min, mémorisée dans localStorage pour éviter un faux pic au chargement) ;
3. la moyenne absolue, pour qu'une machine réellement saturée reste au maximum.

Mesure (WebKit, serveur réel) : puce à 0 au repos, 0,98 puis 1,0 entre 3 et 5 s après le lancement de la boucle (processus « bash » à 100 %), retour à 0 quelques secondes après l'arrêt.

## Aucune interaction

Le fond est passif : le canevas ignore la souris (`pointer-events: none`), il n'y a ni survol, ni clic, ni étiquette. Seule l'activité réelle du Mac le fait réagir. Le Taptic Engine reflète votre usage du clavier et du trackpad dans toutes les applications, mesuré par le système, sans que le pointeur ait à passer sur le fond. La souris ne sert que dans l'éditeur de zones du mode `?debug=1`, à ouvrir dans un navigateur.

## Réglage des zones

Les zones sont dans `src/zones.json` : rectangles normalisés `[x0, x1, y0, y1]`, `feather` (largeur du fondu en fraction de la largeur de l'image), et en option `polygon`, `anchor` (origine des effets : grilles des haut-parleurs, die de la puce, Taptic Engine) et `core`. Les valeurs de départ ont été vérifiées par superposition sur les images : elles tombent bien sur les composants. Seuls les points d'ancrage ont été ajoutés.

Ouvrez la page avec `?debug=1` :

- glisser une zone pour la déplacer, les poignées pour la redimensionner, le cercle pour déplacer le point d'ancrage ;
- « Polygone » convertit la zone sélectionnée ; cliquez un point milieu pour ajouter un sommet, Alt + clic ou double-clic pour en retirer un ;
- flèches : ajustement fin (Maj : x10) ; H masque le panneau, Z masque les zones, Échap désélectionne ;
- curseurs : forcent l'intensité de chaque zone (clic sur la valeur pour revenir à la télémétrie), « Tout à 1 », « Tout à 0 », « Libérer » ;
- « Tester chaque zone » illumine les zones une par une ;
- menu Thème : prévisualisation des thèmes ;
- « Exporter » réécrit `src/zones.json` via `POST /__zones` (serveur de dev Vite ou serveur de télémétrie) ; à défaut, le JSON est téléchargé. Après un export, relancez `npm run build` pour le build statique.

Les modifications non exportées sont conservées dans localStorage et ignorées automatiquement si `zones.json` change entre-temps. « Réinitialiser » revient au fichier.

## Choix techniques

- **Canvas 2D, pas de WebGL2.** Une image coûte 0,2 à 0,9 ms de rendu (mesuré dans WebKit), loin du budget de 20 ms qui correspond au seuil de 50 i/s. Le passage à WebGL2 n'est donc pas justifié.
- **Résolution plafonnée à celle de l'image source.** Le canevas ne dépasse pas 1 pixel de canevas par pixel source (2560 x 1663 sur un écran Retina de 14 pouces), le navigateur étire le reste. Agrandir au-delà n'apporterait aucun détail et multiplierait le coût de remplissage.
- **Sprites pré-masqués et rectangles sales** plutôt que des masques recalculés à chaque image. Les dégradés animés (balayage, remplissage, chaleur) sont mis en cache tant que leur position quantifiée ne change pas.
- **Cadence adaptative.** 60 i/s pendant 1,5 s après une impulsion (branchement du secteur, reprise d'activité) ; au repos, la cadence la plus exigeante parmi les animations en cours, plafonnée à 24 i/s (30 si une zone est très active). Les animations lentes se contentent de moins : particules de la nappe à faible activité 12 i/s, respiration de la puce 15 i/s, balayage 15 i/s, scintillement 14 i/s, ondulation thermique 6 i/s. Les simples fondus déclenchés par la télémétrie tournent à 12 i/s, et la boucle s'arrête complètement quand rien ne change. C'est un écart volontaire avec la fourchette « 24 à 30 i/s au repos » : ces animations restent fluides et l'économie d'énergie est nette.
- **Seuils d'animation.** Au repos, seules la nappe et, si la charge le justifie, la puce sont animées. Le balayage d'alimentation, le scintillement disque et l'ondulation thermique ne démarrent qu'au-delà d'une activité significative.
- **Page masquée** (`document.hidden`) : plus aucun rendu et le flux SSE est fermé, donc le serveur cesse aussi d'échantillonner.
- **`prefers-reduced-motion`** (ou `?motion=reduce`) : pas de pulsation, particules, balayage, scintillement ni ondulation ; seuls des fondus lents à 12 i/s.
- **Simulation partagée.** `src/shared/simulation.mjs` est utilisée par le serveur (repli champ par champ) et par la page (serveur injoignable). Elle produit des rafales d'activité, des cycles secteur / batterie de quelques minutes et des sessions audio.
- **Sécurité du serveur.** Il n'écoute que sur 127.0.0.1. Le flux et l'export n'acceptent que les pages locales (origines `localhost`, `127.0.0.1` ou `file://`) : un site web ouvert dans votre navigateur ne peut ni lire la télémétrie ni réécrire `zones.json`. L'export valide la structure du JSON avant d'écrire.
- **Thème mono** : le calque de base devient mono-a et les composants sont révélés par éclaircissement additif, sans aucune couleur, y compris pour le connecteur d'écran.
- **Renfort des composants sombres.** Haut-parleurs, cellules du bas, trackpad, ports et plaque thermique restent presque noirs même dans les calques colorés : ils reçoivent une passe additive, et la plaque une variante teintée orange (mode screen).

## Performance mesurée

Mesures faites avec WebKit headless (Playwright) sur un MacBook Pro M4 Pro, fenêtre 1512 x 982 à 2x, serveur réel, sur 30 s :

| Situation | CPU des processus WebKit | Serveur |
|---|---|---|
| Page vide (référence) | 0,1 % d'un cœur | 0,1 % |
| Plancher : 4 pixels modifiés à 24 i/s sur un canevas de même taille | 7,7 à 8,8 % | |
| Fond d'écran au repos | 8,7 % | 0,8 % |
| Fond d'écran, mouvement réduit | 7,2 % | 0,9 % |

Le WebKit headless compose les canevas en logiciel : même une page qui ne change que quatre pixels coûte déjà 8 % d'un cœur. Le fond d'écran revient à ce plancher, c'est-à-dire que son propre coût est d'environ un point. **Mesure dans l'application réelle** (WKWebView accéléré par le GPU, écran interne seul, 20 s) : environ **14 % d'un cœur** au total (processus WebContent, GPU et application), contre 0 % sans le fond. L'objectif de 5 % n'est donc **pas atteint** à ce jour ; les mesures en WebKit headless étaient trompeuses, et c'est dans l'application qu'il faut mesurer. Pour réduire encore la consommation : `?fps=15`, `?quality=0.75` ou `?motion=reduce`.

Avant optimisation, la fusion des rectangles sales en boîtes englobantes faisait redessiner 78 % de l'écran à chaque image. Les rectangles sont maintenant redessinés séparément : environ 10 % de l'écran par image au repos.

## Limites connues

- Sans serveur de télémétrie (fichier unique seul), WebKit journalise une erreur réseau « Could not connect to the server » à chaque tentative de connexion. Ce n'est pas une erreur JavaScript : la page bascule sur la simulation et espace les tentatives (15 s, 30 s, 60 s... jusqu'à 5 min). `?telemetry=sim` les supprime.
- `pmset -g therm` ne publie souvent rien sur Apple Silicon : la pression thermique vient alors de `notifyutil` (niveaux nominal, moderate, heavy...), complétée par la charge CPU moyenne sur 30 s. La température réelle exige `powermetrics` avec les droits root, ce qui est volontairement exclu.
- La lecture audio est déduite des assertions de coreaudiod : certaines applications qui ne posent pas d'assertion (ou qui en posent une hors lecture) peuvent tromper la détection. Le volume via `osascript` peut valoir « missing value » sur certaines sorties (HDMI, AirPlay) ; la dernière valeur connue est alors conservée.
- `os.cpus()` sous-estime légèrement la charge d'un processus mono-thread qui migre entre les cœurs, d'où l'indicateur « processus le plus actif ».
- Une charge mono-cœur parfaitement constante pendant plus d'une dizaine de minutes finit par être absorbée par la ligne de base des « cœurs occupés » ; l'indicateur « processus le plus actif » la maintient toutefois visible.
- Le connecteur d'écran utilise des heures fixes (lever vers 7 h 30, coucher vers 19 h 30), sans calcul astronomique selon la saison ou la position.
- Après un export de zones, le build statique doit être reconstruit (`npm run build`) pour que Plash affiche les nouvelles zones, sauf si l'éditeur a été utilisé directement dans Plash : la surcharge localStorage s'applique alors jusqu'à la reconstruction.

## Structure

```
assets/src/              PNG d'origine renommés (non versionnés, à télécharger sur le blog)
assets/opt/              WebP optimisés (générés)
scripts/analyze-images.mjs
scripts/optimize-images.mjs
server/telemetry.mjs     serveur SSE + statique + export des zones (sans dépendance)
server/zones-io.mjs      validation et écriture de zones.json
src/main.ts              assemblage, cycle de vie, visibilité, mouvement réduit
src/renderer.ts          rendu Canvas 2D, rectangles sales, cadence
src/sprites.ts           masques adoucis et sprites de zone
src/effects.ts           effets par composant
src/signals.ts           mesures vers intensités des zones
src/telemetry.ts         client SSE avec repli sur simulation
src/debug/               éditeur de zones (?debug=1)
src/shared/simulation.mjs simulation partagée serveur / client
src/zones.json           zones éditables
mac/main.swift           application de fond d'écran (remplaçant de Plash)
mac/Info.plist
scripts/build-mac-app.sh compilation et installation dans ~/Applications
```
