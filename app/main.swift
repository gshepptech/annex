// Annex.app: Annex in its own window instead of a browser tab. The server keeps running as the
// login service (npm run service:install); this app only shows it. It reads the key from
// ~/.config/annex/key itself, so it never needs pairing, and it turns the page's alerts and its
// "waiting on you" count into macOS notifications and a Dock badge.

import Cocoa
import UserNotifications
import WebKit

let port = ProcessInfo.processInfo.environment["ANNEX_PORT"] ?? "4300"
let base = URL(string: "http://127.0.0.1:\(port)/")!
let keyFile = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/annex/key")

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate,
  WKScriptMessageHandler, UNUserNotificationCenterDelegate
{
  var window: NSWindow!
  var web: WKWebView!
  var retry: Timer?

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
    load()
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
      <h2 style="margin:0;font-weight:600;letter-spacing:-0.02em">Annex is not running</h2>
      <p style="margin:0;color:#a0a4ab">It starts by itself with the login service. If it does not come back,
      run <code>npm run service:install</code> in the Annex folder.</p>
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

  // MARK: alerts and the Dock badge from the page

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any], let kind = body["kind"] as? String else { return }
    if kind == "badge" {
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
