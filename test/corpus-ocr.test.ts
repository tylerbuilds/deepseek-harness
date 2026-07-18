import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildOcrCorpusManifest, extractOcrShard } from "../src/corpus_ocr.js";

process.env.DEEPSEEK_HARNESS_INPUT_ROOT = os.tmpdir();

const TEST_COMMAND_TIMEOUT_MS = 30_000;
const TEST_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

function fixtureRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-corpus-ocr-"));
}

function commandAvailable(command: string): boolean {
  return spawnSync("/usr/bin/which", [command], {
    shell: false,
    stdio: ["ignore", "ignore", "ignore"],
    maxBuffer: TEST_MAX_BUFFER_BYTES,
    timeout: TEST_COMMAND_TIMEOUT_MS,
    killSignal: "SIGTERM"
  }).status === 0;
}

function pillowAvailable(): boolean {
  if (!commandAvailable("python3")) {
    return false;
  }
  return spawnSync("python3", ["-c", "import PIL"], {
    shell: false,
    stdio: ["ignore", "ignore", "ignore"],
    maxBuffer: TEST_MAX_BUFFER_BYTES,
    timeout: TEST_COMMAND_TIMEOUT_MS,
    killSignal: "SIGTERM"
  }).status === 0;
}

test("builds a deterministic image OCR manifest with corpus-v1 bounds", () => {
  const root = fixtureRoot();
  const inputPath = path.join(root, "scan.png");
  fs.writeFileSync(inputPath, Buffer.from("image-fixture"));

  const input = {
    project: "ocr-unit",
    sourcePath: inputPath,
    privacyLane: "local_only" as const,
    engine: "auto" as const,
    language: "en-US"
  };
  const manifest = buildOcrCorpusManifest(input);
  const rebuilt = buildOcrCorpusManifest(input);

  assert.deepEqual(rebuilt, manifest);
  assert.equal(manifest.schema_version, "deepseek-harness.corpus.v1");
  assert.equal(manifest.workload_type, "ocr");
  assert.deepEqual(manifest.processor, { type: "local_ocr", engine: "auto", language: "en-US" });
  assert.equal(manifest.sources[0]?.type, "image");
  assert.equal(manifest.sources[0]?.path, fs.realpathSync(inputPath));
  assert.equal(manifest.shards.length, 1);
  assert.equal(manifest.shards[0]?.input_path, fs.realpathSync(inputPath));
  assert.deepEqual(manifest.shards[0]?.bounds, { page_number: 1, page_start: 1, page_end: 1, page_count: 1 });
});

test("creates one bounded shard per detected PDF page", () => {
  const root = fixtureRoot();
  const inputPath = path.join(root, "book.pdf");
  fs.writeFileSync(
    inputPath,
    "%PDF-1.4\n1 0 obj <</Type /Page>> endobj\n2 0 obj <</Type /Page>> endobj\n%%EOF\n"
  );

  const manifest = buildOcrCorpusManifest({ project: "ocr-pdf-unit", sourcePath: inputPath, engine: "tesseract", pageCount: 2 });
  assert.equal(manifest.sources[0]?.type, "pdf");
  assert.equal(manifest.shards.length, 2);
  assert.deepEqual(
    manifest.shards.map((shard) => shard.bounds),
    [
      { page_number: 1, page_start: 1, page_end: 1, page_count: 2 },
      { page_number: 2, page_start: 2, page_end: 2, page_count: 2 }
    ]
  );
});

test("rejects PDF page fan-out above the corpus shard cap before materialising shards", () => {
  const root = fixtureRoot();
  const inputPath = path.join(root, "oversized-book.pdf");
  fs.writeFileSync(inputPath, "%PDF-1.4\n%%EOF\n");

  assert.throws(
    () => buildOcrCorpusManifest({ project: "ocr-page-cap", sourcePath: inputPath, pageCount: 10_001 }),
    /more than 10000 page shards/
  );
});

test("rejects invalid page bounds before selecting an OCR engine", () => {
  const root = fixtureRoot();
  const imagePath = path.join(root, "scan.png");
  fs.writeFileSync(imagePath, Buffer.from("image-fixture"));

  assert.throws(
    () => extractOcrShard(imagePath, { page_number: 2 }, { type: "local_ocr", engine: "focr" }),
    /Image OCR shards may only use page 1 bounds/
  );
});

test("reports an explicit unavailable engine clearly", () => {
  const root = fixtureRoot();
  const imagePath = path.join(root, "scan.png");
  fs.writeFileSync(imagePath, Buffer.from("image-fixture"));
  const oldPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    assert.throws(
      () => extractOcrShard(imagePath, undefined, { type: "local_ocr", engine: "focr" }),
      /OCR engine focr is unavailable/
    );
  } finally {
    if (oldPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = oldPath;
    }
  }
});

test("rejects malformed OCR language codes", () => {
  const root = fixtureRoot();
  const imagePath = path.join(root, "scan.png");
  fs.writeFileSync(imagePath, Buffer.from("image-fixture"));
  assert.throws(
    () => buildOcrCorpusManifest({ project: "ocr-language-unit", sourcePath: imagePath, language: "not a language" }),
    /OCR language must be a valid/
  );
});

test(
  "runs a real macOS Vision OCR smoke when a local image generator is available",
  { skip: process.platform !== "darwin" || !pillowAvailable() || !commandAvailable("swiftc") },
  (t) => {
    const root = fixtureRoot();
    const imagePath = path.join(root, "vision.png");
    const generated = spawnSync(
      "python3",
      [
        "-c",
        [
          "import sys",
          "from PIL import Image, ImageDraw, ImageFont",
          "out = sys.argv[1]",
          "image = Image.new('RGB', (800, 220), 'white')",
          "draw = ImageDraw.Draw(image)",
          "font = None",
          "for candidate in ['/System/Library/Fonts/Supplemental/Arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']:",
          "  try:",
          "    font = ImageFont.truetype(candidate, 100)",
          "    break",
          "  except OSError:",
          "    pass",
          "draw.text((30, 45), 'OCR TEST', fill='black', font=font)",
          "image.save(out)"
        ].join("\n"),
        imagePath
      ],
      {
        encoding: "utf8",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: TEST_MAX_BUFFER_BYTES,
        timeout: TEST_COMMAND_TIMEOUT_MS,
        killSignal: "SIGTERM"
      }
    );
    if (generated.status !== 0) {
      t.skip("The local image generator could not create the temporary OCR fixture");
      return;
    }
    const result = extractOcrShard(imagePath, undefined, { type: "local_ocr", engine: "macos_vision", language: "en-US" });
    assert.equal(result.engine, "macos_vision");
    assert.match(result.text.toUpperCase(), /OCR/);
  }
);
