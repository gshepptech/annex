// Draws Annex's app icon: the lavender square from the page's logo on a charcoal tile, with a door
// swing in the corner, the plan mark the offices are drawn with. Usage: swift icon.swift out.png

import Cocoa

let size: CGFloat = 1024
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
let tile = NSRect(x: 100, y: 100, width: 824, height: 824)
NSColor(red: 15 / 255, green: 16 / 255, blue: 17 / 255, alpha: 1).setFill()
NSBezierPath(roundedRect: tile, xRadius: 185, yRadius: 185).fill()
NSColor(red: 52 / 255, green: 52 / 255, blue: 58 / 255, alpha: 1).setStroke()
let edge = NSBezierPath(roundedRect: tile.insetBy(dx: 2, dy: 2), xRadius: 183, yRadius: 183)
edge.lineWidth = 4
edge.stroke()

let mark = NSRect(x: 282, y: 282, width: 460, height: 460)
NSColor(red: 94 / 255, green: 106 / 255, blue: 210 / 255, alpha: 1).setFill()
NSBezierPath(roundedRect: mark, xRadius: 92, yRadius: 92).fill()

// a door in plan: the leaf, and its swing as a quarter arc
NSColor.white.setStroke()
let hinge = NSPoint(x: mark.minX + 120, y: mark.minY + 120)
let leaf = NSBezierPath()
leaf.move(to: hinge)
leaf.line(to: NSPoint(x: hinge.x, y: hinge.y + 220))
leaf.lineWidth = 30
leaf.lineCapStyle = .round
leaf.stroke()
let swing = NSBezierPath()
swing.appendArc(withCenter: hinge, radius: 220, startAngle: 90, endAngle: 0, clockwise: true)
swing.lineWidth = 18
swing.lineCapStyle = .round
swing.setLineDash([2, 34], count: 2, phase: 0)
swing.stroke()
image.unlockFocus()

let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
