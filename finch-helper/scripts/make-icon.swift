#!/usr/bin/env swift
// Renders the Finch Help mini tool icon (256x256 PNG).
// Usage: swift scripts/make-icon.swift <output.png>
import AppKit

let size = NSSize(width: 256, height: 256)
let image = NSImage(size: size)
image.lockFocus()

let rect = NSRect(x: 0, y: 0, width: 256, height: 256)

// Rounded-square background with a Finch-green gradient (top-left -> bottom-right)
let path = NSBezierPath(roundedRect: rect, xRadius: 56, yRadius: 56)
let gradient = NSGradient(
  starting: NSColor(calibratedRed: 0.45, green: 0.76, blue: 0.59, alpha: 1),
  ending: NSColor(calibratedRed: 0.23, green: 0.42, blue: 0.33, alpha: 1)
)
gradient?.draw(in: path, angle: -45)

// Subtle inner ring hint (chat bubble feel)
let ring = NSBezierPath(ovalIn: NSRect(x: 66, y: 66, width: 124, height: 124))
ring.lineWidth = 4
NSColor(calibratedWhite: 1, alpha: 0.18).setStroke()
ring.stroke()

// Bold white question mark
let font = NSFont.systemFont(ofSize: 190, weight: .heavy)
let attrs: [NSAttributedString.Key: Any] = [
  .font: font,
  .foregroundColor: NSColor.white,
]
let str = NSAttributedString(string: "?", attributes: attrs)
let strSize = str.size()
let strPoint = NSPoint(
  x: (256 - strSize.width) / 2,
  y: (256 - strSize.height) / 2 - 12
)
str.draw(at: strPoint)

image.unlockFocus()

guard
  let tiff = image.tiffRepresentation,
  let rep = NSBitmapImageRep(data: tiff),
  let png = rep.representation(using: .png, properties: [:])
else {
  fputs("failed to render icon\n", stderr)
  exit(1)
}
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
try! png.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
