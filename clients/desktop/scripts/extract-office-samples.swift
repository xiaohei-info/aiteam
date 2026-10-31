import AppKit

// Run from the repository root: swift scripts/extract-office-samples.swift
// Coordinates refer to original image pixels, with the origin at the top left.
struct Sample: Codable {
    let id: String
    let label: String
    let source: String
    let rect: [Int]
    var file: String { "crops/\(id).png" }
}
let samples: [Sample] = [
    Sample(id: "01-wall", label: "白墙与踢脚线", source: "10", rect: [420, 48, 62, 96]),
    Sample(id: "02-wall-corner", label: "墙角与墙顶", source: "10", rect: [873, 258, 92, 147]),
    Sample(id: "03-window", label: "黑框外窗（带透视）", source: "10", rect: [75, 560, 62, 177]),
    Sample(id: "04-glass-partition", label: "会议室玻璃隔断", source: "10", rect: [340, 195, 378, 107]),
    Sample(id: "05-entry-door", label: "入口玻璃双门", source: "10", rect: [430, 1035, 233, 132]),
    Sample(id: "06-wood-door", label: "木门开启状态", source: "10", rect: [889, 301, 65, 108]),
    Sample(id: "07-closed-door", label: "木门关闭状态", source: "10", rect: [958, 646, 63, 83]),
    Sample(id: "08-carpet-light", label: "浅灰纹理地面", source: "10", rect: [420, 510, 192, 192]),
    Sample(id: "09-carpet-dark", label: "深灰纹理地面", source: "10", rect: [1002, 754, 75, 112]),
    Sample(id: "10-floor-tile", label: "50人底图浅灰方块地面", source: "50", rect: [410, 460, 192, 192]),
    Sample(id: "11-plant-large", label: "落地阔叶盆栽", source: "10", rect: [370, 75, 57, 96]),
    Sample(id: "12-plant-small", label: "桌面小盆栽", source: "10", rect: [985, 414, 38, 47]),
    Sample(id: "13-planter", label: "入口连续花槽", source: "10", rect: [120, 1038, 229, 44]),
    Sample(id: "14-plant-shelf", label: "沿窗花架组合", source: "10", rect: [110, 464, 67, 122]),
    Sample(id: "15-wall-art", label: "植物主题挂画", source: "10", rect: [250, 67, 41, 45]),
    Sample(id: "16-wall-display", label: "会议室壁挂屏幕", source: "10", rect: [485, 68, 90, 50]),
    Sample(id: "17-lounge-chair", label: "接待扶手椅", source: "10", rect: [201, 120, 54, 65]),
    Sample(id: "18-round-table", label: "接待圆茶几及小物", source: "10", rect: [232, 151, 49, 71]),
    Sample(id: "19-sofa", label: "休息沙发", source: "10", rect: [125, 942, 65, 105]),
    Sample(id: "20-meeting-set", label: "会议桌椅组合", source: "10", rect: [420, 123, 237, 144]),
    Sample(id: "21-pantry-counter", label: "茶水间柜台与设备", source: "10", rect: [991, 301, 136, 121]),
    Sample(id: "22-sink", label: "水槽与龙头", source: "10", rect: [1075, 350, 47, 70]),
    Sample(id: "23-coffee-machine", label: "咖啡设备", source: "10", rect: [1048, 304, 38, 48]),
    Sample(id: "24-island", label: "吧台、高脚凳及盆栽", source: "10", rect: [943, 390, 104, 237]),
    Sample(id: "25-fridge", label: "冰箱（部分遮挡）", source: "10", rect: [1104, 524, 58, 94]),
    Sample(id: "26-water-dispenser", label: "饮水机", source: "10", rect: [104, 780, 49, 81]),
    Sample(id: "27-restroom-stall", label: "卫生间隔间、马桶与门", source: "10", rect: [917, 65, 68, 174]),
    Sample(id: "28-storage", label: "储物柜与绿植陈列", source: "10", rect: [1082, 681, 104, 206]),
]

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let output = root.appendingPathComponent("output/office-elements/v1")
try FileManager.default.createDirectory(at: output.appendingPathComponent("crops"), withIntermediateDirectories: true)
var sources: [String: CGImage] = [:]
for key in ["10", "50"] {
    let url = root.appendingPathComponent("public/assets/office/icon_office_\(key).png")
    guard let source = NSImage(contentsOf: url), let cg = source.cgImage(forProposedRect: nil, context: nil, hints: nil) else { fatalError("Cannot load \(url)") }
    sources[key] = cg
}
func save(_ cg: CGImage, to url: URL) throws {
    guard let data = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) else { fatalError("PNG encoding failed") }
    try data.write(to: url)
}
func text(_ value: String, x: CGFloat, y: CGFloat, size: CGFloat, color: NSColor = .white) {
    (value as NSString).draw(at: NSPoint(x: x, y: y), withAttributes: [.font: NSFont.systemFont(ofSize: size), .foregroundColor: color])
}
let board = NSImage(size: NSSize(width: 1440, height: 1930))
board.lockFocus()
NSColor(calibratedWhite: 0.10, alpha: 1).setFill()
NSRect(x: 0, y: 0, width: 1440, height: 1930).fill()
text("办公室元素 · 原图样板 / 28 项", x: 28, y: 1880, size: 26)
text("原图裁切，保留环境与遮挡；非透明精灵，非无缝贴图。编号对应 manifest.json。", x: 28, y: 1848, size: 15, color: .lightGray)
for (index, sample) in samples.enumerated() {
    let r = sample.rect
    guard let crop = sources[sample.source]?.cropping(to: CGRect(x: r[0], y: r[1], width: r[2], height: r[3])) else { fatalError("Invalid crop \(sample.id)") }
    try save(crop, to: output.appendingPathComponent(sample.file))
    let x = CGFloat(24 + (index % 4) * 354)
    let y = CGFloat(1580 - (index / 4) * 258)
    NSColor(calibratedWhite: 0.17, alpha: 1).setFill()
    NSRect(x: x, y: y, width: 338, height: 244).fill()
    let scale = min(310 / CGFloat(crop.width), 194 / CGFloat(crop.height))
    let size = NSSize(width: CGFloat(crop.width) * scale, height: CGFloat(crop.height) * scale)
    NSImage(cgImage: crop, size: NSSize(width: crop.width, height: crop.height)).draw(in: NSRect(x: x + (338 - size.width) / 2, y: y + 39 + (194 - size.height) / 2, width: size.width, height: size.height))
    text("\(sample.id.prefix(2))  \(sample.label)", x: x + 12, y: y + 12, size: 14)
}
board.unlockFocus()
try save(board.cgImage(forProposedRect: nil, context: nil, hints: nil)!, to: output.appendingPathComponent("contact-sheet.png"))

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
try encoder.encode(samples).write(to: output.appendingPathComponent("manifest.json"))
for key in ["10", "50"] {
    let source = sources[key]!
    let annotated = NSImage(size: NSSize(width: source.width, height: source.height))
    annotated.lockFocus()
    NSImage(cgImage: source, size: annotated.size).draw(in: NSRect(origin: .zero, size: annotated.size))
    for sample in samples where sample.source == key {
        let r = sample.rect
        let rect = NSRect(x: r[0], y: source.height - r[1] - r[3], width: r[2], height: r[3])
        NSColor.systemOrange.setStroke()
        let outline = NSBezierPath(rect: rect)
        outline.lineWidth = 2
        outline.stroke()
        NSColor.black.withAlphaComponent(0.8).setFill()
        NSRect(x: rect.minX, y: rect.maxY - 21, width: 27, height: 21).fill()
        text(String(sample.id.prefix(2)), x: rect.minX + 3, y: rect.maxY - 19, size: 13)
    }
    annotated.unlockFocus()
    try save(annotated.cgImage(forProposedRect: nil, context: nil, hints: nil)!, to: output.appendingPathComponent("source-\(key)-annotated.png"))
}
print("Saved \(samples.count) original-image crops and contact-sheet.png in \(output.path)")
