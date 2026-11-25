// MBA Wallpaper : remplace Plash sans compte Apple.
// Affiche la page du fond d'écran (air.html, moteur WebGL commun avec la version Pro) dans une
// fenêtre placée au niveau du bureau (sous les icônes), sur chaque écran, transparente aux clics.
// Démarre le serveur de télémétrie (server/telemetry-pro.mjs, partagé avec MBP Wallpaper) s'il ne
// tourne pas.
// PROJECT_DIR et NODE_PATH sont générés par scripts/build-mac-app.sh.

import Cocoa
import WebKit

let PORT = 8788
let LOGIN_AGENT = (NSHomeDirectory() as NSString).appendingPathComponent("Library/LaunchAgents/local.mba-wallpaper.app.plist")
let THEMES = ["rainbow", "warm", "sunset", "mono", "auto"]
let THEME_NAMES = ["rainbow": "Arc-en-ciel", "warm": "Chaud", "sunset": "Coucher de soleil", "mono": "Monochrome", "auto": "Automatique (jour / nuit)"]

/// Fenêtre de fond : jamais active, jamais au premier plan.
final class WallpaperWindow: NSWindow {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
  private var windows: [NSWindow] = []
  private var statusItem: NSStatusItem!
  private var server: Process?
  private var quitting = false
  private let defaults = UserDefaults.standard

  private var theme: String {
    get { defaults.string(forKey: "theme") ?? "rainbow" }
    set { defaults.set(newValue, forKey: "theme") }
  }
  private var allScreens: Bool {
    get { defaults.object(forKey: "allScreens") as? Bool ?? true }
    set { defaults.set(newValue, forKey: "allScreens") }
  }
  /// Économie d'énergie : cadence réduite à 12 images par seconde (60 par défaut).
  private var eco: Bool {
    get { defaults.bool(forKey: "eco") }
    set { defaults.set(newValue, forKey: "eco") }
  }
  private var pageURL: URL { URL(string: "http://localhost:\(PORT)/air.html?theme=\(theme)\(eco ? "&fps=12" : "")")! }

  func applicationDidFinishLaunching(_ notification: Notification) {
    ensureServer()
    buildMenu()
    // Laisse au serveur le temps de démarrer avant le premier chargement.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { self.rebuildWindows() }
    // Surveillance : si le serveur s'arrête (Terminal fermé, plantage), on en relance un.
    Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in self?.ensureServer() }
    NotificationCenter.default.addObserver(self, selector: #selector(screensChanged),
                                           name: NSApplication.didChangeScreenParametersNotification, object: nil)
  }

  func applicationWillTerminate(_ notification: Notification) {
    quitting = true
    server?.terminate()
  }

  // MARK: fenêtres

  @objc private func screensChanged() { rebuildWindows() }

  private func rebuildWindows() {
    windows.forEach { $0.orderOut(nil) }
    windows.removeAll()
    // NSScreen.screens[0] est l'écran qui porte la barre des menus.
    let screens = allScreens ? NSScreen.screens : Array(NSScreen.screens.prefix(1))
    for screen in screens {
      let w = WallpaperWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
      w.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)))
      w.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenNone]
      w.ignoresMouseEvents = true
      w.hasShadow = false
      w.isReleasedWhenClosed = false
      w.backgroundColor = NSColor(red: 0.043, green: 0.051, blue: 0.071, alpha: 1)

      let config = WKWebViewConfiguration()
      config.suppressesIncrementalRendering = true
      let web = WKWebView(frame: NSRect(origin: .zero, size: screen.frame.size), configuration: config)
      web.setValue(false, forKey: "drawsBackground")
      web.navigationDelegate = self
      web.autoresizingMask = [.width, .height]
      w.contentView = web
      w.setFrame(screen.frame, display: false)
      w.orderFront(nil)
      web.load(URLRequest(url: pageURL))
      windows.append(w)
    }
  }

  private func reloadAll() {
    for w in windows { (w.contentView as? WKWebView)?.load(URLRequest(url: pageURL)) }
  }

  // Serveur pas encore prêt ou redémarré : nouvel essai toutes les 3 s.
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { retry(webView) }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { retry(webView) }
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { retry(webView) }

  private func retry(_ webView: WKWebView) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self, weak webView] in
      guard let self, let webView else { return }
      self.ensureServer()
      webView.load(URLRequest(url: self.pageURL))
    }
  }

  // MARK: serveur de télémétrie

  /// Vrai si quelque chose écoute déjà sur le port (serveur lancé dans un Terminal, par exemple).
  private func serverAlive() -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(UInt16(PORT).bigEndian)
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    return withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0 }
    }
  }

  private func nodePath() -> String? {
    let candidates = [NODE_PATH, "/opt/homebrew/bin/node", "/usr/local/bin/node"]
    return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
  }

  private func ensureServer() {
    if let s = server, s.isRunning { return }
    if serverAlive() { return }
    guard let node = nodePath() else {
      NSLog("MBA Wallpaper : Node.js introuvable")
      return
    }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: node)
    p.arguments = [(PROJECT_DIR as NSString).appendingPathComponent("server/telemetry-pro.mjs")]
    p.currentDirectoryURL = URL(fileURLWithPath: PROJECT_DIR)
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"
    p.environment = env
    let logURL = URL(fileURLWithPath: (NSHomeDirectory() as NSString).appendingPathComponent("Library/Logs/MBA Wallpaper.log"))
    FileManager.default.createFile(atPath: logURL.path, contents: nil)
    if let h = try? FileHandle(forWritingTo: logURL) { p.standardOutput = h; p.standardError = h }
    p.terminationHandler = { [weak self] _ in
      DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
        guard let self, !self.quitting else { return }
        self.server = nil
        self.ensureServer()
      }
    }
    do { try p.run(); server = p } catch { NSLog("MBA Wallpaper : serveur non démarré (\(error))") }
  }

  // MARK: barre des menus

  private func buildMenu() {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    statusItem.button?.image = NSImage(systemSymbolName: "cpu", accessibilityDescription: "MBA Wallpaper")
    refreshMenu()
  }

  private func refreshMenu() {
    let menu = NSMenu()
    let title = NSMenuItem(title: "Fond d'écran MacBook Air", action: nil, keyEquivalent: "")
    title.isEnabled = false
    menu.addItem(title)
    menu.addItem(.separator())

    let themeItem = NSMenuItem(title: "Thème", action: nil, keyEquivalent: "")
    let themeMenu = NSMenu()
    for t in THEMES {
      let it = NSMenuItem(title: THEME_NAMES[t] ?? t, action: #selector(chooseTheme(_:)), keyEquivalent: "")
      it.representedObject = t
      it.target = self
      it.state = t == theme ? .on : .off
      themeMenu.addItem(it)
    }
    themeItem.submenu = themeMenu
    menu.addItem(themeItem)

    let screensItem = NSMenuItem(title: "Sur tous les écrans", action: #selector(toggleScreens), keyEquivalent: "")
    screensItem.target = self
    screensItem.state = allScreens ? .on : .off
    menu.addItem(screensItem)

    let ecoItem = NSMenuItem(title: "Économie d'énergie (12 i/s)", action: #selector(toggleEco), keyEquivalent: "")
    ecoItem.target = self
    ecoItem.state = eco ? .on : .off
    menu.addItem(ecoItem)

    let loginItem = NSMenuItem(title: "Ouvrir à l'ouverture de session", action: #selector(toggleLogin), keyEquivalent: "")
    loginItem.target = self
    loginItem.state = FileManager.default.fileExists(atPath: LOGIN_AGENT) ? .on : .off
    menu.addItem(loginItem)

    menu.addItem(.separator())
    let reload = NSMenuItem(title: "Recharger", action: #selector(reloadAction), keyEquivalent: "r")
    reload.target = self
    menu.addItem(reload)
    let editor = NSMenuItem(title: "Éditeur de zones (navigateur)", action: #selector(openEditor), keyEquivalent: "")
    editor.target = self
    menu.addItem(editor)
    menu.addItem(.separator())
    let quit = NSMenuItem(title: "Quitter", action: #selector(quitAction), keyEquivalent: "q")
    quit.target = self
    menu.addItem(quit)
    statusItem.menu = menu
  }

  @objc private func chooseTheme(_ sender: NSMenuItem) {
    guard let t = sender.representedObject as? String else { return }
    theme = t
    reloadAll()
    refreshMenu()
  }

  @objc private func toggleEco() {
    eco.toggle()
    reloadAll()
    refreshMenu()
  }

  @objc private func toggleScreens() {
    allScreens.toggle()
    rebuildWindows()
    refreshMenu()
  }

  /// Lancement à l'ouverture de session par un LaunchAgent qui ouvre l'application.
  @objc private func toggleLogin() {
    let fm = FileManager.default
    if fm.fileExists(atPath: LOGIN_AGENT) {
      try? fm.removeItem(atPath: LOGIN_AGENT)
    } else {
      let plist: [String: Any] = [
        "Label": "local.mba-wallpaper.app",
        "ProgramArguments": ["/usr/bin/open", "-a", Bundle.main.bundlePath],
        "RunAtLoad": true,
      ]
      try? fm.createDirectory(atPath: (LOGIN_AGENT as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
      if let data = try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0) {
        fm.createFile(atPath: LOGIN_AGENT, contents: data)
      }
    }
    refreshMenu()
  }

  @objc private func reloadAction() { ensureServer(); reloadAll() }

  @objc private func openEditor() {
    NSWorkspace.shared.open(URL(string: "http://localhost:\(PORT)/air.html?debug=1&theme=\(theme)")!)
  }

  @objc private func quitAction() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // pas d'icône dans le Dock
app.run()
