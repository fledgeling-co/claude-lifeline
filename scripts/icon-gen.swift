// Draws the lifeline app icon to a 1024×1024 PNG at argv[1]. Self-contained (CoreGraphics),
// so the release build can generate the icon in CI without committing a binary asset.
// The mark: a graphite squircle ground with the mint recovery-pulse line — flatline that
// recovers — the same glyph the menu-bar item uses.
import AppKit

let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
let S: CGFloat = 1024

let img = NSImage(size: NSSize(width: S, height: S))
img.lockFocus()
guard let ctx = NSGraphicsContext.current?.cgContext else { fatalError("no context") }

// Ground: a vertical graphite gradient inside the macOS squircle.
let inset: CGFloat = S * 0.09
let rect = CGRect(x: inset, y: inset, width: S - inset * 2, height: S - inset * 2)
let radius = rect.width * 0.2237 // Apple continuous-corner ratio
let squircle = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
ctx.saveGState()
squircle.addClip()
let top = CGColor(red: 0.16, green: 0.17, blue: 0.20, alpha: 1)
let bottom = CGColor(red: 0.10, green: 0.11, blue: 0.13, alpha: 1)
let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [top, bottom] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(grad, start: CGPoint(x: 0, y: rect.maxY), end: CGPoint(x: 0, y: rect.minY), options: [])
ctx.restoreGState()

// A faint inner top highlight for depth (one light source, top).
ctx.saveGState()
squircle.addClip()
ctx.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.06))
ctx.setLineWidth(3)
ctx.addPath(NSBezierPath(roundedRect: rect.insetBy(dx: 2, dy: 2), xRadius: radius, yRadius: radius).cgPathCompat)
ctx.strokePath()
ctx.restoreGState()

// The pulse line: flatline in, a spike that recovers, flatline out — mint, rounded, with a
// soft glow. Points are fractions of the inner rect.
let mint = CGColor(red: 0.0, green: 0.784, blue: 0.702, alpha: 1)
let pts: [(CGFloat, CGFloat)] = [
    (0.10, 0.50), (0.34, 0.50), (0.41, 0.40), (0.47, 0.50), (0.53, 0.50),
    (0.62, 0.82), (0.71, 0.20), (0.78, 0.58), (0.90, 0.58),
]
let line = NSBezierPath()
for (idx, p) in pts.enumerated() {
    let x = rect.minX + p.0 * rect.width
    let y = rect.minY + p.1 * rect.height
    if idx == 0 { line.move(to: NSPoint(x: x, y: y)) } else { line.line(to: NSPoint(x: x, y: y)) }
}
line.lineWidth = S * 0.035
line.lineCapStyle = .round
line.lineJoinStyle = .round

ctx.saveGState()
ctx.setShadow(offset: .zero, blur: S * 0.03, color: CGColor(red: 0.0, green: 0.784, blue: 0.702, alpha: 0.6))
ctx.setStrokeColor(mint)
ctx.addPath(line.cgPathCompat)
ctx.setLineWidth(line.lineWidth)
ctx.setLineCap(.round)
ctx.setLineJoin(.round)
ctx.strokePath()
ctx.restoreGState()

img.unlockFocus()

guard let tiff = img.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else { fatalError("encode failed") }
try! png.write(to: URL(fileURLWithPath: outPath))

// NSBezierPath → CGPath bridge (macOS < 14 lacks `.cgPath`).
extension NSBezierPath {
    var cgPathCompat: CGPath {
        let path = CGMutablePath()
        var points = [NSPoint](repeating: .zero, count: 3)
        for i in 0..<elementCount {
            switch element(at: i, associatedPoints: &points) {
            case .moveTo: path.move(to: points[0])
            case .lineTo: path.addLine(to: points[0])
            case .curveTo: path.addCurve(to: points[2], control1: points[0], control2: points[1])
            case .closePath: path.closeSubpath()
            default: break
            }
        }
        return path
    }
}
