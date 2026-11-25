#!/bin/sh
# Compile l'application « MBP Wallpaper » (version MacBook Pro, remplaçant de Plash sans compte
# Apple ni Xcode : seuls les outils en ligne de commande sont nécessaires) et l'installe dans
# ~/Applications. Copie adaptée de scripts/build-mac-app.sh (version Air).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist-app-pro/MBP Wallpaper.app"
NODE="$(command -v node || true)"

# La page servie par l'application est le build statique : on le refait s'il manque.
[ -f "$ROOT/dist-pro/pro.html" ] || (cd "$ROOT" && npm run build:pro)

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
GEN="$(mktemp -d)/Config.swift"
printf 'let PROJECT_DIR = "%s"\nlet NODE_PATH = "%s"\n' "$ROOT" "$NODE" > "$GEN"
# Le code de premier niveau n'est autorisé que dans un fichier nommé main.swift.
swiftc -O -o "$APP/Contents/MacOS/MBPWallpaper" "$ROOT/mac-pro/main.swift" "$GEN" -framework Cocoa -framework WebKit
cp "$ROOT/mac-pro/Info.plist" "$APP/Contents/Info.plist"
codesign --force --sign - "$APP" 2>/dev/null

mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/MBP Wallpaper.app"
cp -R "$APP" "$HOME/Applications/"
echo "Application installée : ~/Applications/MBP Wallpaper.app"
