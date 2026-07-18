import AppKit
import CoreGraphics
import Foundation
import ImageIO
import PDFKit
import Vision

struct Options {
    let inputPath: String
    let page: Int?
    let language: String?
}

func emit(_ value: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value, options: []) else {
        Foundation.exit(1)
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ code: String, _ message: String) -> Never {
    emit(["error": ["code": code, "message": message]])
    Foundation.exit(1)
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.isEmpty {
    fail("invalid_arguments", "An image or PDF path is required")
}

var inputPath: String?
var page: Int?
var language: String?
var pageCountMode = false
var index = 0
while index < arguments.count {
    let argument = arguments[index]
    switch argument {
    case "--page-count":
        pageCountMode = true
    case "--page":
        index += 1
        guard index < arguments.count, let parsed = Int(arguments[index]), parsed > 0 else {
            fail("invalid_page", "Page must be a positive 1-based integer")
        }
        page = parsed
    case "--language":
        index += 1
        guard index < arguments.count, !arguments[index].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            fail("invalid_language", "Language must be non-empty")
        }
        language = arguments[index]
    default:
        if inputPath == nil {
            inputPath = argument
        } else {
            fail("invalid_arguments", "Only one input path is supported")
        }
    }
    index += 1
}

guard let inputPath else {
    fail("invalid_arguments", "An image or PDF path is required")
}
let inputURL = URL(fileURLWithPath: inputPath)
guard FileManager.default.fileExists(atPath: inputURL.path) else {
    fail("input_not_found", "OCR input was not found")
}

let extensionName = inputURL.pathExtension.lowercased()
if pageCountMode {
    guard extensionName == "pdf" else {
        fail("invalid_input", "Page count mode requires a PDF input")
    }
    guard let document = PDFDocument(url: inputURL) else {
        fail("pdf_load_failed", "The PDF could not be opened")
    }
    emit(["engine": "macos_vision", "page_count": document.pageCount])
    Foundation.exit(0)
}

var image: CGImage
var pageMetadata: [String: Any] = [:]

if extensionName == "pdf" {
    guard let page else {
        fail("invalid_page", "A PDF OCR request requires a specific 1-based page")
    }
    guard let document = PDFDocument(url: inputURL) else {
        fail("pdf_load_failed", "The PDF could not be opened")
    }
    let pageCount = document.pageCount
    guard page <= pageCount else {
        fail("invalid_page", "The requested PDF page is outside the document")
    }
    guard let pdfPage = document.page(at: page - 1) else {
        fail("pdf_page_failed", "The requested PDF page could not be rendered")
    }
    let bounds = pdfPage.bounds(for: .mediaBox)
    let width = max(bounds.width, 1)
    let height = max(bounds.height, 1)
    let scale = min(2048.0 / width, 2048.0 / height)
    let thumbnailSize = CGSize(width: max(width * scale, 1), height: max(height * scale, 1))
    let thumbnail = pdfPage.thumbnail(of: thumbnailSize, for: .mediaBox)
    var proposedRect = CGRect(origin: .zero, size: thumbnail.size)
    guard let rendered = thumbnail.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil) else {
        fail("pdf_render_failed", "The requested PDF page could not be rendered")
    }
    image = rendered
    pageMetadata = ["page_number": page, "page_count": pageCount]
} else {
    if let page, page != 1 {
        fail("invalid_page", "Image OCR only supports page 1")
    }
    guard let source = CGImageSourceCreateWithURL(inputURL as CFURL, nil),
          let loaded = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        fail("image_load_failed", "The image could not be opened")
    }
    image = loaded
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
if let language {
    request.recognitionLanguages = [language]
}

do {
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])
} catch {
    fail("vision_failed", "macOS Vision could not recognise the input")
}

let lines = (request.results ?? []).compactMap { observation -> String? in
    observation.topCandidates(1).first?.string
}
let text = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
if text.isEmpty {
    fail("empty_output", "macOS Vision returned empty output")
}

var metadata = pageMetadata
metadata["width"] = image.width
metadata["height"] = image.height
metadata["line_count"] = lines.count
if let language {
    metadata["language"] = language
}
emit(["engine": "macos_vision", "text": text, "metadata": metadata])
