import AppKit
import Foundation

let args = CommandLine.arguments
if args.count < 4 {
  fputs("usage: framecard out.png title body\n", stderr)
  exit(1)
}

let size = NSSize(width: 1280, height: 720)
let image = NSImage(size: size)
image.lockFocus()
NSColor(srgbRed: 0.110, green: 0.157, blue: 0.196, alpha: 1).setFill()
NSBezierPath(rect: NSRect(origin: .zero, size: size)).fill()
NSColor(srgbRed: 0.769, green: 0.361, blue: 0.149, alpha: 1).setFill()
NSBezierPath(rect: NSRect(x: 0, y: 0, width: 14, height: size.height)).fill()

let titleAttrs: [NSAttributedString.Key: Any] = [
  .font: NSFont.systemFont(ofSize: 28, weight: .semibold),
  .foregroundColor: NSColor(srgbRed: 0.956, green: 0.945, blue: 0.918, alpha: 1),
]
let bodyAttrs: [NSAttributedString.Key: Any] = [
  .font: NSFont.systemFont(ofSize: 34, weight: .regular),
  .foregroundColor: NSColor.white,
]
let titleRect = NSRect(x: 48, y: 620, width: 1180, height: 56)
let bodyRect = NSRect(x: 48, y: 250, width: 1180, height: 340)
(args[2] as NSString).draw(in: titleRect, withAttributes: titleAttrs)
(args[3] as NSString).draw(in: bodyRect, withAttributes: bodyAttrs)
image.unlockFocus()

guard
  let tiff = image.tiffRepresentation,
  let rep = NSBitmapImageRep(data: tiff),
  let png = rep.representation(using: .png, properties: [:])
else {
  fputs("png encode failed\n", stderr)
  exit(1)
}

do {
  try png.write(to: URL(fileURLWithPath: args[1]))
} catch {
  fputs("write failed\n", stderr)
  exit(1)
}
