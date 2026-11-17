// filmstrip <video> <out.png> [frames]: a grid of evenly spaced frames, each stamped with its time,
// and one JSON line on stdout: duration, frame count and the longest gap between frames.
import AVFoundation
import CoreText
import Foundation

let args = CommandLine.arguments
guard args.count >= 3 else { FileHandle.standardError.write("usage: filmstrip <video> <out.png> [frames]\n".data(using: .utf8)!); exit(2) }
let url = URL(fileURLWithPath: args[1])
let out = URL(fileURLWithPath: args[2])
let count = max(2, min(16, Int(args.count > 3 ? args[3] : "8") ?? 8))

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

let sem = DispatchSemaphore(value: 0)
Task {
    do {
        let asset = AVURLAsset(url: url)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { fail("no video track") }
        let duration = try await asset.load(.duration).seconds
        let natural = try await track.load(.naturalSize)
        let transform = try await track.load(.preferredTransform)
        let size = natural.applying(transform)
        let width = abs(size.width), height = abs(size.height)

        // Sample times only (no decode), so a long clip stays fast.
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        reader.add(output)
        reader.startReading()
        var times: [Double] = []
        while let sample = output.copyNextSampleBuffer() {
            if CMSampleBufferGetNumSamples(sample) > 0 { times.append(CMSampleBufferGetPresentationTimeStamp(sample).seconds) }
        }
        times.sort()
        var gap = 0.0, gapAt = 0.0
        for (a, b) in zip(times, times.dropFirst()) where b - a > gap { gap = b - a; gapAt = b }

        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = CMTime(value: 1, timescale: 30)
        let cellHeight = 640.0
        let cellWidth = (cellHeight * width / height).rounded()
        generator.maximumSize = CGSize(width: cellWidth * 2, height: cellHeight * 2)

        let portrait = height >= width
        let columns = portrait ? min(count, 4) : 2
        let rows = Int((Double(count) / Double(columns)).rounded(.up))
        let gutter = 12.0, label = 44.0
        let canvas = CGSize(width: Double(columns) * cellWidth + Double(columns + 1) * gutter,
                            height: Double(rows) * (cellHeight + label) + Double(rows + 1) * gutter)
        guard let ctx = CGContext(data: nil, width: Int(canvas.width), height: Int(canvas.height), bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { fail("no context") }
        ctx.setFillColor(CGColor(red: 0.09, green: 0.09, blue: 0.1, alpha: 1))
        ctx.fill(CGRect(origin: .zero, size: canvas))
        let font = CTFontCreateUIFontForLanguage(.system, 26, nil)!

        for k in 0..<count {
            let t = duration * (Double(k) + 0.5) / Double(count)
            let col = k % columns, row = k / columns
            let x = gutter + Double(col) * (cellWidth + gutter)
            let top = canvas.height - gutter - Double(row) * (cellHeight + label + gutter)
            let frame = CGRect(x: x, y: top - cellHeight, width: cellWidth, height: cellHeight)
            if let image = try? await generator.image(at: CMTime(seconds: t, preferredTimescale: 600)).image {
                ctx.draw(image, in: frame)
            }
            let text = NSAttributedString(string: String(format: "%.1f s", t),
                                          attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font, NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0.85, alpha: 1)])
            ctx.textPosition = CGPoint(x: x + 4, y: frame.minY - label + 12)
            CTLineDraw(CTLineCreateWithAttributedString(text), ctx)
        }
        guard let image = ctx.makeImage(), let dest = CGImageDestinationCreateWithURL(out as CFURL, "public.png" as CFString, 1, nil)
        else { fail("could not write \(out.path)") }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else { fail("could not write \(out.path)") }
        print(String(format: "{\"duration\":%.2f,\"frames\":%d,\"gap\":%.3f,\"gapAt\":%.2f}", duration, times.count, gap, gapAt))
    } catch {
        fail("\(error)")
    }
    sem.signal()
}
sem.wait()
