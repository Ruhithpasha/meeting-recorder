// The dashboard in a native window: a WKWebView showing the local dashboard the daemon serves on
// 127.0.0.1. No browser, no hosting. Only the local dashboard may load inside it (anything else
// opens in the default browser). Web storage is non-persistent, and closing the window releases
// WebKit entirely, so the app goes back to its small menu-bar footprint.
import AppKit
import WebKit

final class DashboardWindow: NSObject, NSWindowDelegate, WKNavigationDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?
    /// The exact dashboard URL last loaded, token included: a restarted daemon keeps its port but
    /// gets a new token, and must be reloaded.
    private var loadedURL: URL?
    private var crashReloads: [Date] = []

    var isOpen: Bool { window != nil }

    /// Shows the window. A dashboard URL from a new daemon session (new port or token) reloads it;
    /// the same session just brings the window forward.
    func show(url: URL) {
        if window == nil { create() }
        if loadedURL != url || webView?.url == nil {
            webView?.load(URLRequest(url: url))
            loadedURL = url
        }
        NSApp.setActivationPolicy(.regular) // Dock icon and menus while the window is open
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    /// The standard macOS share sheet (AirDrop, Mail, Messages…) for one file, anchored to the
    /// top of the dashboard window (the user just clicked Share there).
    func share(_ file: URL) {
        guard let window, let view = window.contentView else { return }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
        let anchor = NSRect(x: view.bounds.midX, y: view.bounds.maxY - 80, width: 1, height: 1)
        NSSharingServicePicker(items: [file]).show(relativeTo: anchor, of: view, preferredEdge: .minY)
    }

    func close() {
        window?.close()
    }

    private func create() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent() // nothing about the session is written to disk
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground") // no white flash in dark mode while loading

        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 780),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable],
                         backing: .buffered, defer: false)
        w.title = "Meeting Recorder"
        w.minSize = NSSize(width: 720, height: 500)
        w.contentView = web
        w.isReleasedWhenClosed = false
        w.delegate = self
        w.tabbingMode = .disallowed
        if !w.setFrameUsingName("Dashboard") { w.center() }
        w.setFrameAutosaveName("Dashboard")
        window = w
        webView = web
    }

    // MARK: NSWindowDelegate

    func windowWillClose(_ notification: Notification) {
        // Release WebKit (its web content process exits) and go back to menu-bar only.
        webView?.navigationDelegate = nil
        webView = nil
        window = nil
        loadedURL = nil
        crashReloads = []
        NSApp.setActivationPolicy(.accessory)
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        let isDashboard = url.scheme == "http" && url.host == "127.0.0.1" && url.port != nil && url.port == loadedURL?.port
        if isDashboard || url.scheme == "about" || url.scheme == "blob" {
            return decisionHandler(.allow)
        }
        if url.scheme == "https" || url.scheme == "mailto" { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    /// If the web content process dies (memory pressure), reload instead of showing a blank window,
    /// but at most 3 times a minute so a crashing page can't spin while the recorder runs.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        let now = Date()
        crashReloads = crashReloads.filter { now.timeIntervalSince($0) < 60 } + [now]
        guard crashReloads.count <= 3 else { return Log.warn("dashboard web process keeps crashing; not reloading") }
        webView.reload()
    }
}

/// The app's menu bar while the dashboard window is open. Edit commands make copy/paste work in
/// settings fields. Deliberately no ⌘Q: closing the dashboard must not stop the 24/7 recorder by
/// accident. Quitting is an explicit menu item.
enum MainMenu {
    static func install(target: AnyObject, quit: Selector, closeWindow: Selector) {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Hide Meeting Recorder", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        let quitItem = NSMenuItem(title: "Quit Meeting Recorder (stops recording)", action: quit, keyEquivalent: "")
        quitItem.target = target
        appMenu.addItem(quitItem)
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        let close = NSMenuItem(title: "Close Dashboard", action: closeWindow, keyEquivalent: "w")
        close.target = target
        windowMenu.addItem(close)
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)

        NSApp.mainMenu = main
    }
}
