// Annex.app: Annex in its own window instead of a browser tab. The server runs as a login service.
// A self-contained build carries its own node, Annex's server and the Paperclip engine in
// Contents/Resources; on first launch it installs that login service itself, with the data in
// ~/Library/Application Support/Annex (or the folder named in ~/.config/annex/home). It reads the key from
// ~/.config/annex/key itself, so it never needs pairing, and it turns the page's alerts and its
// "waiting on you" count into macOS notifications and a Dock badge. It needs nothing else on the
// Mac first: the page's setup screen installs Claude Code and logs it in. When the page asks for a
// folder, the app shows the Mac's own folder panel.

import Cocoa
import UserNotifications
import WebKit

let port = ProcessInfo.processInfo.environment["ANNEX_PORT"] ?? "4300"
let base = URL(string: "http://127.0.0.1:\(port)/")!
let userHome = FileManager.default.homeDirectoryForCurrentUser
let keyFile = userHome.appendingPathComponent(".config/annex/key")
let servicePlist = userHome.appendingPathComponent("Library/LaunchAgents/dev.annex.office.plist")

// Runs a command through the person's login shell, so it sees the PATH their terminal has
// (claude, git, npm) rather than the bare one an app gets from Finder.
func loginShell(_ command: String) -> (ok: Bool, out: String) {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh")
  p.arguments = ["-lc", command]
  let pipe = Pipe()
  p.standardOutput = pipe
  p.standardError = FileHandle.nullDevice
  do { try p.run() } catch { return (false, "") }
  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  p.waitUntilExit()
  let out = String(data: data, encoding: .utf8) ?? ""
  return (p.terminationStatus == 0, out.trimmingCharacters(in: .whitespacesAndNewlines))
}

// A value as JavaScript source (JSON), or null.
func jsonLiteral(_ value: Any?) -> String {
  guard let value = value, let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
    let text = String(data: data, encoding: .utf8)
  else { return "null" }
  return text
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate,
  WKScriptMessageHandler, UNUserNotificationCenterDelegate
{
  var window: NSWindow!
  var web: WKWebView!
  var retry: Timer?
  var starting = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.mainMenu = buildMenu()
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .default()
    // the page talks to the app through window.webkit.messageHandlers.annex
    config.userContentController.add(self, name: "annex")
    web = WKWebView(frame: .zero, configuration: config)
    web.navigationDelegate = self
    web.uiDelegate = self
    web.allowsMagnification = true
    web.setValue(false, forKey: "drawsBackground")

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = "Annex"
    window.minSize = NSSize(width: 480, height: 400)
    window.backgroundColor = NSColor(red: 8 / 255, green: 9 / 255, blue: 10 / 255, alpha: 1)
    window.contentView = web
    window.delegate = self
    window.setFrameAutosaveName("AnnexMain")
    if !window.setFrameUsingName("AnnexMain") { window.center() }
    window.makeKeyAndOrderFront(nil)

    UNUserNotificationCenter.current().delegate = self
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    if !FileManager.default.fileExists(atPath: servicePlist.path) { installService(confirm: false) }
    load()
  }

  // MARK: the login service this app carries

  var bundledNode: URL? {
    let node = Bundle.main.resourceURL!.appendingPathComponent("node/bin/node")
    return FileManager.default.fileExists(atPath: node.path) ? node : nil
  }

  func dataHome() -> String {
    let named = userHome.appendingPathComponent(".config/annex/home")
    if let home = try? String(contentsOf: named, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
      !home.isEmpty
    {
      return home
    }
    return userHome.appendingPathComponent("Library/Application Support/Annex").path
  }

  @objc func useBundledService(_ sender: Any?) { installService(confirm: true) }

  func installService(confirm: Bool) {
    guard let node = bundledNode else { return }
    if confirm {
      let a = NSAlert()
      a.messageText = "Run Annex from this app?"
      a.informativeText =
        "The login service will run the server inside this app and keep your data in \(dataHome()). Annex restarts once."
      a.addButton(withTitle: "Use This App")
      a.addButton(withTitle: "Cancel")
      if a.runModal() != .alertFirstButtonReturn { return }
    }
    starting = true
    let path = loginShell("printf %s \"$PATH\"").out
    let script = Bundle.main.resourceURL!.appendingPathComponent("annex/scripts/service.ts")
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = path.isEmpty ? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" : path
    env["ANNEX_HOME"] = dataHome()
    env["ANNEX_FROM_APP"] = "1"
    let p = Process()
    p.executableURL = node
    p.arguments = [script.path, "install"]
    p.environment = env
    p.terminationHandler = { _ in DispatchQueue.main.async { self.load() } }
    try? p.run()
  }

  // The key goes in the # once per load; the page stores it and takes it out of the address.
  func load() {
    retry?.invalidate()
    var url = base
    if let key = try? String(contentsOf: keyFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
      !key.isEmpty
    {
      url = URL(string: "\(base.absoluteString)#key=\(key)")!
    }
    web.load(URLRequest(url: url))
  }

  @objc func reload(_ sender: Any?) { load() }
  @objc func zoomIn(_ sender: Any?) { web.pageZoom = min(web.pageZoom + 0.1, 2) }
  @objc func zoomOut(_ sender: Any?) { web.pageZoom = max(web.pageZoom - 0.1, 0.5) }
  @objc func actualSize(_ sender: Any?) { web.pageZoom = 1 }

  // Closing the window hides it; the Dock icon brings it back. Cmd+Q quits the app, not the server.
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    window.orderOut(nil)
    return false
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    window.makeKeyAndOrderFront(nil)
    return true
  }

  // MARK: the server is not answering

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    showOffline()
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    if (error as NSError).code != NSURLErrorCancelled { showOffline() }
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { load() }

  func showOffline() {
    web.loadHTMLString(
      """
      <html><body style="margin:0;height:100vh;display:grid;place-content:center;gap:10px;padding:24px;
      background:#08090a;color:#f7f8f8;font:15px/1.5 -apple-system,system-ui,sans-serif">
      <h2 style="margin:0;font-weight:600;letter-spacing:-0.02em">\(starting ? "Starting Annex" : "Annex is not running")</h2>
      <p style="margin:0;color:#a0a4ab">\(starting
        ? "The first start sets up the agent engine and its database, which takes a minute or two."
        : "It starts by itself with the login service. If it does not come back, choose Annex, then Run Annex From This App.")</p>
      <p style="margin:0;color:#6f737b">Trying again every few seconds…</p></body></html>
      """, baseURL: nil)
    retry?.invalidate()
    retry = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in self?.load() }
  }

  // MARK: links that leave Annex open in the default browser

  func webView(
    _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = navigationAction.request.url else { return decisionHandler(.allow) }
    let ours = url.scheme == "about" || (url.host == "127.0.0.1" && String(url.port ?? 80) == port)
    if ours && navigationAction.targetFrame != nil { return decisionHandler(.allow) }
    NSWorkspace.shared.open(url)
    decisionHandler(.cancel)
  }

  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
    return nil
  }

  func webView(
    _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void
  ) {
    let a = NSAlert()
    a.messageText = message
    a.beginSheetModal(for: window) { _ in completionHandler() }
  }

  func webView(
    _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void
  ) {
    let a = NSAlert()
    a.messageText = message
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Cancel")
    a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
  }

  func webView(
    _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void
  ) {
    let p = NSOpenPanel()
    p.allowsMultipleSelection = parameters.allowsMultipleSelection
    p.canChooseDirectories = parameters.allowsDirectories
    p.beginSheetModal(for: window) { r in completionHandler(r == .OK ? p.urls : nil) }
  }

  // MARK: alerts, the Dock badge and the folder panel, for the page

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any], let kind = body["kind"] as? String else { return }
    if kind == "pickFolder" {
      pickFolder(id: body["id"])
    } else if kind == "badge" {
      let n = body["count"] as? Int ?? 0
      NSApp.dockTile.badgeLabel = n > 0 ? String(n) : nil
    } else if kind == "alert", !NSApp.isActive || !window.isVisible {
      let content = UNMutableNotificationContent()
      content.title = body["title"] as? String ?? "Annex"
      content.body = body["body"] as? String ?? ""
      content.sound = .default
      UNUserNotificationCenter.current().add(
        UNNotificationRequest(identifier: content.title, content: content, trigger: nil))
      NSApp.requestUserAttention(.informationalRequest)
    }
  }

  // The page's "Choose…": a folder panel over the window; the answer (the path, or null when
  // cancelled) goes back to window.annexPicked with the id the page sent.
  func pickFolder(id: Any?) {
    window.makeKeyAndOrderFront(nil)
    let p = NSOpenPanel()
    p.canChooseDirectories = true
    p.canChooseFiles = false
    p.canCreateDirectories = true
    p.allowsMultipleSelection = false
    p.prompt = "Choose"
    p.beginSheetModal(for: window) { r in
      let path: Any? = r == .OK ? p.url?.path : nil
      self.web.evaluateJavaScript("window.annexPicked(\(jsonLiteral(id)), \(jsonLiteral(path)))")
    }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
    completionHandler()
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound])
  }

  // MARK: menus

  func buildMenu() -> NSMenu {
    let main = NSMenu()
    func add(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
      let item = NSMenuItem()
      let menu = NSMenu(title: title)
      items.forEach(menu.addItem)
      item.submenu = menu
      main.addItem(item)
      return menu
    }
    func item(_ title: String, _ action: Selector?, _ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
      i.keyEquivalentModifierMask = mods
      return i
    }
    _ = add(
      "Annex",
      [
        item("About Annex", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
        .separator(),
        item("Run Annex From This App…", #selector(useBundledService(_:)), ""),
        .separator(),
        item("Hide Annex", #selector(NSApplication.hide(_:)), "h"),
        item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
        item("Show All", #selector(NSApplication.unhideAllApplications(_:)), ""),
        .separator(),
        item("Quit Annex", #selector(NSApplication.terminate(_:)), "q"),
      ])
    _ = add(
      "Edit",
      [
        item("Undo", Selector(("undo:")), "z"),
        item("Redo", Selector(("redo:")), "z", [.command, .shift]),
        .separator(),
        item("Cut", #selector(NSText.cut(_:)), "x"),
        item("Copy", #selector(NSText.copy(_:)), "c"),
        item("Paste", #selector(NSText.paste(_:)), "v"),
        item("Select All", #selector(NSText.selectAll(_:)), "a"),
      ])
    _ = add(
      "View",
      [
        item("Reload", #selector(reload(_:)), "r"),
        .separator(),
        item("Actual Size", #selector(actualSize(_:)), "0"),
        item("Zoom In", #selector(zoomIn(_:)), "="),
        item("Zoom Out", #selector(zoomOut(_:)), "-"),
        .separator(),
        item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
      ])
    let windowMenu = add(
      "Window",
      [
        item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
        item("Close", #selector(NSWindow.performClose(_:)), "w"),
      ])
    NSApp.windowsMenu = windowMenu
    return main
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
