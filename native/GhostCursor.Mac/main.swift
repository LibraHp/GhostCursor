import AppKit
import ApplicationServices
import CoreGraphics
import Darwin

// Newline-delimited JSON over a Unix socket inside the parent's private 0700
// directory. All target, marker and input state is confined to the main thread.
private func now() -> Double { Date().timeIntervalSince1970 * 1000 }
private func number(_ d: [String: Any], _ key: String) -> Double { (d[key] as? NSNumber)?.doubleValue ?? 0 }
private func string(_ d: [String: Any], _ key: String) -> String { d[key] as? String ?? "" }
private func failure(_ message: String) -> NSError { NSError(domain: "GhostCursor", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
private func color(_ hex: String) -> NSColor {
    let value = UInt32(hex.dropFirst(), radix: 16) ?? 0x2563eb
    return NSColor(srgbRed: CGFloat((value >> 16) & 255) / 255, green: CGFloat((value >> 8) & 255) / 255, blue: CGFloat(value & 255) / 255, alpha: 1)
}
private struct Appearance {
    var shape = "arrow"
    var size: CGFloat = 32
    var hex: String? = nil
}
private struct WindowInfo {
    let id: CGWindowID
    let pid: pid_t
    let rect: CGRect
    let name: String
    let layer: Int
}
private func windows() -> [WindowInfo] {
    let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return rows.compactMap { row in
        guard let id = row[kCGWindowNumber as String] as? UInt32,
              let pid = row[kCGWindowOwnerPID as String] as? Int32,
              let bounds = row[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary), rect.width > 0, rect.height > 0,
              (row[kCGWindowAlpha as String] as? Double ?? 1) > 0 else { return nil }
        return WindowInfo(id: id, pid: pid, rect: rect,
            name: row[kCGWindowName as String] as? String ?? "",
            layer: row[kCGWindowLayer as String] as? Int ?? 0)
    }
}

private final class MarkerView: NSView {
    override var isFlipped: Bool { true }
    var name = "", hex = "#2563eb", touch = false
    var appearance = Appearance()
    var allowed = CGRect.zero
    var occlusions: [CGRect] = []
    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        context.saveGState()
        defer { context.restoreGState() }
        context.clip(to: allowed)
        // Subtract each covering window independently (overlapping holes must
        // not cancel each other). Clip the glyph AND its label at window edges.
        for rect in occlusions {
            context.beginPath(); context.addRect(bounds); context.addRect(rect)
            context.clip(using: .evenOdd)
        }
        let tint = color(appearance.hex ?? hex)
        let shape = touch ? "ring" : appearance.shape
        context.saveGState()
        context.translateBy(x: 28, y: 28)
        context.scaleBy(x: appearance.size / 32, y: appearance.size / 32)
        tint.setFill(); NSColor.white.setStroke()
        if shape == "arrow" {
            let p = NSBezierPath()
            p.move(to: .zero)
            for point in [NSPoint(x: 1, y: 24), NSPoint(x: 7, y: 18), NSPoint(x: 12, y: 29), NSPoint(x: 17, y: 26), NSPoint(x: 12, y: 16), NSPoint(x: 21, y: 15)] { p.line(to: point) }
            p.close(); p.lineWidth = 1.5; p.fill(); p.stroke()
        } else {
            if shape == "ring" {
                let ring = NSBezierPath(ovalIn: NSRect(x: -14, y: -14, width: 28, height: 28))
                tint.withAlphaComponent(0.17).setFill(); tint.setStroke()
                ring.lineWidth = 2; ring.fill(); ring.stroke()
            } else {
                tint.setStroke(); let cross = NSBezierPath(); cross.lineWidth = 2
                for (a, b) in [(NSPoint(x: 0, y: -16), NSPoint(x: 0, y: -5)), (NSPoint(x: 0, y: 5), NSPoint(x: 0, y: 16)), (NSPoint(x: -16, y: 0), NSPoint(x: -5, y: 0)), (NSPoint(x: 5, y: 0), NSPoint(x: 16, y: 0))] { cross.move(to: a); cross.line(to: b) }
                cross.stroke()
            }
            let dot = NSBezierPath(ovalIn: NSRect(x: -3, y: -3, width: 6, height: 6))
            tint.setFill(); NSColor.white.setStroke(); dot.lineWidth = 1; dot.fill(); dot.stroke()
        }
        context.restoreGState()
        let text = String(name.prefix(24)) as NSString
        let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 11, weight: .medium), .foregroundColor: NSColor.white]
        let label = NSRect(x: 33, y: 28 + (shape == "arrow" ? appearance.size + 4 : appearance.size / 2 + 10), width: min(148, text.size(withAttributes: attributes).width + 14), height: 23)
        tint.setFill(); NSBezierPath(roundedRect: label, xRadius: 5, yRadius: 5).fill()
        let paragraph = NSMutableParagraphStyle(); paragraph.lineBreakMode = .byTruncatingTail
        text.draw(in: label.insetBy(dx: 7, dy: 4), withAttributes: attributes.merging([.paragraphStyle: paragraph]) { _, b in b })
    }
}
private final class Marker {
    let panel: NSPanel
    let view = MarkerView(frame: NSRect(x: 0, y: 0, width: 210, height: 125))
    var x: Double = 0, y: Double = 0, lastSeen: Double = 0
    init(name: String, hex: String) {
        panel = NSPanel(contentRect: view.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = false
        panel.ignoresMouseEvents = true; panel.hidesOnDeactivate = false
        panel.level = .floating; panel.sharingType = .none
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.contentView = view; view.name = name; view.hex = hex
    }
    func hide() { panel.orderOut(nil) }
    func place(_ point: CGPoint, target: CGRect, above: [WindowInfo], appearance: Appearance) {
        let origin = CGPoint(x: point.x - 28, y: point.y - 28)
        let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
        panel.setFrameOrigin(NSPoint(x: origin.x, y: primaryTop - origin.y - panel.frame.height))
        view.allowed = target.offsetBy(dx: -origin.x, dy: -origin.y)
        view.occlusions = above.map { $0.rect.offsetBy(dx: -origin.x, dy: -origin.y) }
        view.appearance = appearance; view.needsDisplay = true
        panel.orderFrontRegardless()
    }
}

private final class Engine {
    let fd: Int32
    var target: CGWindowID = 0, targetPid: pid_t = 0
    var frameWidth: Double = 0, frameHeight: Double = 0
    var enabled = false, controller = "", epoch: Double = 0
    var buttons = Set<Int>(), markers: [String: Marker] = [:]
    var lastInput: Double = 0, lastStatus = "", inputFailure = ""
    var cursorHidden = false, successfulInputs = 0
    var appearance = Appearance()
    var timer: Timer?
    init(fd: Int32) { self.fd = fd }
    var permissions: [String: Bool] { ["screen": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()] }
    func start() {
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in self?.tick() }
        tick()
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            var buffer = Data(), chunk = [UInt8](repeating: 0, count: 8192)
            // Bound main-thread work: a stalled helper must not replay a growing
            // queue of old clicks or delay cleanup indefinitely.
            let slots = DispatchSemaphore(value: 64)
            while true {
                let count = Darwin.read(fd, &chunk, chunk.count)
                if count <= 0 { break }
                buffer.append(contentsOf: chunk.prefix(count))
                while let newline = buffer.firstIndex(of: 10) {
                    let line = Data(buffer[..<newline]); buffer.removeSubrange(...newline)
                    if line.count > 65536 { DispatchQueue.main.async { self.shutdown() }; return }
                    slots.wait()
                    DispatchQueue.main.async {
                        defer { slots.signal() }
                        guard let data = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { self.revoke(); return }
                        self.handle(data)
                    }
                }
                if buffer.count > 65536 { break }
            }
            DispatchQueue.main.async { self.shutdown() }
        }
    }
    func reply(_ data: [String: Any]) {
        guard var bytes = try? JSONSerialization.data(withJSONObject: data) else { return }
        bytes.append(10)
        let ok = bytes.withUnsafeBytes { raw -> Bool in
            guard let base = raw.baseAddress else { return false }
            var sent = 0
            while sent < raw.count {
                let count = Darwin.write(fd, base.advanced(by: sent), raw.count - sent)
                if count < 0 && errno == EINTR { continue }
                if count <= 0 { return false }; sent += count
            }
            return true
        }
        if !ok { shutdown() }
    }
    func handle(_ d: [String: Any]) {
        let id = number(d, "id")
        do {
            switch string(d, "type") {
            case "permissions":
                if d["prompt"] as? Bool == true {
                    if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
                    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                    _ = AXIsProcessTrustedWithOptions(options)
                }
                reply(["id": id, "ok": true, "permissions": permissions]); lastStatus = ""; return
            case "windows":
                guard CGPreflightScreenCaptureAccess() else { throw failure("请先在系统设置中允许 GhostCursor 录制屏幕，退出并重新打开应用后重试") }
                let excluded = pid_t(number(d, "excludePid"))
                let list = windows().filter { $0.layer == 0 && $0.pid != getpid() && $0.pid != excluded && !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.prefix(256)
                reply(["id": id, "ok": true, "windows": list.map { ["id": "window:\($0.id):0", "name": $0.name, "thumbnail": ""] }]); return
            case "target":
                clear()
                guard let selected = CGWindowID(string(d, "hwnd")), let row = windows().first(where: { $0.id == selected && $0.layer == 0 && $0.pid != getpid() }) else { throw failure("目标窗口已关闭、隐藏或最小化") }
                target = selected; targetPid = row.pid
            case "frame": frameWidth = number(d, "width"); frameHeight = number(d, "height")
            case "appearance":
                let shape = string(d, "shape"), size = number(d, "size"), hex = string(d, "color")
                guard ["arrow", "ring", "crosshair"].contains(shape), [24.0, 32.0, 44.0].contains(size), hex.isEmpty || hex.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil else { throw failure("无效鼠标样式") }
                appearance = Appearance(shape: shape, size: size, hex: hex.isEmpty ? nil : hex)
            case "activate":
                try activate()
                let selected = target, pid = targetPid
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [self] in
                    if target == selected && targetPid == pid && isFocusedTarget() {
                        reply(["id": id, "ok": true, "enabled": enabled, "epoch": epoch])
                    } else {
                        reply(["id": id, "ok": false, "error": "macOS 未允许切换共享窗口，请手动切回后重新授权"])
                    }
                }
                return
            case "grant":
                revoke(); epoch = number(d, "epoch"); controller = string(d, "controller")
                if d["enabled"] as? Bool == true {
                    guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess() else { throw failure("请允许 GhostCursor 录制屏幕并使用辅助功能后重新授权") }
                    guard !controller.isEmpty else { throw failure("请先选择控制者") }
                    guard isFocusedTarget() else { throw failure("请将所选共享窗口切到前台后重新授权") }
                    let (_, reason) = available(windows())
                    guard reason.isEmpty else { throw failure(reason) }
                    enabled = true; lastInput = now()
                }
            case "pointer": pointer(d)
            case "remove":
                let visitor = string(d, "visitor"); markers.removeValue(forKey: visitor)?.panel.close()
                if visitor == controller { revoke() }
            case "clear": clear()
            case "shutdown": shutdown(); return
            case "snapshot":
                let (_, reason) = available(windows())
                reply(["id": id, "ok": true, "processId": getpid(), "successfulInputs": successfulInputs, "visibleMarkers": markers.values.filter { $0.panel.isVisible }.count, "available": reason.isEmpty, "reason": reason, "enabled": enabled, "epoch": epoch, "frameWidth": frameWidth, "frameHeight": frameHeight, "cursorHidden": cursorHidden, "permissions": permissions]); return
            default: throw failure("无效原生消息")
            }
            if id > 0 { reply(["id": id, "ok": true, "enabled": enabled, "epoch": epoch]) }
            tick()
        } catch {
            fault(error.localizedDescription)
            if id > 0 { reply(["id": id, "ok": false, "error": error.localizedDescription]) }
        }
    }
    func available(_ list: [WindowInfo]) -> (WindowInfo?, String) {
        if !inputFailure.isEmpty { return (nil, inputFailure) }
        if target == 0 { return (nil, "尚未选择共享窗口") }
        guard CGPreflightScreenCaptureAccess() else { return (nil, "录屏权限不可用，请在系统设置中重新允许 GhostCursor") }
        guard let row = list.first(where: { $0.id == target && $0.pid == targetPid }) else {
            let exists = (CGWindowListCopyWindowInfo(.optionIncludingWindow, target) as? [[String: Any]])?.contains { ($0[kCGWindowNumber as String] as? UInt32) == target } ?? false
            return (nil, exists ? "共享窗口已隐藏或最小化" : "共享窗口已关闭")
        }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid else { return (nil, "请将共享窗口切到前台；切换应用会收回控制") }
        guard frameWidth > 0, frameHeight > 0 else { return (nil, "等待共享画面就绪") }
        let ratio = abs((frameWidth / frameHeight) / (row.rect.width / row.rect.height) - 1)
        guard ratio <= 0.025 else { return (nil, "画面尺寸与窗口不匹配，已暂停标记和控制；请恢复窗口或重新共享") }
        if enabled && !AXIsProcessTrusted() { return (nil, "辅助功能权限已撤销，已停止远程控制") }
        if enabled && !isFocusedTarget() { return (nil, "共享窗口已失去焦点，已收回控制") }
        return (row, "")
    }
    func above(_ list: [WindowInfo]) -> [WindowInfo] {
        Array(list.prefix(while: { $0.id != target }).filter { $0.pid != getpid() })
    }
    func pointVisible(_ point: CGPoint, row: WindowInfo, covering: [WindowInfo]) -> Bool {
        row.rect.contains(point) && !covering.contains(where: { $0.rect.contains(point) })
    }
    func focusedWindow() -> AXUIElement? {
        let application = AXUIElementCreateApplication(targetPid)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &value) == .success, let list = value as? [AXUIElement], let row = windows().first(where: { $0.id == target && $0.pid == targetPid }) else { return nil }
        // Resolve using the OS-reported window geometry; don't use private AX
        // window-number APIs or silently target a different application window.
        let matches = list.filter { element in
            var position: CFTypeRef?, size: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &position) == .success,
                  AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &size) == .success,
                  let p = position, let s = size, CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return false }
            var origin = CGPoint.zero, dimensions = CGSize.zero
            guard AXValueGetValue(unsafeBitCast(p, to: AXValue.self), .cgPoint, &origin), AXValueGetValue(unsafeBitCast(s, to: AXValue.self), .cgSize, &dimensions) else { return false }
            return abs(origin.x - row.rect.minX) < 2 && abs(origin.y - row.rect.minY) < 2 && abs(dimensions.width - row.rect.width) < 2 && abs(dimensions.height - row.rect.height) < 2
        }
        return matches.count == 1 ? matches[0] : nil
    }
    func activate() throws {
        guard AXIsProcessTrusted() else { throw failure("请先在系统设置 → 隐私与安全性 → 辅助功能中允许 GhostCursor") }
        guard target != 0, let application = NSRunningApplication(processIdentifier: targetPid), let element = focusedWindow() else { throw failure("无法确定共享窗口，请恢复目标窗口后重试") }
        inputFailure = ""
        _ = AXUIElementSetAttributeValue(element, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
        guard AXUIElementPerformAction(element, kAXRaiseAction as CFString) == .success else { throw failure("macOS 未允许切换共享窗口，请手动切回后重试") }
        _ = AXUIElementSetAttributeValue(element, kAXMainAttribute as CFString, kCFBooleanTrue)
        application.activate(options: [.activateIgnoringOtherApps])
        // Respond on a later main-loop turn so activation can settle without
        // blocking the timer. The following grant validates foreground again.
    }
    func isFocusedTarget() -> Bool {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid, let selected = focusedWindow() else { return false }
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(targetPid), kAXFocusedWindowAttribute as CFString, &focused) == .success, let value = focused else { return false }
        return CFEqual(value, selected)
    }
    func pointer(_ d: [String: Any]) {
        let visitor = string(d, "visitor"), action = string(d, "action")
        guard !visitor.isEmpty, target != 0 else { return }
        let inject = d["inject"] as? Bool == true && enabled && visitor == controller && epoch == number(d, "epoch") && !["touch-start", "touch-end"].contains(action)
        if ["leave", "release", "touch-end"].contains(action) {
            markers[visitor]?.lastSeen = 0; markers[visitor]?.hide()
            if inject { releaseButtons() }; restoreCursor(); return
        }
        guard abs(now() - number(d, "sentAt")) <= 250 else { if inject { releaseButtons() }; return }
        let x = number(d, "x"), y = number(d, "y")
        guard x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y) else { return }
        if markers[visitor] == nil && markers.count < 8 { markers[visitor] = Marker(name: string(d, "name"), hex: string(d, "color")) }
        guard let marker = markers[visitor] else { return }
        marker.x = x; marker.y = y; marker.lastSeen = now(); marker.view.touch = ["touch", "pen"].contains(string(d, "pointerType"))
        let list = windows(), (selected, reason) = available(list)
        guard let row = selected else { revoke(); marker.hide(); return }
        let point = CGPoint(x: row.rect.minX + x * (row.rect.width - 1), y: row.rect.minY + y * (row.rect.height - 1)), covering = above(list)
        guard pointVisible(point, row: row, covering: covering) else {
            marker.hide(); if inject { fault("操作位置被其他窗口遮挡，已收回控制，请重新授权") }; return
        }
        _ = reason
        if !enabled || visitor == controller { marker.place(point, target: row.rect, above: covering, appearance: appearance) } else { marker.hide() }
        guard inject else { return }
        guard AXIsProcessTrusted() else { fault("辅助功能权限不可用，已收回控制"); return }
        lastInput = now()
        if action == "up" {
            let button = Int(number(d, "button"))
            if buttons.remove(button) != nil { postButton(button, down: false, at: point) }
            return
        }
        let dragged = buttons.sorted().first
        let moveType: CGEventType = dragged == 0 ? .leftMouseDragged : dragged == 2 ? .rightMouseDragged : dragged == 1 ? .otherMouseDragged : .mouseMoved
        guard let move = CGEvent(mouseEventSource: nil, mouseType: moveType, mouseCursorPosition: point, mouseButton: cgButton(dragged ?? 0)) else { fault("无法创建鼠标输入，已收回控制"); return }
        move.post(tap: .cghidEventTap); successfulInputs += 1
        if action == "down" {
            let button = Int(number(d, "button"))
            if (0...2).contains(button), buttons.insert(button).inserted { postButton(button, down: true, at: point) }
        } else if action == "wheel" {
            let delta = Int32(max(-1200, min(1200, -number(d, "delta"))))
            if let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: delta, wheel2: 0, wheel3: 0) { event.post(tap: .cghidEventTap); successfulInputs += 1 }
        }
    }
    func cgButton(_ button: Int) -> CGMouseButton { button == 2 ? .right : button == 1 ? .center : .left }
    func postButton(_ button: Int, down: Bool, at: CGPoint) {
        let type: CGEventType = button == 0 ? (down ? .leftMouseDown : .leftMouseUp) : button == 2 ? (down ? .rightMouseDown : .rightMouseUp) : (down ? .otherMouseDown : .otherMouseUp)
        if let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: at, mouseButton: cgButton(button)) { event.post(tap: .cghidEventTap); successfulInputs += 1 }
    }
    func releaseButtons() {
        let point = CGEvent(source: nil)?.location ?? .zero
        for button in buttons { postButton(button, down: false, at: point) }; buttons.removeAll()
    }
    func restoreCursor() { if cursorHidden { _ = CGDisplayShowCursor(CGMainDisplayID()); cursorHidden = false } }
    func revoke() { enabled = false; releaseButtons(); restoreCursor() }
    func fault(_ reason: String) { inputFailure = reason; revoke(); lastStatus = ""; tick() }
    func clear() {
        revoke(); target = 0; targetPid = 0; controller = ""; frameWidth = 0; frameHeight = 0
        for marker in markers.values { marker.panel.close() }; markers.removeAll(); inputFailure = ""; lastStatus = ""
    }
    func tick() {
        let list = target == 0 ? [] : windows(), (selected, reason) = available(list)
        if selected == nil { revoke() }
        if !buttons.isEmpty && now() - lastInput > 1500 { releaseButtons() }
        let covering = above(list), actual = CGEvent(source: nil)?.location
        var showingController = false
        for (visitor, marker) in markers {
            guard let row = selected, (!enabled || visitor == controller), now() - marker.lastSeen <= 1800 else { marker.hide(); continue }
            var point = CGPoint(x: row.rect.minX + marker.x * (row.rect.width - 1), y: row.rect.minY + marker.y * (row.rect.height - 1))
            if enabled && visitor == controller, let location = actual { point = location }
            guard pointVisible(point, row: row, covering: covering) else { marker.hide(); continue }
            marker.place(point, target: row.rect, above: covering, appearance: appearance)
            if enabled && visitor == controller { showingController = true }
        }
        if enabled && showingController && !cursorHidden {
            if CGDisplayHideCursor(CGMainDisplayID()) == .success { cursorHidden = true }
            else { fault("无法接管共享窗口的鼠标显示，已收回控制"); return }
        } else if !enabled || !showingController { restoreCursor() }
        let p = permissions
        let status = "\(reason):\(enabled):\(epoch):\(p["screen"] == true):\(p["accessibility"] == true)"
        if status != lastStatus {
            lastStatus = status
            reply(["type": "status", "available": selected != nil, "enabled": enabled, "epoch": epoch, "reason": reason, "closed": reason == "共享窗口已关闭", "permissions": p])
        }
    }
    func shutdown() { timer?.invalidate(); clear(); Darwin.close(fd); NSApplication.shared.terminate(nil) }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
guard CommandLine.arguments.count == 2 else { exit(1) }
let path = CommandLine.arguments[1]
guard path.hasSuffix("/ipc"), path.utf8.count < 104 else { exit(1) }
var socketStat = stat()
guard lstat(path, &socketStat) == 0, socketStat.st_uid == getuid(), (socketStat.st_mode & S_IFMT) == S_IFSOCK else { exit(1) }
let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
guard fd >= 0 else { exit(1) }
var noSignal: Int32 = 1
setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
var address = sockaddr_un()
address.sun_family = sa_family_t(AF_UNIX)
address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
withUnsafeMutableBytes(of: &address.sun_path) { destination in
    path.utf8CString.withUnsafeBytes { source in destination.copyMemory(from: source) }
}
let result = withUnsafePointer(to: &address) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
}
guard result == 0 else { Darwin.close(fd); exit(1) }
private let engine = Engine(fd: fd)
engine.start()
app.run()
