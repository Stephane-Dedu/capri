// Capri's hands on macOS: reads the text you've selected in the front app and
// replaces it, checks the clipboard, reads your calendar, and watches
// notification banners, all through public APIs (Accessibility, AppKit,
// EventKit). A long-running helper: one JSON request per line on stdin, one
// JSON reply per line on stdout, plus {"event": ...} lines for notifications.
// Built on first use with `swiftc -O -parse-as-library tools/capri-mac.swift`.
// Exits when stdin closes (Capri quit).
//
//   {"id":1,"op":"selection"}            -> {"id":1,"app":"Safari","text":"..."}
//   {"id":2,"op":"replace","text":"..."} -> {"id":2,"ok":true,"via":"ax"|"paste"}
//   {"id":3,"op":"clipboard"}            -> {"id":3,"text":"...","age":12.5,"concealed":false}
//   {"id":4,"op":"events","hours":12}    -> {"id":4,"events":[...]} or {"id":4,"error":"denied"}
//   {"op":"notifications","on":true}     -> {"event":"notification","app":"Slack","title":...,"subtitle":...,"body":...}

import AppKit
import ApplicationServices
import EventKit
import Foundation

let out = FileHandle.standardOutput

func send(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
  out.write(data + Data([10]))
}

func attr(_ element: AXUIElement, _ name: String) -> AnyObject? {
  var value: AnyObject?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

// ---- selection ---------------------------------------------------------------

func focusedElement() -> AXUIElement? {
  guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
  let element = AXUIElementCreateApplication(app.processIdentifier)
  // Electron apps (Slack, VS Code, Notion…) build their accessibility tree only when asked.
  AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  guard let focused = attr(element, kAXFocusedUIElementAttribute) else { return nil }
  return (focused as! AXUIElement)
}

func selection() -> [String: Any] {
  let app = NSWorkspace.shared.frontmostApplication
  let focused = focusedElement()
  var text = focused.flatMap { attr($0, kAXSelectedTextAttribute) as? String } ?? ""
  // No focused element at all (Electron apps, Chrome): ask the app to copy
  // instead, and put the clipboard back right after.
  if focused == nil { text = copySelection() }
  return ["app": app?.localizedName ?? "", "bundle": app?.bundleIdentifier ?? "", "text": String(text.prefix(40000))]
}

func savedItems(_ board: NSPasteboard) -> [NSPasteboardItem] {
  (board.pasteboardItems ?? []).map { item -> NSPasteboardItem in
    let copy = NSPasteboardItem()
    for type in item.types { if let data = item.data(forType: type) { copy.setData(data, forType: type) } }
    return copy
  }
}

// Puts the clipboard back, without it counting as something you copied.
func restore(_ board: NSPasteboard, _ items: [NSPasteboardItem]) {
  board.clearContents()
  if !items.isEmpty { board.writeObjects(items) }
  changeCount = board.changeCount
}

func pressKey(_ key: CGKeyCode) {
  let source = CGEventSource(stateID: .combinedSessionState)
  for down in [true, false] {
    let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down)
    event?.flags = .maskCommand
    event?.post(tap: .cghidEventTap)
  }
}

// ⌘C on your behalf, once you've let go of the summon shortcut (or it would
// be ⌘⇧C). Nothing selected usually means nothing copied.
func copySelection() -> String {
  let held: CGEventFlags = [.maskCommand, .maskShift, .maskAlternate, .maskControl]
  let deadline = Date().addingTimeInterval(0.8)
  while !CGEventSource.flagsState(.hidSystemState).intersection(held).isEmpty && Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
  let board = NSPasteboard.general
  let saved = savedItems(board)
  let before = board.changeCount
  pressKey(8)  // C
  let wait = Date().addingTimeInterval(0.3)
  while board.changeCount == before && Date() < wait { Thread.sleep(forTimeInterval: 0.02) }
  guard board.changeCount != before else { return "" }
  let text = board.string(forType: .string) ?? ""
  restore(board, saved)
  return text
}

// Replace the selection: through Accessibility where the app supports it,
// otherwise by pasting (the clipboard is put back afterwards).
func replace(_ text: String) -> [String: Any] {
  if let focused = focusedElement() {
    let before = attr(focused, kAXValueAttribute) as? String
    if AXUIElementSetAttributeValue(focused, kAXSelectedTextAttribute as CFString, text as CFTypeRef) == .success,
      let after = attr(focused, kAXValueAttribute) as? String, after != before
    {
      return ["ok": true, "via": "ax"]
    }
  }
  let board = NSPasteboard.general
  let saved = savedItems(board)
  board.clearContents()
  board.setString(text, forType: .string)
  changeCount = board.changeCount
  pressKey(9)  // V
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { restore(board, saved) }
  return ["ok": true, "via": "paste"]
}

// ---- clipboard ---------------------------------------------------------------

var changeCount = NSPasteboard.general.changeCount
var changedAt = Date.distantPast

func watchClipboard() {
  changeCount = NSPasteboard.general.changeCount  // globals are lazy: read it now, not at the first tick
  Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
    let count = NSPasteboard.general.changeCount
    if count != changeCount {
      changeCount = count
      changedAt = Date()
    }
  }
}

// Password managers mark what they copy (nspasteboard.org); never read those.
let secretTypes = ["org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType", "org.nspasteboard.AutoGeneratedType"]

func clipboard() -> [String: Any] {
  let board = NSPasteboard.general
  let types = (board.types ?? []).map { $0.rawValue }
  let concealed = types.contains { secretTypes.contains($0) }
  let text = concealed ? "" : (board.string(forType: .string) ?? "")
  return ["text": String(text.prefix(20000)), "age": Date().timeIntervalSince(changedAt), "concealed": concealed]
}

// ---- calendar ----------------------------------------------------------------

let store = EKEventStore()
let iso = ISO8601DateFormatter()
let meetingLink = try! NSRegularExpression(pattern: "https?://[^\\s]*(meet\\.google\\.com|zoom\\.us|teams\\.microsoft\\.com|teams\\.live\\.com|whereby\\.com|around\\.co)[^\\s]*", options: .caseInsensitive)

func events(hours: Double, reply: @escaping ([String: Any]) -> Void) {
  let list = {
    let now = Date()
    let predicate = store.predicateForEvents(withStart: now.addingTimeInterval(-3600), end: now.addingTimeInterval(hours * 3600), calendars: nil)
    let found = store.events(matching: predicate).filter { !$0.isAllDay }.map { e -> [String: Any] in
      let haystack = [e.location ?? "", e.notes ?? "", e.url?.absoluteString ?? ""].joined(separator: " ")
      let range = NSRange(haystack.startIndex..., in: haystack)
      return [
        "title": e.title ?? "",
        "start": iso.string(from: e.startDate),
        "end": iso.string(from: e.endDate),
        "attendees": e.attendees?.count ?? 0,
        "link": meetingLink.firstMatch(in: haystack, range: range) != nil,
        "calendar": e.calendar.title,
      ]
    }
    reply(["events": found])
  }
  switch EKEventStore.authorizationStatus(for: .event) {
  case .fullAccess, .authorized: list()
  case .notDetermined:
    store.requestFullAccessToEvents { granted, _ in
      DispatchQueue.main.async { granted ? list() : reply(["error": "denied"]) }
    }
  default: reply(["error": "denied"])
  }
}

// ---- notifications -------------------------------------------------------------

// Banners are groups in Notification Center's window, each with a stable
// identifier and title / subtitle / body texts.
var seen: Set<String>? = nil
var watcher: Timer?

func banners(in element: AXUIElement, into found: inout [AXUIElement], depth: Int = 0) {
  if depth > 8 { return }
  let subrole = attr(element, kAXSubroleAttribute) as? String ?? ""
  if subrole == "AXNotificationCenterBanner" || subrole == "AXNotificationCenterAlert" {
    found.append(element)
    return
  }
  for child in (attr(element, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { banners(in: child, into: &found, depth: depth + 1) }
}

func scanNotifications() {
  guard let center = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.notificationcenterui").first else { return }
  let app = AXUIElementCreateApplication(center.processIdentifier)
  var found: [AXUIElement] = []
  for window in (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? [] { banners(in: window, into: &found) }
  var ids = Set<String>()
  for banner in found {
    guard let id = attr(banner, kAXIdentifierAttribute) as? String else { continue }
    ids.insert(id)
    if seen == nil || seen!.contains(id) { continue }
    var texts: [String: String] = [:]
    for child in (attr(banner, kAXChildrenAttribute) as? [AXUIElement]) ?? [] {
      if let key = attr(child, kAXIdentifierAttribute) as? String, let value = attr(child, kAXValueAttribute) as? String { texts[key] = value }
    }
    // The description starts with the app's name: "Slack, Marc, #general, hey…".
    let app = (attr(banner, kAXDescriptionAttribute) as? String ?? "").components(separatedBy: ", ").first ?? ""
    send(["event": "notification", "app": app, "title": texts["title"] ?? "", "subtitle": texts["subtitle"] ?? "", "body": texts["body"] ?? ""])
  }
  seen = (seen ?? []).union(ids)
  if seen!.count > 500 { seen = ids }
}

// ---- requests ------------------------------------------------------------------

func handle(_ line: String) {
  guard let data = line.data(using: .utf8), let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let op = request["op"] as? String else { return }
  let id = request["id"] ?? NSNull()
  let reply = { (result: [String: Any]) in send(result.merging(["id": id]) { a, _ in a }) }
  switch op {
  case "selection": reply(selection())
  case "replace": reply(replace(request["text"] as? String ?? ""))
  case "clipboard": reply(clipboard())
  case "events": events(hours: request["hours"] as? Double ?? 12, reply: reply)
  case "notifications":
    watcher?.invalidate()
    watcher = nil
    seen = nil
    if request["on"] as? Bool == true {
      scanNotifications()  // what's already there is old news
      if seen == nil { seen = [] }
      watcher = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in scanNotifications() }
    }
  default: reply(["error": "unknown op \(op)"])
  }
}

@main
struct CapriMac {
  static func main() {
    _ = NSApplication.shared  // AppKit services (pasteboard, workspace) without a UI
    watchClipboard()
    Thread.detachNewThread {
      while let line = readLine() {
        DispatchQueue.main.async { handle(line) }
      }
      exit(0)
    }
    RunLoop.main.run()
  }
}
