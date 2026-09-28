import AppKit
import Foundation

let args = CommandLine.arguments
if args.count < 3 {
  fputs("usage: caption out.png text\n", stderr)
  exit(1)
}

let wide = 1280
let high = 720
guard let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil,
  pixelsWide: wide,
  pixelsHigh: high,
  bitsPerSample: 8,
  samplesPerPixel: 4,
  hasAlpha: true,
  isPlanar: false,
  colorSpaceName: .deviceRGB,
  bytesPerRow: 0,
  bitsPerPixel: 0
) else {
  fputs("bitmap failed\n", stderr)
  exit(1)
}
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSColor.clear.setFill()
NSBezierPath(rect: NSRect(x: 0, y: 0, width: wide, height: high)).fill()

let para = NSMutableParagraphStyle()
para.alignment = .center
let font = NSFont(name: "PingFangSC-Medium", size: 34) ?? NSFont.systemFont(ofSize: 34, weight: .medium)
let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(0.85)
shadow.shadowBlurRadius = 6
shadow.shadowOffset = NSSize(width: 0, height: -1)
let attrs: [NSAttributedString.Key: Any] = [
  .font: font,
  .foregroundColor: NSColor.white,
  .paragraphStyle: para,
  .shadow: shadow,
]
let text = args[2] as NSString
text.draw(in: NSRect(x: 80, y: 28, width: 1120, height: 110), withAttributes: attrs)
NSGraphicsContext.restoreGraphicsState()

guard let png = rep.representation(using: .png, properties: [:]) else {
  fputs("png encode failed\n", stderr)
  exit(1)
}

do {
  try png.write(to: URL(fileURLWithPath: args[1]))
} catch {
  fputs("write failed\n", stderr)
  exit(1)
}
