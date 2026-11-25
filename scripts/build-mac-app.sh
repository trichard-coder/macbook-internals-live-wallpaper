#!/bin/sh
# Compile l'application « MBA Wallpaper » (remplaçant de Plash, sans compte Apple ni Xcode :
# seuls les outils en ligne de commande sont nécessaires) et l'installe dans ~/Applications.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist-app/MBA Wallpaper.app"
NODE="$(command -v node || true)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
GEN="$(mktemp -d)/Config.swift"
printf 'let PROJECT_DIR = "%s"\nlet NODE_PATH = "%s"\n' "$ROOT" "$NODE" > "$GEN"
swiftc -O -o "$APP/Contents/MacOS/MBAWallpaper" "$ROOT/mac/main.swift" "$GEN" -framework Cocoa -framework WebKit
cp "$ROOT/mac/Info.plist" "$APP/Contents/Info.plist"
codesign --force --sign - "$APP" 2>/dev/null

mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/MBA Wallpaper.app"
cp -R "$APP" "$HOME/Applications/"
echo "Application installée : ~/Applications/MBA Wallpaper.app"
