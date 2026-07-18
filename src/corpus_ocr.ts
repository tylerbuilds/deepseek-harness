import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { HarnessError } from "./errors.js";
import { assertSafeCorpusSourcePath } from "./paths.js";

export type OcrEngine = "auto" | "macos_vision" | "focr" | "tesseract";

export type OcrSourceType = "pdf" | "image";

export interface OcrProcessor {
  type: "local_ocr";
  engine: OcrEngine;
  language?: string;
}

export interface OcrBounds {
  page_number?: number;
  page_start?: number;
  page_end?: number;
  page_count?: number;
  [key: string]: string | number | boolean | null | undefined;
}

export interface BuildOcrCorpusManifestInput {
  project: string;
  sourcePath?: string;
  inputPath?: string;
  privacyLane?: "local_only" | "external_inference_allowed" | "redacted_external_allowed";
  privacy_lane?: "local_only" | "external_inference_allowed" | "redacted_external_allowed";
  engine?: OcrEngine;
  language?: string;
  processor?: OcrProcessor;
  workloadType?: "ocr";
  artifactDir?: string;
  artifact_dir?: string;
  pageCount?: number;
}

export interface OcrCorpusSource {
  id: string;
  path: string;
  sha256: string;
  type: OcrSourceType;
}

export interface OcrCorpusShard {
  id: string;
  source_id: string;
  input_path: string;
  bounds: OcrBounds;
}

export interface OcrCorpusManifest {
  schema_version: "deepseek-harness.corpus.v1";
  project: string;
  workload_type: "ocr";
  privacy_lane: "local_only" | "external_inference_allowed" | "redacted_external_allowed";
  artifact_dir?: string;
  processor: OcrProcessor;
  sources: OcrCorpusSource[];
  shards: OcrCorpusShard[];
}

export interface OcrShardResult {
  text: string;
  engine: Exclude<OcrEngine, "auto">;
  metadata: Record<string, unknown>;
}

interface NormalisedProcessor {
  type: "local_ocr";
  engine: OcrEngine;
  language?: string;
}

interface NormalisedInputPath {
  path: string;
  type: OcrSourceType;
  size: number;
}

const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp"
]);

const OCR_COMMAND_TIMEOUTS_MS = {
  availability: 2_000,
  pdfInfo: 15_000,
  pdfPageCount: 30_000,
  ocr: 5 * 60_000,
  pdfRender: 5 * 60_000,
  swiftCompiler: 2 * 60_000
} as const;
const OCR_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const OCR_PROBE_MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_OCR_SHARDS = 10_000;
const pdfPageCountCache = new Map<string, { size: number; mtimeMs: number; pageCount: number }>();

export function buildOcrCorpusManifest(input: BuildOcrCorpusManifestInput): OcrCorpusManifest {
  if (!input || typeof input !== "object") {
    throw new HarnessError("invalid_ocr_input", "OCR manifest input must be an object");
  }
  if (typeof input.project !== "string" || input.project.trim().length === 0) {
    throw new HarnessError("invalid_ocr_project", "OCR project must be a non-empty string");
  }

  const source = readSource(input.sourcePath ?? input.inputPath);
  if (input.workloadType !== undefined && input.workloadType !== "ocr") {
    throw new HarnessError("invalid_ocr_workload", "OCR manifests must use workloadType ocr");
  }
  const processor = normaliseProcessor(input.processor ?? {
    type: "local_ocr",
    engine: input.engine,
    language: input.language
  });
  const privacyLane = resolvePrivacyLane(input);
  const artifactDir = input.artifactDir ?? input.artifact_dir;
  if (artifactDir !== undefined && (typeof artifactDir !== "string" || artifactDir.trim().length === 0)) {
    throw new HarnessError("invalid_ocr_artifact_dir", "artifactDir must be a non-empty string when provided");
  }

  const pageCount = source.type === "pdf" ? determinePdfPageCount(source.path, input.pageCount) : 1;
  const sourceSha256 = sha256File(source.path);
  const sourceId = `source:${sha256Text(`${source.path}\0${sourceSha256}`).slice(0, 16)}`;
  const shards: OcrCorpusShard[] = [];

  for (let page = 1; page <= pageCount; page += 1) {
    shards.push({
      id: `${sourceId}:page:${String(page).padStart(6, "0")}`,
      source_id: sourceId,
      input_path: source.path,
      bounds: {
        page_number: page,
        page_start: page,
        page_end: page,
        page_count: pageCount
      }
    });
  }

  return {
    schema_version: "deepseek-harness.corpus.v1",
    project: input.project,
    workload_type: "ocr",
    privacy_lane: privacyLane,
    ...(artifactDir === undefined ? {} : { artifact_dir: artifactDir }),
    processor,
    sources: [
      {
        id: sourceId,
        path: source.path,
        sha256: sourceSha256,
        type: source.type
      }
    ],
    shards
  };
}

export function extractOcrShard(
  inputPath: string,
  bounds: OcrBounds | Record<string, unknown> | undefined,
  processor: OcrProcessor | OcrEngine | Record<string, unknown>
): OcrShardResult {
  const source = readSource(inputPath);
  const normalisedBounds = validateBounds(bounds, source.type, source.path);
  const normalisedProcessor = normaliseProcessor(processor);
  const engine = selectEngine(normalisedProcessor.engine);
  assertEngineAvailable(engine);

  const result = runEngine(source, normalisedBounds, {
    ...normalisedProcessor,
    engine
  });
  const text = result.text.trim();
  if (text.length === 0) {
    throw new HarnessError("ocr_empty_output", `${engine} OCR returned empty output`);
  }

  return {
    text,
    engine,
    metadata: {
      source_type: source.type,
      ...normalisedBounds,
      ...(normalisedProcessor.language ? { language: normalisedProcessor.language } : {}),
      ...result.metadata
    }
  };
}

function resolvePrivacyLane(input: BuildOcrCorpusManifestInput): OcrCorpusManifest["privacy_lane"] {
  const value = input.privacyLane ?? input.privacy_lane ?? "local_only";
  if (value !== "local_only" && value !== "external_inference_allowed" && value !== "redacted_external_allowed") {
    throw new HarnessError("invalid_ocr_privacy_lane", "privacyLane must be local_only, external_inference_allowed, or redacted_external_allowed");
  }
  return value;
}

function readSource(inputPath: unknown): NormalisedInputPath {
  if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
    throw new HarnessError("invalid_ocr_path", "OCR input path must be a non-empty string");
  }

  const resolved = assertSafeCorpusSourcePath(inputPath);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new HarnessError("ocr_input_not_found", "OCR input path does not exist");
  }
  if (!stats.isFile()) {
    throw new HarnessError("invalid_ocr_path", "OCR input path must point to a regular file");
  }

  if (stats.size === 0) {
    throw new HarnessError("empty_ocr_source", "OCR input file must not be empty");
  }

  const extension = path.extname(resolved).toLowerCase();
  if (extension === ".pdf") {
    return { path: resolved, type: "pdf", size: stats.size };
  }
  if (!IMAGE_EXTENSIONS.has(extension)) {
    throw new HarnessError("unsupported_ocr_source", "OCR input must be a PDF or a supported image file");
  }
  return { path: resolved, type: "image", size: stats.size };
}

function normaliseProcessor(input: unknown): NormalisedProcessor {
  if (typeof input === "string") {
    return { type: "local_ocr", engine: validateEngine(input) };
  }
  if (!input || typeof input !== "object") {
    throw new HarnessError("invalid_ocr_processor", "OCR processor must be a local_ocr processor");
  }

  const value = input as Record<string, unknown>;
  if (value.type !== undefined && value.type !== "local_ocr") {
    throw new HarnessError("invalid_ocr_processor", "OCR processor type must be local_ocr");
  }
  const engine = validateEngine(value.engine ?? "auto");
  const language = validateLanguage(value.language);
  return {
    type: "local_ocr",
    engine,
    ...(language === undefined ? {} : { language })
  };
}

function validateEngine(value: unknown): OcrEngine {
  if (value !== "auto" && value !== "macos_vision" && value !== "focr" && value !== "tesseract") {
    throw new HarnessError("invalid_ocr_engine", "OCR engine must be auto, macos_vision, focr, or tesseract");
  }
  return value;
}

function validateLanguage(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HarnessError("invalid_ocr_language", "OCR language must be a non-empty BCP-47 or Tesseract language code");
  }
  const language = value.trim();
  if (!/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(language)) {
    throw new HarnessError("invalid_ocr_language", "OCR language must be a valid BCP-47 or Tesseract language code");
  }
  return language;
}

function determinePdfPageCount(inputPath: string, suppliedPageCount: unknown): number {
  let supplied: number | undefined;
  if (suppliedPageCount !== undefined) {
    if (!Number.isInteger(suppliedPageCount) || (suppliedPageCount as number) <= 0) {
      throw new HarnessError("invalid_ocr_page_count", "PDF pageCount must be a positive integer");
    }
    supplied = suppliedPageCount as number;
    if (supplied > MAX_OCR_SHARDS) {
      throw new HarnessError(
        "ocr_page_limit_exceeded",
        `OCR corpus would create more than ${MAX_OCR_SHARDS} page shards`
      );
    }
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(inputPath);
  } catch {
    throw new HarnessError("ocr_input_not_found", "OCR input path does not exist");
  }
  const cached = pdfPageCountCache.get(inputPath);
  const detected = cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs
    ? cached.pageCount
    : detectPdfPageCount(inputPath, supplied === undefined);
  if (detected !== undefined) {
    pdfPageCountCache.set(inputPath, { size: stats.size, mtimeMs: stats.mtimeMs, pageCount: detected });
  }
  const pageCount = supplied ?? detected;
  if (!pageCount || pageCount <= 0) {
    throw new HarnessError("ocr_pdf_pages_unavailable", "Could not determine the PDF page count");
  }
  if (pageCount > MAX_OCR_SHARDS) {
    throw new HarnessError(
      "ocr_page_limit_exceeded",
      `OCR corpus would create more than ${MAX_OCR_SHARDS} page shards`
    );
  }
  if (supplied !== undefined && detected !== undefined && detected !== supplied) {
    throw new HarnessError("invalid_ocr_page_count", "Supplied PDF pageCount does not match the PDF page tree");
  }
  return pageCount;
}

function detectPdfPageCount(inputPath: string, allowVision: boolean): number | undefined {
  if (commandAvailable("pdfinfo")) {
    const result = spawnSync("pdfinfo", [inputPath], {
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: OCR_PROBE_MAX_BUFFER_BYTES,
      timeout: OCR_COMMAND_TIMEOUTS_MS.pdfInfo,
      killSignal: "SIGTERM"
    });
    if (isSpawnTimedOut(result)) {
      throw ocrToolTimeout("pdfinfo", OCR_COMMAND_TIMEOUTS_MS.pdfInfo, "PDF page-count detection");
    }
    if (!result.error && result.status === 0) {
      const match = String(result.stdout ?? "").match(/(?:^|\n)Pages:\s*(\d+)/i);
      if (match) {
        const pageCount = Number(match[1]);
        if (Number.isInteger(pageCount) && pageCount > 0) {
          return pageCount;
        }
      }
    }
  }

  if (allowVision && process.platform === "darwin" && commandAvailable("swiftc")) {
    const scriptPath = locateVisionScript();
    if (scriptPath) {
      try {
        const executablePath = visionExecutable(scriptPath);
        const result = spawnSync(executablePath, ["--page-count", inputPath], {
          encoding: "utf8",
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: OCR_PROBE_MAX_BUFFER_BYTES,
          timeout: OCR_COMMAND_TIMEOUTS_MS.pdfPageCount,
          killSignal: "SIGTERM"
        });
        if (isSpawnTimedOut(result)) {
          throw ocrToolTimeout("macos_vision", OCR_COMMAND_TIMEOUTS_MS.pdfPageCount, "PDF page-count detection");
        }
        if (!result.error && result.status === 0) {
          const parsed = JSON.parse(String(result.stdout ?? "")) as Record<string, unknown>;
          const pageCount = parsed.page_count;
          if (typeof pageCount === "number" && Number.isInteger(pageCount) && pageCount > 0) {
            return pageCount;
          }
        }
      } catch (error) {
        if (error instanceof HarnessError && error.code === "ocr_tool_timeout") {
          throw error;
        }
        return undefined;
      }
    }
  }
  return undefined;
}

function validateBounds(
  input: OcrBounds | Record<string, unknown> | undefined,
  sourceType: OcrSourceType,
  inputPath: string
): OcrBounds {
  if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) {
    throw new HarnessError("invalid_ocr_bounds", "OCR shard bounds must be an object");
  }
  const value = (input ?? {}) as Record<string, unknown>;
  const pageNumber = positivePageNumber("page_number", value.page_number ?? value.page);
  const pageStart = positivePageNumber("page_start", value.page_start);
  const pageEnd = positivePageNumber("page_end", value.page_end);
  const pageCountValue = positivePageNumber("page_count", value.page_count);

  if (sourceType === "pdf") {
    if (pageNumber === undefined && pageStart === undefined && pageEnd === undefined) {
      throw new HarnessError("invalid_ocr_page_bounds", "PDF OCR shards require a 1-based page bound");
    }
    const effectiveStart = pageStart ?? pageNumber;
    const effectiveEnd = pageEnd ?? pageNumber;
    if (effectiveStart === undefined || effectiveEnd === undefined || effectiveStart !== effectiveEnd) {
      throw new HarnessError("invalid_ocr_page_bounds", "PDF OCR shards must select exactly one page");
    }
    if (pageNumber !== undefined && pageNumber !== effectiveStart) {
      throw new HarnessError("invalid_ocr_page_bounds", "page_number must match page_start/page_end");
    }
    const pageCount = determinePdfPageCount(inputPath, pageCountValue);
    if (effectiveStart > pageCount) {
      throw new HarnessError("invalid_ocr_page_bounds", "PDF OCR page number is outside the document");
    }
    return {
      ...value,
      page_number: effectiveStart,
      page_start: effectiveStart,
      page_end: effectiveEnd,
      page_count: pageCount
    } as OcrBounds;
  }

  if (pageNumber !== undefined || pageStart !== undefined || pageEnd !== undefined) {
    const effectiveStart = pageStart ?? pageNumber;
    const effectiveEnd = pageEnd ?? pageNumber;
    if (effectiveStart !== 1 || effectiveEnd !== 1 || (pageNumber !== undefined && pageNumber !== 1)) {
      throw new HarnessError("invalid_ocr_page_bounds", "Image OCR shards may only use page 1 bounds");
    }
  }
  if (pageCountValue !== undefined && pageCountValue !== 1) {
    throw new HarnessError("invalid_ocr_page_bounds", "Image OCR page_count must be 1");
  }
  return {
    ...value,
    page_number: 1,
    page_start: 1,
    page_end: 1,
    page_count: 1
  } as OcrBounds;
}

function positivePageNumber(name: string, value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new HarnessError("invalid_ocr_page_bounds", `${name} must be a positive integer`);
  }
  return value;
}

function selectEngine(requested: OcrEngine): Exclude<OcrEngine, "auto"> {
  if (requested !== "auto") {
    return requested;
  }
  if (commandAvailable("focr")) {
    return "focr";
  }
  if (commandAvailable("tesseract")) {
    return "tesseract";
  }
  if (process.platform === "darwin" && commandAvailable("swiftc") && locateVisionScript() !== undefined) {
    return "macos_vision";
  }
  throw new HarnessError("ocr_engine_unavailable", "No local OCR engine is available (focr, tesseract, or macOS Vision)");
}

function assertEngineAvailable(engine: Exclude<OcrEngine, "auto">): void {
  if (engine === "focr" && !commandAvailable("focr")) {
    throw new HarnessError("ocr_engine_unavailable", "OCR engine focr is unavailable: the focr command was not found");
  }
  if (engine === "tesseract" && !commandAvailable("tesseract")) {
    throw new HarnessError("ocr_engine_unavailable", "OCR engine tesseract is unavailable: the tesseract command was not found");
  }
  if (engine === "macos_vision") {
    if (process.platform !== "darwin") {
      throw new HarnessError("ocr_engine_unavailable", "OCR engine macos_vision is unavailable outside macOS");
    }
    if (!commandAvailable("swiftc") || locateVisionScript() === undefined) {
      throw new HarnessError("ocr_engine_unavailable", "OCR engine macos_vision is unavailable: swiftc or the Vision adapter is missing");
    }
  }
}

function commandAvailable(command: string): boolean {
  const result = spawnSync("/usr/bin/which", [command], {
    shell: false,
    stdio: ["ignore", "ignore", "ignore"],
    maxBuffer: OCR_PROBE_MAX_BUFFER_BYTES,
    timeout: OCR_COMMAND_TIMEOUTS_MS.availability,
    killSignal: "SIGTERM"
  });
  if (isSpawnTimedOut(result)) {
    throw ocrToolTimeout("which", OCR_COMMAND_TIMEOUTS_MS.availability, `checking availability of ${command}`);
  }
  return result.status === 0;
}

function runEngine(
  source: NormalisedInputPath,
  bounds: OcrBounds,
  processor: NormalisedProcessor
): { text: string; metadata: Record<string, unknown> } {
  switch (processor.engine) {
    case "focr":
      return runFocr(source, bounds);
    case "tesseract":
      return runTesseract(source, bounds, processor.language);
    case "macos_vision":
      return runMacosVision(source, bounds, processor.language);
    default:
      throw new HarnessError("invalid_ocr_engine", "OCR engine must be resolved before execution");
  }
}

function runFocr(source: NormalisedInputPath, bounds: OcrBounds): { text: string; metadata: Record<string, unknown> } {
  const args = ["ocr", source.path, "--json"];
  if (source.type === "pdf") {
    args.push("--pages", String(bounds.page_number));
  }
  const child = runChild("focr", args, "focr", OCR_COMMAND_TIMEOUTS_MS.ocr);
  const parsed = parseJsonOutput(child.stdout, "focr");
  if (hasJsonError(parsed)) {
    throw new HarnessError("ocr_engine_failed", "focr reported an OCR error");
  }
  const extracted = extractTextFromFocr(parsed);
  if (extracted === undefined && typeof parsed !== "string") {
    throw new HarnessError("ocr_empty_output", "focr OCR returned empty output");
  }
  const text = extracted ?? child.stdout;
  return { text, metadata: metadataFromJson(parsed) };
}

function runTesseract(source: NormalisedInputPath, bounds: OcrBounds, language: string | undefined): { text: string; metadata: Record<string, unknown> } {
  let imagePath = source.path;
  let temporaryDirectory: string | undefined;
  try {
    if (source.type === "pdf") {
      if (!commandAvailable("pdftoppm")) {
        throw new HarnessError("ocr_engine_unavailable", "OCR engine tesseract requires pdftoppm for PDF input");
      }
      temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-ocr-"));
      const prefix = path.join(temporaryDirectory, "page");
      const rendered = runChild(
        "pdftoppm",
        ["-f", String(bounds.page_number), "-l", String(bounds.page_number), "-png", "-singlefile", source.path, prefix],
        "pdftoppm",
        OCR_COMMAND_TIMEOUTS_MS.pdfRender
      );
      if (rendered.stdout.trim().length > 0 && rendered.status !== 0) {
        throw new HarnessError("ocr_engine_failed", "pdftoppm failed while rendering the PDF page");
      }
      imagePath = `${prefix}.png`;
      if (!fs.existsSync(imagePath)) {
        throw new HarnessError("ocr_engine_failed", "pdftoppm did not produce a PDF page image");
      }
    }

    const args = [imagePath, "stdout"];
    if (language) {
      args.push("-l", language);
    }
    const child = runChild("tesseract", args, "tesseract", OCR_COMMAND_TIMEOUTS_MS.ocr);
    return { text: child.stdout, metadata: {} };
  } finally {
    if (temporaryDirectory) {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

function runMacosVision(source: NormalisedInputPath, bounds: OcrBounds, language: string | undefined): { text: string; metadata: Record<string, unknown> } {
  const scriptPath = locateVisionScript();
  if (!scriptPath) {
    throw new HarnessError("ocr_engine_unavailable", "OCR engine macos_vision is unavailable: the Vision adapter is missing");
  }

  const executablePath = visionExecutable(scriptPath);
  const args = [source.path];
  if (source.type === "pdf") {
    args.push("--page", String(bounds.page_number));
  }
  if (language) {
    args.push("--language", language);
  }
  const child = runChild(executablePath, args, "macos_vision", OCR_COMMAND_TIMEOUTS_MS.ocr);
  const parsed = parseJsonOutput(child.stdout, "macos_vision");
  if (hasJsonError(parsed)) {
    const errorCode = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).error && typeof (parsed as Record<string, unknown>).error === "object"
        ? ((parsed as Record<string, unknown>).error as Record<string, unknown>).code
        : undefined
      : undefined;
    if (errorCode === "empty_output") {
      throw new HarnessError("ocr_empty_output", "macos_vision OCR returned empty output");
    }
    throw new HarnessError("ocr_engine_failed", "macos_vision reported an OCR error");
  }
  const text = parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as Record<string, unknown>).text === "string"
    ? (parsed as Record<string, unknown>).text as string
    : child.stdout;
  const metadata = metadataFromJson(parsed);
  return { text, metadata };
}

function hasJsonError(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && "error" in value);
}

interface ChildOutput {
  stdout: string;
  status: number | null;
}

function runChild(command: string, args: string[], engineLabel: string, timeoutMs: number): ChildOutput {
  let child: SpawnSyncReturns<string>;
  try {
    child = spawnSync(command, args, {
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: OCR_MAX_BUFFER_BYTES,
      timeout: timeoutMs,
      killSignal: "SIGTERM"
    });
  } catch {
    throw new HarnessError("ocr_engine_failed", `${engineLabel} OCR process could not be started`);
  }
  if (isSpawnTimedOut(child)) {
    throw ocrToolTimeout(command, timeoutMs, `${engineLabel} OCR execution`);
  }
  if (child.error || child.status !== 0) {
    throw new HarnessError("ocr_engine_failed", `${engineLabel} OCR process failed`);
  }
  return { stdout: child.stdout ?? "", status: child.status };
}

function isSpawnTimedOut(result: { error?: Error; signal?: NodeJS.Signals | null }): boolean {
  const code = result.error && "code" in result.error
    ? (result.error as NodeJS.ErrnoException).code
    : undefined;
  return code === "ETIMEDOUT" || /(?:ETIMEDOUT|timed out)/i.test(result.error?.message ?? "");
}

function ocrToolTimeout(command: string, timeoutMs: number, phase: string): HarnessError {
  return new HarnessError("ocr_tool_timeout", `${command} timed out after ${timeoutMs} ms during ${phase}`, {
    command,
    timeout_ms: timeoutMs,
    phase
  });
}

function parseJsonOutput(stdout: string, engineLabel: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new HarnessError("ocr_empty_output", `${engineLabel} OCR returned empty output`);
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length > 1) {
      const parsedLines: unknown[] = [];
      for (const line of lines) {
        try {
          parsedLines.push(JSON.parse(line));
        } catch {
          return trimmed;
        }
      }
      return parsedLines;
    }
    return trimmed;
  }
}

function extractTextFromFocr(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const parts = value.map(extractTextFromFocr).filter((part): part is string => Boolean(part && part.trim().length > 0));
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["markdown", "text", "content", "result"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  if (Array.isArray(record.pages)) {
    return extractTextFromFocr(record.pages);
  }
  return undefined;
}

function metadataFromJson(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const nested = record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
    ? record.metadata as Record<string, unknown>
    : undefined;
  const metadata: Record<string, unknown> = {};
  for (const key of ["page", "page_number", "page_count", "width", "height", "confidence", "schema_version"]) {
    const candidate = record[key] ?? nested?.[key];
    if (typeof candidate === "string" || typeof candidate === "number" || typeof candidate === "boolean") {
      metadata[key] = candidate;
    }
  }
  return metadata;
}

function locateVisionScript(): string | undefined {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDirectory, "../scripts/ocr-vision.swift"),
    path.resolve(moduleDirectory, "../../scripts/ocr-vision.swift"),
    path.resolve(process.cwd(), "scripts/ocr-vision.swift")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function visionExecutable(scriptPath: string): string {
  const scriptHash = sha256File(scriptPath);
  const cacheDirectory = path.join(os.tmpdir(), "deepseek-harness-ocr-cache");
  fs.mkdirSync(cacheDirectory, { recursive: true });
  const executablePath = path.join(cacheDirectory, `ocr-vision-${scriptHash}`);
  if (fs.existsSync(executablePath)) {
    return executablePath;
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(cacheDirectory, "compile-"));
  const temporaryExecutable = path.join(temporaryDirectory, "ocr-vision");
  try {
    runChild("swiftc", ["-O", scriptPath, "-o", temporaryExecutable], "swiftc", OCR_COMMAND_TIMEOUTS_MS.swiftCompiler);
    try {
      fs.renameSync(temporaryExecutable, executablePath);
    } catch (error) {
      if (!fs.existsSync(executablePath)) {
        throw error;
      }
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  return executablePath;
}

function sha256File(inputPath: string): string {
  const hash = createHash("sha256");
  let descriptor: number;
  try {
    descriptor = fs.openSync(inputPath, "r");
  } catch {
    throw new HarnessError("ocr_input_unreadable", "OCR input file could not be read");
  }
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } catch {
    throw new HarnessError("ocr_input_unreadable", "OCR input file could not be read");
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
