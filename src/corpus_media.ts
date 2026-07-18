import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { HarnessError } from "./errors.js";
import { assertSafeCorpusSourcePath } from "./paths.js";

export type MediaCorpusPrivacyLane = "local_only" | "external_inference_allowed" | "redacted_external_allowed";

export interface BuildMediaCorpusManifestInput {
  project: string;
  sourcePath: string;
  privacyLane: MediaCorpusPrivacyLane;
  artifactDir?: string;
  recursive?: boolean;
  maxFiles?: number;
}

export interface MediaCorpusSource {
  id: string;
  path: string;
  sha256: string;
  type: "audio" | "video";
}

export interface MediaCorpusBounds {
  duration_seconds: number;
  sha256: string;
  sidecar_sha256: string;
  format: string;
  container: string;
  size: number;
  size_bytes: number;
  streams: string;
  relative_path: string;
}

export interface MediaCorpusShard {
  [key: string]: unknown;
  id: string;
  source_id: string;
  inline_text: string;
  bounds: MediaCorpusBounds;
}

export interface MediaCorpusManifest {
  schema_version: "deepseek-harness.corpus.v1";
  project: string;
  workload_type: "media_catalogue";
  privacy_lane: MediaCorpusPrivacyLane;
  artifact_dir?: string;
  processor: { type: "copy_text" };
  sources: MediaCorpusSource[];
  shards: MediaCorpusShard[];
}

interface ProbeStream {
  [key: string]: string | number | boolean | null;
}

interface MediaProbe {
  type: "audio" | "video";
  durationSeconds: number;
  format: string;
  container: string;
  streams: ProbeStream[];
}

const DEFAULT_MAX_FILES = 1_000;
const MAX_MEDIA_SHARDS = 10_000;
const HASH_BUFFER_BYTES = 1024 * 1024;
const FFPROBE_TIMEOUT_MS = 60_000;
const FFPROBE_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const MEDIA_STREAM_TYPES = new Set(["audio", "video"]);
const STREAM_FIELDS = [
  "index",
  "codec_type",
  "codec_name",
  "codec_long_name",
  "profile",
  "level",
  "width",
  "height",
  "coded_width",
  "coded_height",
  "pix_fmt",
  "sample_fmt",
  "sample_rate",
  "channels",
  "channel_layout",
  "bit_rate",
  "duration",
  "start_time",
  "time_base",
  "nb_frames",
  "avg_frame_rate",
  "r_frame_rate",
  "field_order",
  "is_avc"
] as const;

export function buildMediaCorpusManifest(input: BuildMediaCorpusManifestInput): MediaCorpusManifest {
  validateInput(input);

  const declaredSourcePath = assertSafeCorpusSourcePath(input.sourcePath);
  const sourceStat = lstatOrThrow(declaredSourcePath, "media_source_missing", "Media source path does not exist");
  if (sourceStat.isSymbolicLink()) {
    throw new HarnessError("media_source_symlink", "Media source path must not be a symlink", { source_path: input.sourcePath });
  }

  const sourceRoot = sourceStat.isDirectory() ? declaredSourcePath : path.dirname(declaredSourcePath);
  const fileLimit = input.maxFiles ?? DEFAULT_MAX_FILES;
  const regularFiles = sourceStat.isDirectory()
    ? enumerateRegularFiles(declaredSourcePath, input.recursive ?? false, fileLimit)
    : sourceStat.isFile()
      ? [declaredSourcePath]
      : [];

  if (regularFiles.length > fileLimit) {
    throw new HarnessError(
      "media_file_limit_exceeded",
      `Media source contains more than ${fileLimit} regular files, exceeding the maxFiles cap`,
      { observed_at_least: regularFiles.length, max_files: fileLimit }
    );
  }
  if (regularFiles.length === 0) {
    throw new HarnessError("empty_media_source", "Media source contains no regular files", { source_path: input.sourcePath });
  }

  const sources: MediaCorpusSource[] = [];
  const shards: MediaCorpusShard[] = [];
  for (const filePath of regularFiles) {
    const beforeStat = fs.statSync(filePath);
    if (beforeStat.nlink > 1) {
      throw new HarnessError("corpus_input_path_blocked", "Media input must not be a hard-linked regular file");
    }
    const beforeHash = hashFile(filePath);
    const media = probeMedia(filePath);
    if (!media) {
      continue;
    }

    const afterStat = fs.statSync(filePath);
    if (afterStat.nlink > 1) {
      throw new HarnessError("corpus_input_path_blocked", "Media input must not be a hard-linked regular file");
    }
    const fileHash = hashFile(filePath);
    if (
      beforeHash !== fileHash ||
      beforeStat.size !== afterStat.size ||
      beforeStat.mtimeMs !== afterStat.mtimeMs ||
      beforeStat.ino !== afterStat.ino
    ) {
      throw new HarnessError("media_source_changed_during_probe", `Media source changed while ffprobe was reading it: ${filePath}`);
    }
    const relativePath = toPosixRelativePath(sourceRoot, filePath);
    const sourceId = `source:${sha256Text(`${relativePath}\0${fileHash}`).slice(0, 16)}`;
    const sizeBytes = fs.statSync(filePath).size;
    const sidecar = {
      duration_seconds: media.durationSeconds,
      sha256: fileHash,
      format: media.format,
      container: media.container,
      size: sizeBytes,
      size_bytes: sizeBytes,
      streams: media.streams,
      relative_path: relativePath
    };
    const inlineText = JSON.stringify(sidecar);
    const sidecarHash = sha256Text(inlineText);
    const bounds: MediaCorpusBounds = {
      duration_seconds: media.durationSeconds,
      sha256: fileHash,
      sidecar_sha256: sidecarHash,
      format: media.format,
      container: media.container,
      size: sizeBytes,
      size_bytes: sizeBytes,
      streams: JSON.stringify(media.streams),
      relative_path: relativePath
    };

    sources.push({
      id: sourceId,
      path: filePath,
      sha256: fileHash,
      type: media.type
    });
    shards.push({
      id: `${sourceId}:media`,
      source_id: sourceId,
      inline_text: inlineText,
      bounds
    });
  }

  if (sources.length === 0) {
    throw new HarnessError("empty_media_source", "Media source contains no audio/video files", {
      source_path: input.sourcePath
    });
  }

  return {
    schema_version: "deepseek-harness.corpus.v1",
    project: input.project,
    workload_type: "media_catalogue",
    privacy_lane: input.privacyLane,
    ...(input.artifactDir ? { artifact_dir: input.artifactDir } : {}),
    processor: { type: "copy_text" },
    sources,
    shards
  };
}

function validateInput(input: BuildMediaCorpusManifestInput): void {
  if (!input || typeof input !== "object") {
    throw new HarnessError("invalid_media_input", "Media corpus input must be an object");
  }
  if (typeof input.project !== "string" || input.project.trim().length === 0) {
    throw new HarnessError("invalid_media_project", "Media corpus project must not be empty");
  }
  if (typeof input.sourcePath !== "string" || input.sourcePath.trim().length === 0) {
    throw new HarnessError("invalid_media_source_path", "Media corpus sourcePath must not be empty");
  }
  if (
    input.privacyLane !== "local_only" &&
    input.privacyLane !== "external_inference_allowed" &&
    input.privacyLane !== "redacted_external_allowed"
  ) {
    throw new HarnessError("invalid_media_privacy_lane", "Media corpus privacyLane is invalid");
  }
  if (input.artifactDir !== undefined && (typeof input.artifactDir !== "string" || input.artifactDir.trim().length === 0)) {
    throw new HarnessError("invalid_media_artifact_dir", "Media corpus artifactDir must be a non-empty string when provided");
  }
  if (input.recursive !== undefined && typeof input.recursive !== "boolean") {
    throw new HarnessError("invalid_media_recursive", "Media corpus recursive must be a boolean when provided");
  }
  if (
    input.maxFiles !== undefined &&
    (!Number.isInteger(input.maxFiles) || input.maxFiles <= 0 || input.maxFiles > MAX_MEDIA_SHARDS)
  ) {
    throw new HarnessError(
      "invalid_media_max_files",
      `Media corpus maxFiles must be a positive integer no greater than ${MAX_MEDIA_SHARDS}`
    );
  }
}

function enumerateRegularFiles(root: string, recursive: boolean, limit: number): string[] {
  const files: string[] = [];
  visitDirectory(root, root, recursive, files, limit);
  files.sort(comparePaths);
  return files;
}

function visitDirectory(directory: string, root: string, recursive: boolean, files: string[], limit: number): void {
  let opened: fs.Dir;
  try {
    opened = fs.opendirSync(directory);
  } catch (error) {
    throw new HarnessError("media_directory_read_failed", `Unable to read media directory: ${directory}`, {
      cause: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    let entry: fs.Dirent | null;
    while ((entry = opened.readSync()) !== null) {
      const entryPath = path.join(directory, entry.name);
      let entryStat: fs.Stats;
      try {
        entryStat = fs.lstatSync(entryPath);
      } catch (error) {
        throw new HarnessError("media_entry_stat_failed", `Unable to inspect media entry: ${entryPath}`, {
          cause: error instanceof Error ? error.message : String(error)
        });
      }
      if (entryStat.isSymbolicLink()) {
        throw new HarnessError("media_symlink_rejected", "Media source must not contain symlinks", {
          path: toPosixRelativePath(root, entryPath)
        });
      }
      if (entryStat.isFile()) {
        if (entryStat.nlink > 1) {
          throw new HarnessError("corpus_input_path_blocked", "Media input must not be a hard-linked regular file", {
            path: toPosixRelativePath(root, entryPath)
          });
        }
        files.push(entryPath);
        if (files.length > limit) {
          return;
        }
        continue;
      }
      if (entryStat.isDirectory() && recursive) {
        visitDirectory(entryPath, root, true, files, limit);
        if (files.length > limit) {
          return;
        }
      }
    }
  } finally {
    opened.closeSync();
  }
}

function probeMedia(filePath: string): MediaProbe | null {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
    {
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: FFPROBE_MAX_BUFFER_BYTES,
      timeout: FFPROBE_TIMEOUT_MS,
      killSignal: "SIGTERM"
    }
  );
  if (isSpawnTimedOut(result)) {
    throw mediaToolTimeout(filePath);
  }
  if (result.error) {
    const code = "code" in result.error ? (result.error as { code?: unknown }).code : undefined;
    if (code === "ENOENT") {
      throw new HarnessError("media_ffprobe_unavailable", "ffprobe is required for media corpus ingestion");
    }
    throw new HarnessError("media_ffprobe_failed", `ffprobe could not inspect media file: ${filePath}`, {
      cause: result.error.message
    });
  }
  if (result.status !== 0) {
    return null;
  }

  const output = typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.format) || !Array.isArray(parsed.streams)) {
    return null;
  }

  const streamRecords = parsed.streams.filter(isRecord);
  const mediaTypes = streamRecords
    .map((stream) => (typeof stream.codec_type === "string" ? stream.codec_type : ""))
    .filter((codecType): codecType is "audio" | "video" => MEDIA_STREAM_TYPES.has(codecType));
  if (mediaTypes.length === 0) {
    return null;
  }

  const durationSeconds = numberValue(parsed.format.duration);
  if (durationSeconds === undefined || durationSeconds < 0) {
    return null;
  }
  const format = stringValue(parsed.format.format_name) ?? "unknown";
  const container = stringValue(parsed.format.format_long_name) ?? format;
  return {
    type: mediaTypes.includes("video") ? "video" : "audio",
    durationSeconds,
    format,
    container,
    streams: streamRecords.map(sanitiseStream)
  };
}

function isSpawnTimedOut(result: { error?: Error; signal?: NodeJS.Signals | null }): boolean {
  const code = result.error && "code" in result.error
    ? (result.error as NodeJS.ErrnoException).code
    : undefined;
  return code === "ETIMEDOUT" || /(?:ETIMEDOUT|timed out)/i.test(result.error?.message ?? "");
}

function mediaToolTimeout(filePath: string): HarnessError {
  return new HarnessError("media_tool_timeout", `ffprobe timed out after ${FFPROBE_TIMEOUT_MS} ms while inspecting media file: ${filePath}`, {
    command: "ffprobe",
    timeout_ms: FFPROBE_TIMEOUT_MS,
    path: filePath
  });
}

function sanitiseStream(stream: Record<string, unknown>): ProbeStream {
  const sanitised: ProbeStream = {};
  for (const field of STREAM_FIELDS) {
    const value = stream[field];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      sanitised[field] = value;
    }
  }
  return sanitised;
}

function hashFile(filePath: string): string {
  const hash = createHash("sha256");
  let fd: number | undefined;
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
    return hash.digest("hex");
  } catch (error) {
    throw new HarnessError("media_hash_failed", `Unable to hash media file: ${filePath}`, {
      cause: error instanceof Error ? error.message : String(error)
    });
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

function lstatOrThrow(filePath: string, code: string, message: string): fs.Stats {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    throw new HarnessError(code, message, {
      path: filePath,
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

function toPosixRelativePath(root: string, filePath: string): string {
  const relative = path.relative(root, filePath) || path.basename(filePath);
  return relative.split(path.sep).join("/");
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
