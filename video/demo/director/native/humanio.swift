// humanio: posts real macOS mouse and keyboard events, one command per stdin
// line, so screen recorders (Recordly) see genuine cursor movement and clicks.
//
//   move <x> <y>            move the cursor (global points)
//   drag <x> <y>            move with the left button held
//   down | up               left button
//   type <text>             type text (unicode, one keystroke per character)
//   key <combo>             e.g. "cmd+v", "enter", "tab", "escape", "cmd+a"
//   sleep <ms>              wait
//   pos                     print the cursor position as "x y"
//
// Requires Accessibility permission for the app that runs it.
// Build: swiftc -O humanio.swift -o humanio

import Foundation
import CoreGraphics

let src = CGEventSource(stateID: .hidSystemState)
var buttonDown = false

func currentPos() -> CGPoint {
    return CGEvent(source: nil)?.location ?? .zero
}

func mouse(_ type: CGEventType, _ p: CGPoint) {
    let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .left)
    // Never inherit a modifier from an earlier shortcut (cmd+v): a click
    // carrying Command opens links in a new window.
    e?.flags = []
    e?.post(tap: .cghidEventTap)
}

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "o": 31, "u": 32,
    "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
    "enter": 36, "return": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53,
    "left": 123, "right": 124, "down": 125, "up": 126,
]

func key(_ combo: String) {
    var flags: CGEventFlags = []
    var name = ""
    for part in combo.lowercased().split(separator: "+") {
        switch part {
        case "cmd": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "opt": flags.insert(.maskAlternate)
        case "ctrl": flags.insert(.maskControl)
        default: name = String(part)
        }
    }
    guard let code = keyCodes[name] else {
        FileHandle.standardError.write("unknown key \(name)\n".data(using: .utf8)!)
        return
    }
    let d = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)
    let u = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
    d?.flags = flags
    u?.flags = flags
    d?.post(tap: .cghidEventTap)
    usleep(30_000)
    u?.post(tap: .cghidEventTap)
}

func typeChar(_ ch: Character) {
    let utf16 = Array(String(ch).utf16)
    let d = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)
    let u = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
    d?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
    u?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
    d?.flags = []
    u?.flags = []
    d?.post(tap: .cghidEventTap)
    usleep(12_000)
    u?.post(tap: .cghidEventTap)
}

setvbuf(stdout, nil, _IOLBF, 0)
while let line = readLine(strippingNewline: true) {
    let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
    guard let cmd = parts.first else { continue }
    let arg = parts.count > 1 ? parts[1] : ""
    switch cmd {
    case "move", "drag":
        let xy = arg.split(separator: " ").compactMap { Double($0) }
        guard xy.count == 2 else { continue }
        let p = CGPoint(x: xy[0], y: xy[1])
        mouse(buttonDown ? .leftMouseDragged : .mouseMoved, p)
    case "down":
        buttonDown = true
        mouse(.leftMouseDown, currentPos())
    case "up":
        buttonDown = false
        mouse(.leftMouseUp, currentPos())
    case "type":
        for ch in arg { typeChar(ch) }
    case "key":
        key(arg)
    case "sleep":
        if let ms = Double(arg) { usleep(useconds_t(ms * 1000)) }
    case "pos":
        let p = currentPos()
        print("\(Int(p.x)) \(Int(p.y))")
    default:
        FileHandle.standardError.write("unknown command \(cmd)\n".data(using: .utf8)!)
    }
    if cmd != "pos" { print("ok") }
}
