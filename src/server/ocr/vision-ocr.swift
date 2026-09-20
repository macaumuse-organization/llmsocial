// Local OCR through Apple's Vision framework. No network, no per-call cost.
// usage: vision-ocr <image-path> [out.json]  → JSON array of {text,x,y,w,h,confidence}, origin top-left, 0..1
// The result goes to `out.json` when given: the Vision framework writes its own diagnostics to stdout
// on some macOS builds, which would land in the middle of the JSON.
import Foundation
import Vision
import ImageIO

guard CommandLine.arguments.count == 2 || CommandLine.arguments.count == 3 else {
    FileHandle.standardError.write("usage: vision-ocr <image> [out.json]\n".data(using: .utf8)!)
    exit(2)
}
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    FileHandle.standardError.write("cannot read image\n".data(using: .utf8)!)
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US", "ja-JP", "ko-KR"]

do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
} catch {
    FileHandle.standardError.write("vision failed: \(error.localizedDescription)\n".data(using: .utf8)!)
    exit(1)
}

var lines: [[String: Any]] = []
for observation in request.results ?? [] {
    guard let candidate = observation.topCandidates(1).first else { continue }
    let box = observation.boundingBox // origin bottom-left
    lines.append([
        "text": candidate.string,
        "x": box.minX,
        "y": 1.0 - box.maxY,
        "w": box.width,
        "h": box.height,
        "confidence": candidate.confidence,
    ])
}
let data = try JSONSerialization.data(withJSONObject: lines, options: [])
if CommandLine.arguments.count == 3 {
    do {
        try data.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
    } catch {
        FileHandle.standardError.write("cannot write result: \(error.localizedDescription)\n".data(using: .utf8)!)
        exit(1)
    }
} else {
    FileHandle.standardOutput.write(data)
}
