<div align="center">

# MacBook Internals · Live Wallpaper

**English** · [Français](README.fr.md)

**A macOS wallpaper that shows the inside of your Mac… and brings it to life with what your Mac is actually doing.**

The chip glows when the CPU works hard, the battery fills with your charge level, Wi-Fi waves follow your throughput, and the fans spin up when things get hot.

<img src="docs/images/air-hero.webp" alt="MacBook Air version under CPU load: the chip turns into a glowing rainbow" width="100%">

<sub>MacBook Air version, captured during a real CPU loop. Original artwork by <a href="https://www.basicappleguy.com/basicappleblog/m4-macbook-air-internals-13-inch">Basic Apple Guy</a>.</sub>

</div>

---

> [!IMPORTANT]
> **The artwork is not mine.** These beautiful MacBook internals illustrations are the work of **[Basic Apple Guy](https://www.basicappleguy.com)**, who has been publishing remarkably detailed "internals" wallpapers for years. This project started from his post **[iPhone 17 Pro Internals Wallpapers](https://basicappleguy.com/basicappleblog/iphone-17-pro-internals-wallpapers)** and his [13-inch MacBook Air](https://www.basicappleguy.com/basicappleblog/m4-macbook-air-internals-13-inch) and [14 and 16-inch MacBook Pro](https://www.basicappleguy.com/basicappleblog/macbook-pro-2025-update) series.
>
> This project only adds the code that animates them. If you enjoy the result, visit his blog and **support his work** by buying his wallpaper packs: he is the one who makes all of this possible.

---

## Two Macs, two engines

<table>
<tr>
<td width="50%" valign="top">

### MacBook Air
<img src="docs/images/air-themes.webp" alt="The four themes of the Air version" width="100%">

- **Canvas 2D**, seven layers pre-colored by the artist
- Each component reveals its color through a soft-edged mask
- Particles along the flex cable, light sweeps, heat spreading
- No fan, just like the real one: heat radiates through the plate

[Detailed documentation (French) →](README-AIR.md)

</td>
<td width="50%" valign="top">

### MacBook Pro
<img src="docs/pro-captures/direct-boucle-cpu.webp" alt="MacBook Pro version under CPU load: glowing heat pipe and fans" width="100%">

- **WebGL2**, a single dark image colorized by shaders
- Fans spin with the load, smoothed over 20 seconds
- The heat pipe warms up from the chip to the fins
- Halos, flickering, data flowing along the flex cables

[Detailed documentation (French) →](README-PRO.md)

</td>
</tr>
</table>

## What lights up, and why

Everything is measured **locally**, in real time, by a small dependency-free Node.js server.

| Component | What it reflects | macOS source |
|---|---|---|
| 🧠 Chip (CPU / GPU) | Processor and graphics load, from a cool tint to incandescence | `os.cpus()`, `ps`, `ioreg IOAccelerator` |
| 💾 Memory / storage | Memory pressure, flickering with disk I/O | `vm_stat`, `iostat` |
| ⚡ Power stage | System power draw, in watts | `ioreg AppleSmartBattery` |
| 🔋 Batteries | Charge level, animated flow while charging, alert below 20 % | `pmset -g batt` |
| 🔥 Plate, heat pipe, fans | Thermal pressure and sustained load | `pmset -g therm`, `notifyutil` |
| 🔊 Speakers | Pulses while audio is playing, scaled by volume | `pmset -g assertions`, `osascript` |
| 📶 Wi-Fi / Bluetooth | Network throughput | `netstat -ib` |
| ⌨️ Trackpad / Taptic Engine | Your keyboard and trackpad activity, in every app | `ioreg IOHIDSystem` |
| 🔌 Ports | Power adapter plugged in | `pmset`, `ioreg` |
| 🖥️ Display connector | Day and night, based on local time | clock |

The wallpaper is **fully passive**: it does not react to clicks or hovering. It simply tells the story of what your Mac is doing.

> A small design trick: an infinite loop only keeps one core busy, which is 8 % of the average on a 12-core chip, lost in the idle noise. So the chip also watches the busiest process and the excess load over your Mac's own baseline. As a result, running `while :; do :; done` in a Terminal is enough to make it glow within 3 to 5 seconds.

## Quick start

Requirements: macOS 13 or later, [Node.js](https://nodejs.org) 20 or later, and Apple's command line tools (`xcode-select --install`). **No Xcode, no Apple ID and no admin rights needed.**

```sh
git clone https://github.com/trichard-coder/macbook-internals-live-wallpaper.git
cd macbook-internals-live-wallpaper
npm install
```

**MacBook Air version**

```sh
npm run build        # builds the page
npm run app          # compiles and installs ~/Applications/MBA Wallpaper.app
open -a "MBA Wallpaper"
```

**MacBook Pro version**

```sh
npm run build:pro
npm run app:pro      # compiles and installs ~/Applications/MBP Wallpaper.app
open -a "MBP Wallpaper"
```

An icon appears in the menu bar: theme, displays, launch at login, quit. The app starts and watches the telemetry server by itself, so there is no need to keep a Terminal open. The Pro app steps aside while the Air app is running, so only one wallpaper is shown at a time.

<details>
<summary><b>Why a custom app instead of Plash?</b></summary>

<br>

[Plash](https://sindresorhus.com/plash) is the usual tool for showing a web page as your wallpaper, but it is only distributed through the App Store, which rules out Macs without an Apple ID (often work computers). The project therefore ships a minimal replacement (`mac/main.swift`, about 250 lines): one window per display, placed at desktop level, below the icons and click-through, showing the page in a WKWebView. It is compiled on your Mac with `swiftc`.

If you do have Plash, it works too: run `npm run telemetry` (Air, port 8787) or `npm run telemetry:pro` (Pro, port 8788), then add `http://localhost:8787/` or `http://localhost:8788/pro.html` in Plash.

</details>

## Themes and settings

Pick a theme from the app menu, or with a URL parameter:

| Theme | Mood |
|---|---|
| `rainbow` | Saturated rainbow, from cool to hot (default) |
| `warm` | Orange, magenta and purple |
| `sunset` | Amber and crimson |
| `mono` | No color, just brightening |
| `auto` | `warm` during the day, `rainbow` at night |

Other parameters adjust the frame rate (`?fps=`), the resolution (`?quality=`) or reduce animations (`?motion=reduce`, also enabled by the macOS accessibility setting). The `?debug=1` mode opens a **zone editor** to fine-tune the position of each component down to the pixel.

## How it works

```
 macOS commands                 Node.js server                web page                  native app
 (ioreg, pmset, vm_stat,  ──▶   127.0.0.1, no        ──SSE──▶  Canvas 2D (Air)    ──▶   desktop-level window
  netstat, iostat, ps...)       dependencies, 1 Hz            or WebGL2 (Pro)           (WKWebView)
```

- **Privacy first**: the server only listens on `127.0.0.1` and only accepts local pages. No data ever leaves your Mac.
- **Resilient**: any measurement that fails is replaced, field by field, by a realistic simulation. Without a server, the page simulates everything.
- **Frugal**: only the zones that change are redrawn, the frame rate adapts (from 6 to 60 frames per second), and everything stops when the page is hidden.

## Current status, honestly

- ✅ Real measurements, reaction to load, themes, zone editor, native apps.
- ⚠️ **Idle power use**: the Air version uses about 14 % of one CPU core in the real app, above the 5 % target. The Pro version offers a "Power saving" mode at 12 frames per second. This is the next thing to improve; in the meantime, `?fps=12` or `?quality=0.75` noticeably reduce the load.
- Tested on a 14-inch MacBook Pro (M4 Pro) running macOS 26.

## Project layout

```
mac/, mac-pro/            wallpaper apps (Swift, AppKit + WKWebView)
server/                   telemetry servers (Node.js, no dependencies)
src/                      Air version (Canvas 2D)
src/pro/                  Pro version (WebGL2)
assets/opt/               Air layers (WebP)
assets/pro/               Pro image and derived maps
profiles/pro.json         zones and settings for the Pro version
scripts/                  image preparation, app compilation
docs/                     screenshots
```

## Credits and license

- **Artwork**: © [Basic Apple Guy](https://www.basicappleguy.com). It is reproduced here with attribution, only so that the project works out of the box, and it is **not covered by the code license**. To use it elsewhere, head to [his blog](https://basicappleguy.com/basicappleblog/iphone-17-pro-internals-wallpapers). If the author asks for it to be removed, it will be, no questions asked.
- **Code**: [MIT](LICENSE) license.
- Independent project, not affiliated with Apple Inc. in any way. MacBook, MacBook Air and MacBook Pro are trademarks of Apple Inc.
