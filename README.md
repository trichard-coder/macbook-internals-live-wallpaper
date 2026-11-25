<div align="center">

# MacBook Internals · Live Wallpaper

**Un fond d'écran macOS qui montre l'intérieur de votre Mac… et le fait vivre au rythme de ce qu'il fait vraiment.**

La puce s'embrase quand le processeur travaille, la batterie se remplit avec la charge, les ondes Wi-Fi suivent le débit, les ventilateurs accélèrent quand ça chauffe.

<img src="docs/images/air-hero.webp" alt="Version MacBook Air pendant une charge CPU : la puce passe en arc-en-ciel incandescent" width="100%">

<sub>Version MacBook Air capturée pendant une vraie boucle CPU. Illustration originale : <a href="https://www.basicappleguy.com/basicappleblog/m4-macbook-air-internals-13-inch">Basic Apple Guy</a>.</sub>

</div>

---

> [!IMPORTANT]
> **Les illustrations ne sont pas de moi.** Les magnifiques vues intérieures des MacBook sont l'œuvre de **[Basic Apple Guy](https://www.basicappleguy.com)**, qui publie depuis des années des fonds d'écran « internals » d'une précision remarquable. Tout est parti de son article **[iPhone 17 Pro Internals Wallpapers](https://basicappleguy.com/basicappleblog/iphone-17-pro-internals-wallpapers)** et de ses séries [MacBook Air 13 pouces](https://www.basicappleguy.com/basicappleblog/m4-macbook-air-internals-13-inch) et [MacBook Pro 14 et 16 pouces](https://www.basicappleguy.com/basicappleblog/macbook-pro-2025-update).
>
> Ce projet n'ajoute que le code qui les anime. Si vous aimez le résultat, allez voir son blog, et **soutenez son travail** en achetant ses packs : c'est lui qui rend tout ça possible.

---

## Deux Mac, deux moteurs

<table>
<tr>
<td width="50%" valign="top">

### MacBook Air
<img src="docs/images/air-themes.webp" alt="Les quatre thèmes de la version Air" width="100%">

- **Canvas 2D**, sept calques pré-colorés par l'auteur
- Chaque composant révèle sa couleur à travers un masque adouci
- Particules sur la nappe, balayage lumineux, diffusion de chaleur
- Pas de ventilateur, comme le vrai : la chaleur rayonne dans la plaque

[Documentation détaillée →](README-AIR.md)

</td>
<td width="50%" valign="top">

### MacBook Pro
<img src="docs/pro-captures/direct-boucle-cpu.webp" alt="Version MacBook Pro pendant une charge CPU : caloduc incandescent et ventilateurs" width="100%">

- **WebGL2**, une seule image sombre colorisée par shaders
- Ventilateurs qui tournent selon la charge, avec un lissage de 20 s
- Caloduc qui chauffe depuis la puce vers les ailettes
- Halo, scintillement, flux sur les nappes

[Documentation détaillée →](README-PRO.md)

</td>
</tr>
</table>

## Ce qui s'allume, et pourquoi

Tout est mesuré **localement**, en temps réel, par un petit serveur Node.js sans aucune dépendance.

| Composant | Ce qu'il reflète | Source macOS |
|---|---|---|
| 🧠 Puce (CPU / GPU) | Charge processeur et graphique, de la teinte froide à l'incandescence | `os.cpus()`, `ps`, `ioreg IOAccelerator` |
| 💾 Mémoire / stockage | Pression mémoire, scintillement selon les entrées / sorties disque | `vm_stat`, `iostat` |
| ⚡ Étage d'alimentation | Puissance consommée par le système, en watts | `ioreg AppleSmartBattery` |
| 🔋 Batteries | Niveau de charge, flux animé pendant la charge, alerte sous 20 % | `pmset -g batt` |
| 🔥 Plaque, caloduc, ventilateurs | Pression thermique et charge soutenue | `pmset -g therm`, `notifyutil` |
| 🔊 Haut-parleurs | Pulsation pendant la lecture audio, selon le volume | `pmset -g assertions`, `osascript` |
| 📶 Wi-Fi / Bluetooth | Débit réseau | `netstat -ib` |
| ⌨️ Trackpad / Taptic Engine | Votre activité au clavier et au trackpad, dans toutes les apps | `ioreg IOHIDSystem` |
| 🔌 Ports | Branchement du secteur | `pmset`, `ioreg` |
| 🖥️ Connecteur d'écran | Jour et nuit, selon l'heure locale | horloge |

Le fond est **entièrement passif** : il ne réagit ni aux clics ni au survol. Il se contente de raconter ce que fait votre Mac.

> Petite astuce de conception : une boucle infinie n'occupe qu'un cœur, soit 8 % de la moyenne sur une puce à 12 cœurs, noyée dans le bruit du repos. La puce surveille donc aussi le processus le plus gourmand et l'excédent par rapport à votre propre ligne de base. Résultat : `while :; do :; done` dans un Terminal suffit à l'embraser en 3 à 5 secondes.

## Démarrage rapide

Prérequis : macOS 13 ou plus récent, [Node.js](https://nodejs.org) 20 ou plus récent, et les outils en ligne de commande d'Apple (`xcode-select --install`). **Pas besoin de Xcode, ni de compte Apple, ni de droits administrateur.**

```sh
git clone https://github.com/trichard-coder/macbook-internals-live-wallpaper.git
cd macbook-internals-live-wallpaper
npm install
```

**Version MacBook Air**

```sh
npm run build        # construit la page
npm run app          # compile et installe ~/Applications/MBA Wallpaper.app
open -a "MBA Wallpaper"
```

**Version MacBook Pro**

```sh
npm run build:pro
npm run app:pro      # compile et installe ~/Applications/MBP Wallpaper.app
open -a "MBP Wallpaper"
```

Une icône apparaît dans la barre des menus : thème, écrans, lancement à l'ouverture de session, quitter. L'application lance et surveille elle-même le serveur de télémétrie, inutile de garder un Terminal ouvert. Les deux applications se laissent la place : une seule affiche son fond à la fois.

<details>
<summary><b>Pourquoi une application maison plutôt que Plash ?</b></summary>

<br>

[Plash](https://sindresorhus.com/plash) est l'outil classique pour afficher une page web en fond d'écran, mais il n'est distribué que sur l'App Store, ce qui exclut les Mac sans identifiant Apple (souvent les Mac professionnels). Le projet embarque donc un remplaçant minimal (`mac/main.swift`, environ 250 lignes) : une fenêtre par écran placée au niveau du bureau, sous les icônes, transparente aux clics, qui affiche la page dans un WKWebView. Elle se compile sur place avec `swiftc`.

Si vous avez Plash, il fonctionne aussi : lancez `npm run telemetry` (Air, port 8787) ou `npm run telemetry:pro` (Pro, port 8788), puis ajoutez `http://localhost:8787/` ou `http://localhost:8788/pro.html` dans Plash.

</details>

## Thèmes et réglages

Choisissez le thème depuis le menu de l'application, ou par paramètre d'URL :

| Thème | Ambiance |
|---|---|
| `rainbow` | Arc-en-ciel saturé, du froid au chaud (par défaut) |
| `warm` | Orange, magenta et violet |
| `sunset` | Ambre et pourpre |
| `mono` | Aucune couleur, simple éclaircissement |
| `auto` | `warm` le jour, `rainbow` la nuit |

D'autres paramètres permettent de régler la cadence (`?fps=`), la résolution (`?quality=`) ou de réduire les animations (`?motion=reduce`, également activé par le réglage d'accessibilité de macOS). Le mode `?debug=1` ouvre un **éditeur de zones** pour ajuster au pixel près la position de chaque composant.

## Comment ça marche

```
 commandes macOS                serveur Node.js               page web                  application native
 (ioreg, pmset, vm_stat,  ──▶   127.0.0.1, sans      ──SSE──▶  Canvas 2D (Air)    ──▶   fenêtre au niveau
  netstat, iostat, ps...)       dépendance, 1 Hz              ou WebGL2 (Pro)           du bureau (WKWebView)
```

- **Respect de la vie privée** : le serveur n'écoute que sur `127.0.0.1` et n'accepte que les pages locales. Aucune donnée ne quitte votre Mac.
- **Robuste** : une mesure qui échoue est remplacée par une simulation réaliste, champ par champ. Sans serveur, la page simule tout.
- **Sobre** : seules les zones qui changent sont redessinées, la cadence s'adapte (de 6 à 60 images par seconde), et tout s'arrête quand la page est masquée.

## État actuel, en toute transparence

- ✅ Mesures réelles, réaction à la charge, thèmes, éditeur de zones, applications natives.
- ⚠️ **Consommation au repos** : la version Air consomme environ 14 % d'un cœur dans l'application réelle, au-dessus de l'objectif de 5 %. La version Pro propose un mode « Économie d'énergie » à 12 images par seconde. C'est le prochain chantier ; en attendant, `?fps=12` ou `?quality=0.75` réduisent nettement la charge.
- Testé sur un MacBook Pro 14 pouces M4 Pro sous macOS 26.

## Structure

```
mac/, mac-pro/            applications de fond d'écran (Swift, AppKit + WKWebView)
server/                   serveurs de télémétrie (Node.js, sans dépendance)
src/                      version Air (Canvas 2D)
src/pro/                  version Pro (WebGL2)
assets/opt/               calques Air (WebP)
assets/pro/               image Pro et cartes dérivées
profiles/pro.json         zones et réglages de la version Pro
scripts/                  préparation des images, compilation des applications
docs/                     captures
```

## Crédits et licence

- **Illustrations** : © [Basic Apple Guy](https://www.basicappleguy.com). Elles sont reproduites ici avec attribution, uniquement pour faire fonctionner le projet, et **ne sont pas couvertes par la licence du code**. Pour les utiliser ailleurs, rendez-vous sur [son blog](https://basicappleguy.com/basicappleblog/iphone-17-pro-internals-wallpapers). Si l'auteur souhaite leur retrait, il sera fait sans discussion.
- **Code** : licence [MIT](LICENSE).
- Projet indépendant, sans aucun lien avec Apple Inc. MacBook, MacBook Air et MacBook Pro sont des marques d'Apple Inc.

---

<details>
<summary><b>🇬🇧 In English</b></summary>

<br>

A live macOS wallpaper that shows the inside of your MacBook and lights up each component based on what your Mac is actually doing: the chip glows with CPU / GPU load, batteries fill with your charge level, Wi-Fi waves follow network throughput, fans spin up under heat. Two versions: **MacBook Air** (Canvas 2D, seven pre-colored layers) and **MacBook Pro** (WebGL2, one image colorized by shaders, animated fans).

All measurements are local, gathered by a dependency-free Node.js server bound to 127.0.0.1. A tiny native Swift app (built locally with `swiftc`, no Xcode, no Apple ID needed) pins the page to the desktop, below icons and click-through, as an alternative to Plash.

**The artwork is by [Basic Apple Guy](https://www.basicappleguy.com)**, from his wonderful internals wallpaper series ([iPhone 17 Pro post](https://basicappleguy.com/basicappleblog/iphone-17-pro-internals-wallpapers)). Please visit his blog and support his work. The artwork is not covered by the MIT license of the code.

Quick start: `npm install`, then `npm run build && npm run app` (Air) or `npm run build:pro && npm run app:pro` (Pro). Documentation is in French.

</details>
