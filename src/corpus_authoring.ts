import fs from "node:fs";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { HarnessError } from "./errors.js";
import { assertSafeCorpusSourcePath } from "./paths.js";

export type AuthoringPrivacyLane = "local_only" | "external_inference_allowed" | "redacted_external_allowed";

export type AuthoringTransport = "fake" | "dry-run" | "deepseek";

export type AuthoringModel = "deepseek-v4-flash" | "deepseek-v4-pro";
export type AuthoringResponseFormat = "text" | "json_object";

export interface AuthoringThinking {
  type: "enabled" | "disabled";
  reasoning_effort?: "high" | "max";
}

export interface AuthoringBatchProcessor {
  type: "deepseek_batch";
  transport: AuthoringTransport;
  model: AuthoringModel;
  thinking: AuthoringThinking;
  response_format: AuthoringResponseFormat;
  prompt_template: string;
  system_prompt?: string;
  concurrency: number;
  cost_cap_usd: number;
  max_tokens: number;
  approval_receipt?: Record<string, unknown>;
}

export type AuthoringBoundValue = string | number | boolean | null;

export interface AuthoringSource {
  id: string;
  path: string;
  sha256: string;
  type: "text";
}

export interface AuthoringShard {
  id: string;
  source_id: string;
  inline_text: string;
  bounds: Record<string, AuthoringBoundValue>;
  [key: string]: unknown;
}

export interface BookCorpusManifest {
  schema_version: "deepseek-harness.corpus.v1";
  project: string;
  workload_type: "book_reading";
  privacy_lane: AuthoringPrivacyLane;
  artifact_dir?: string;
  processor: AuthoringBatchProcessor;
  sources: [AuthoringSource];
  shards: AuthoringShard[];
  acceptance: {
    coverage: "all_shards";
    preserve_citations: true;
  };
}

export interface LongformCorpusManifest {
  schema_version: "deepseek-harness.corpus.v1";
  project: string;
  workload_type: "longform_generation";
  privacy_lane: AuthoringPrivacyLane;
  artifact_dir?: string;
  processor: AuthoringBatchProcessor;
  sources: [AuthoringSource];
  shards: AuthoringShard[];
  acceptance: {
    minimum_words_per_section: number;
    continuity_required: boolean;
    citation_policy: string;
  };
}

export interface BuildAuthoringProcessorInput {
  project: string;
  privacyLane?: AuthoringPrivacyLane;
  transport?: AuthoringTransport;
  model?: AuthoringModel;
  thinking?: AuthoringThinking;
  responseFormat?: AuthoringResponseFormat;
  promptTemplate?: string;
  systemPrompt?: string;
  concurrency?: number;
  costCapUsd?: number;
  maxTokens?: number;
  artifactDir?: string;
  expectedSha256?: string;
  approvalReceipt?: Record<string, unknown>;
}

export interface BuildBookCorpusManifestInput extends BuildAuthoringProcessorInput {
  sourcePath: string;
  chunkChars?: number;
  overlapChars?: number;
}

export interface BuildLongformCorpusManifestInput extends BuildAuthoringProcessorInput {
  outlinePath: string;
  minimumWordsPerSection?: number;
  continuityRequired?: boolean;
  citationPolicy?: string;
}

export const DEFAULT_BOOK_ANALYSIS_PROMPT = [
  "You are a careful whole-book analyst writing in British English.",
  "Analyse every part of the supplied book text, using the chapter and shard bounds as navigation metadata.",
  "Separate observations grounded in the text from inference, preserve useful quotations and citations, and never invent a source.",
  "Return concise, evidence-led analysis notes for this shard and explain any uncertainty.",
  "Book shard text:\n{{text}}\n\nShard bounds:\n{{bounds}}"
].join("\n\n");

export const DEFAULT_LONGFORM_AUTHORING_PROMPT = [
  "Write one coherent long-form section in British English from the outline context below.",
  "Keep the section faithful to the brief, maintain continuity with the wider outline, and preserve or clearly qualify citations.",
  "Do not invent citations or claim evidence that is not present in the supplied context.",
  "Outline section context:\n{{text}}\n\nSection bounds:\n{{bounds}}"
].join("\n\n");

const DEFAULT_BOOK_CHUNK_CHARS = 8_000;
const DEFAULT_BOOK_OVERLAP_CHARS = 800;
const DEFAULT_LONGFORM_MINIMUM_WORDS = 800;
const DEFAULT_MAX_TOKENS = 4_096;
const DEFAULT_CITATION_POLICY = "Preserve supplied citations; do not invent sources; mark unsupported claims for review.";
const MAX_CHUNK_CHARS = 1_000_000;
const MAX_SHARDS = 10_000;
const MAX_SECTIONS = 10_000;
const MAX_TEXT_FIELD_CHARS = 200_000;
const CORE_PROMPT_MAX_CHARS = 65_536;
const MAX_BOOK_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_OUTLINE_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_AUTHORING_MANIFEST_CHARS = 128 * 1024 * 1024;

export function buildBookCorpusManifest(input: BuildBookCorpusManifestInput): BookCorpusManifest {
  const project = requiredText(input?.project, "project");
  const source = readUtf8Source(input?.sourcePath, "book");
  validateExpectedHash(input, source.sha256);

  const chunkChars = integerOption(input?.chunkChars, DEFAULT_BOOK_CHUNK_CHARS, "chunkChars", 1, MAX_CHUNK_CHARS);
  const overlapChars = integerOption(
    input?.overlapChars,
    DEFAULT_BOOK_OVERLAP_CHARS,
    "overlapChars",
    0,
    MAX_CHUNK_CHARS - 1
  );
  if (overlapChars >= chunkChars) {
    throw new HarnessError("invalid_corpus_overlap_chars", "overlapChars must be smaller than chunkChars");
  }

  const privacyLane = normalisePrivacyLane(input);
  const artifactDir = optionalText(input?.artifactDir, "artifactDir");
  const sourceId = sourceIdentifier(source.path, source.sha256);
  const segments = detectBookSegments(source.text);
  assertBookShardPlanBounded(segments, chunkChars, overlapChars);
  const shards: AuthoringShard[] = [];
  for (const segment of segments) {
    appendBookSegmentShards(shards, source.text, sourceId, source.sha256, segment, chunkChars, overlapChars);
    if (shards.length > MAX_SHARDS) {
      throw new HarnessError("corpus_shard_limit_exceeded", `Book would create more than ${MAX_SHARDS} shards`);
    }
  }
  if (shards.length === 0) {
    throw new HarnessError("empty_corpus_source", "Book source must contain non-whitespace text");
  }

  const prompt = choosePrompt(input, "book");
  const manifest: BookCorpusManifest = {
    schema_version: "deepseek-harness.corpus.v1",
    project,
    workload_type: "book_reading",
    privacy_lane: privacyLane,
    ...(artifactDir ? { artifact_dir: artifactDir } : {}),
    processor: buildProcessor(input, prompt),
    sources: [{ id: sourceId, path: source.path, sha256: source.sha256, type: "text" }],
    shards,
    acceptance: { coverage: "all_shards", preserve_citations: true }
  };
  return manifest;
}

export function buildLongformCorpusManifest(input: BuildLongformCorpusManifestInput): LongformCorpusManifest {
  const project = requiredText(input?.project, "project");
  const source = readUtf8Source(input?.outlinePath, "outline");
  validateExpectedHash(input, source.sha256);
  const outline = parseOutline(source.text);
  const sourceId = sourceIdentifier(source.path, source.sha256);
  const privacyLane = normalisePrivacyLane(input);
  const artifactDir = optionalText(input?.artifactDir, "artifactDir");

  const minimumWords = integerOption(
    input?.minimumWordsPerSection,
    DEFAULT_LONGFORM_MINIMUM_WORDS,
    "minimumWordsPerSection",
    1,
    100_000
  );
  const continuityRequired = booleanOption(
    input?.continuityRequired,
    true,
    "continuityRequired"
  );
  const citationPolicy = optionalText(input?.citationPolicy, "citationPolicy") ?? DEFAULT_CITATION_POLICY;
  if (citationPolicy.length > MAX_TEXT_FIELD_CHARS) {
    throw new HarnessError("invalid_citation_policy", `citationPolicy must be at most ${MAX_TEXT_FIELD_CHARS} characters`);
  }

  let materialisedChars = 0;
  const shards: AuthoringShard[] = outline.sections.map((section, index) => {
    const inlineText = formatOutlineSection(outline, section, index);
    materialisedChars += inlineText.length;
    if (materialisedChars > MAX_AUTHORING_MANIFEST_CHARS) {
      throw new HarnessError(
        "longform_manifest_too_large",
        `Long-form outline would materialise more than ${MAX_AUTHORING_MANIFEST_CHARS} manifest characters`
      );
    }
    const shardHash = sha256Text(inlineText);
    const sectionIndex = index + 1;
    return {
      id: `${sourceId}:section:${String(sectionIndex).padStart(6, "0")}`,
      source_id: sourceId,
      inline_text: inlineText,
      bounds: {
        section: section.title,
        section_index: sectionIndex,
        section_count: outline.sections.length,
        source_sha256: source.sha256,
        shard_sha256: shardHash
      }
    };
  });

  return {
    schema_version: "deepseek-harness.corpus.v1",
    project,
    workload_type: "longform_generation",
    privacy_lane: privacyLane,
    ...(artifactDir ? { artifact_dir: artifactDir } : {}),
    processor: buildProcessor(input, choosePrompt(input, "longform")),
    sources: [{ id: sourceId, path: source.path, sha256: source.sha256, type: "text" }],
    shards,
    acceptance: {
      minimum_words_per_section: minimumWords,
      continuity_required: continuityRequired,
      citation_policy: citationPolicy
    }
  };
}

interface ReadSource {
  path: string;
  text: string;
  sha256: string;
}

interface OutlineSection {
  title: string;
  brief: string;
}

interface OutlineDocument {
  title: string;
  audience?: string;
  voice?: string;
  sections: OutlineSection[];
}

interface BookSegment {
  start: number;
  end: number;
  chapter: string;
  chapterIndex: number;
}

function buildProcessor(input: BuildAuthoringProcessorInput, prompt: string): AuthoringBatchProcessor {
  const transport = input?.transport ?? "fake";
  if (transport !== "fake" && transport !== "dry-run" && transport !== "deepseek") {
    throw new HarnessError("invalid_corpus_transport", "transport must be fake, dry-run, or deepseek");
  }

  const model = input?.model ?? "deepseek-v4-flash";
  if (model !== "deepseek-v4-flash" && model !== "deepseek-v4-pro") {
    throw new HarnessError("invalid_corpus_model", "model must be deepseek-v4-flash or deepseek-v4-pro");
  }

  const thinking = input?.thinking ?? { type: "enabled" as const };
  if (!thinking || (thinking.type !== "enabled" && thinking.type !== "disabled")) {
    throw new HarnessError("invalid_corpus_thinking", "thinking.type must be enabled or disabled");
  }
  if (thinking.reasoning_effort !== undefined && thinking.reasoning_effort !== "high" && thinking.reasoning_effort !== "max") {
    throw new HarnessError("invalid_corpus_thinking", "thinking.reasoning_effort must be high or max");
  }

  const responseFormat = input?.responseFormat ?? "text";
  if (responseFormat !== "text" && responseFormat !== "json_object") {
    throw new HarnessError("invalid_corpus_response_format", "responseFormat must be text or json_object");
  }

  const concurrency = integerOption(input?.concurrency, 5, "concurrency", 1, 100);
  const costCapUsd = numberOption(input?.costCapUsd, 0.1, "costCapUsd", Number.MIN_VALUE, 100);
  const maxTokens = integerOption(input?.maxTokens, DEFAULT_MAX_TOKENS, "maxTokens", 1, 384_000);
  const systemPrompt = optionalText(input?.systemPrompt, "systemPrompt");
  if (systemPrompt) {
    validateSystemPrompt(systemPrompt);
  }

  const approvalReceipt = input?.approvalReceipt;
  if (approvalReceipt !== undefined && (!approvalReceipt || typeof approvalReceipt !== "object" || Array.isArray(approvalReceipt))) {
    throw new HarnessError("invalid_corpus_approval_receipt", "approvalReceipt must be an object when supplied");
  }

  return {
    type: "deepseek_batch",
    transport,
    model,
    thinking: { ...thinking },
    response_format: responseFormat,
    prompt_template: validatePromptTemplate(prompt),
    ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
    concurrency,
    cost_cap_usd: costCapUsd,
    max_tokens: maxTokens,
    ...(approvalReceipt ? { approval_receipt: approvalReceipt } : {})
  };
}

function choosePrompt(input: BuildAuthoringProcessorInput, kind: "book" | "longform"): string {
  const supplied = optionalText(input?.promptTemplate, "promptTemplate");
  const fallback = kind === "book" ? DEFAULT_BOOK_ANALYSIS_PROMPT : DEFAULT_LONGFORM_AUTHORING_PROMPT;
  if (!supplied) {
    return validatePromptTemplate(fallback);
  }
  const prompt = supplied.includes("{{text}}")
    ? supplied
    : `${supplied}\n\nSource text:\n{{text}}\n\nShard bounds:\n{{bounds}}`;
  return validatePromptTemplate(prompt);
}

function validatePromptTemplate(prompt: string): string {
  const placeholderCount = (prompt.match(/\{\{text\}\}/g) ?? []).length;
  if (placeholderCount !== 1) {
    throw new HarnessError("invalid_analysis_prompt", "Prompt template must contain {{text}} exactly once");
  }
  if (prompt.length > CORE_PROMPT_MAX_CHARS) {
    throw new HarnessError(
      "invalid_analysis_prompt",
      `Prompt template must be at most ${CORE_PROMPT_MAX_CHARS} characters`
    );
  }
  return prompt;
}

function validateSystemPrompt(systemPrompt: string): string {
  if (systemPrompt.length > CORE_PROMPT_MAX_CHARS) {
    throw new HarnessError(
      "invalid_system_prompt",
      `systemPrompt must be at most ${CORE_PROMPT_MAX_CHARS} characters`
    );
  }
  return systemPrompt;
}

function normalisePrivacyLane(input: BuildAuthoringProcessorInput): AuthoringPrivacyLane {
  const lane = input?.privacyLane ?? "local_only";
  if (lane !== "local_only" && lane !== "external_inference_allowed" && lane !== "redacted_external_allowed") {
    throw new HarnessError("invalid_corpus_privacy_lane", "privacyLane is not a supported corpus privacy lane");
  }
  return lane;
}

function readUtf8Source(sourcePath: string | undefined, kind: "book" | "outline"): ReadSource {
  const value = requiredText(sourcePath, kind === "book" ? "sourcePath" : "outlinePath");
  const resolvedPath = assertSafeCorpusSourcePath(value);
  let bytes: Buffer;
  try {
    const stats = fs.statSync(resolvedPath);
    if (!stats.isFile()) {
      throw new HarnessError("invalid_corpus_source_path", `Corpus source path is not a file: ${resolvedPath}`);
    }
    const maximumBytes = kind === "book" ? MAX_BOOK_SOURCE_BYTES : MAX_OUTLINE_SOURCE_BYTES;
    if (stats.size > maximumBytes) {
      throw new HarnessError(
        "corpus_source_too_large",
        `Corpus ${kind} source exceeds the ${maximumBytes}-byte ingest cap`
      );
    }
    bytes = fs.readFileSync(resolvedPath);
  } catch (error) {
    if (error instanceof HarnessError) {
      throw error;
    }
    throw new HarnessError("corpus_source_not_found", `Could not read corpus source: ${resolvedPath}`);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HarnessError("invalid_utf8_corpus_source", `Corpus ${kind} source must be valid UTF-8: ${resolvedPath}`);
  }
  if (text.trim().length === 0) {
    throw new HarnessError("empty_corpus_source", `Corpus ${kind} source must contain non-whitespace text`);
  }
  return { path: resolvedPath, text, sha256: sha256Bytes(bytes) };
}

function parseOutline(text: string): OutlineDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HarnessError("invalid_longform_outline", "Long-form outline must be valid JSON");
  }
  if (!isRecord(value)) {
    throw new HarnessError("invalid_longform_outline", "Long-form outline must be a JSON object");
  }

  const title = requiredText(value.title, "outline.title");
  if (title.length > MAX_TEXT_FIELD_CHARS) {
    throw new HarnessError("invalid_longform_outline", "outline.title is too long");
  }
  const audience = optionalOutlineText(value.audience, "outline.audience");
  const voice = optionalOutlineText(value.voice, "outline.voice");
  if (!Array.isArray(value.sections) || value.sections.length === 0) {
    throw new HarnessError("invalid_longform_outline", "Long-form outline must include at least one section");
  }
  if (value.sections.length > MAX_SECTIONS) {
    throw new HarnessError("longform_section_limit_exceeded", `Long-form outline cannot contain more than ${MAX_SECTIONS} sections`);
  }

  const seen = new Set<string>();
  const sections: OutlineSection[] = value.sections.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new HarnessError("invalid_longform_outline", `Outline section ${index + 1} must be an object`);
    }
    const sectionTitle = requiredText(raw.title, `outline.sections[${index}].title`);
    const brief = requiredText(raw.brief, `outline.sections[${index}].brief`);
    if (sectionTitle.length > MAX_TEXT_FIELD_CHARS || brief.length > MAX_TEXT_FIELD_CHARS) {
      throw new HarnessError("invalid_longform_outline", `Outline section ${index + 1} title and brief are too long`);
    }
    const key = sectionTitle.toLocaleLowerCase("en-GB");
    if (seen.has(key)) {
      throw new HarnessError("duplicate_longform_section_title", `Duplicate long-form section title: ${sectionTitle}`);
    }
    seen.add(key);
    return { title: sectionTitle, brief };
  });

  return { title, ...(audience ? { audience } : {}), ...(voice ? { voice } : {}), sections };
}

function formatOutlineSection(outline: OutlineDocument, section: OutlineSection, index: number): string {
  const lines = [`Outline title: ${outline.title}`];
  if (outline.audience) {
    lines.push(`Audience: ${outline.audience}`);
  }
  if (outline.voice) {
    lines.push(`Voice: ${outline.voice}`);
  }
  lines.push(`Section ${index + 1} of ${outline.sections.length}: ${section.title}`, `Brief: ${section.brief}`);
  return lines.join("\n\n");
}

function detectBookSegments(text: string): BookSegment[] {
  const headings = detectChapterHeadings(text);
  if (headings.length === 0) {
    return [{ start: 0, end: text.length, chapter: "Whole book", chapterIndex: 1 }];
  }

  const segments: BookSegment[] = [];
  const firstHeading = headings[0];
  if (firstHeading && text.slice(0, firstHeading.start).trim().length > 0) {
    segments.push({ start: 0, end: firstHeading.start, chapter: "Front matter", chapterIndex: 0 });
  }
  headings.forEach((heading, index) => {
    const next = headings[index + 1];
    segments.push({
      start: heading.start,
      end: next?.start ?? text.length,
      chapter: heading.chapter,
      chapterIndex: index + 1
    });
  });
  return segments.filter((segment) => segment.end > segment.start && text.slice(segment.start, segment.end).trim().length > 0);
}

interface ChapterHeading {
  start: number;
  chapter: string;
}

function detectChapterHeadings(text: string): ChapterHeading[] {
  const headings: ChapterHeading[] = [];
  let offset = 0;
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    const chapter = chapterHeadingLabel(trimmed);
    if (chapter) {
      headings.push({ start: offset, chapter });
    }
    offset += rawLine.length + 1;
  }
  return headings;
}

function chapterHeadingLabel(line: string): string | undefined {
  if (!line || line.length > 2_000) {
    return undefined;
  }
  const markdownMatch = line.match(/^#{1,6}\s+(.+)$/);
  const candidate = (markdownMatch?.[1] ?? line).trim().replace(/\s+/g, " ");
  if (/^(?:chapter|ch\.?)(?:\s|$)/i.test(candidate) || /^part\s+(?:[0-9]+|[ivxlcdm]+|[a-z]+)/i.test(candidate)) {
    return candidate;
  }
  if (/^(?:[0-9]{1,4}|[ivxlcdm]{1,12})[.)\-:\u2013\u2014]\s+\S+/i.test(candidate) && markdownMatch) {
    return candidate;
  }
  return undefined;
}

function appendBookSegmentShards(
  shards: AuthoringShard[],
  text: string,
  sourceId: string,
  sourceSha256: string,
  segment: BookSegment,
  chunkChars: number,
  overlapChars: number
): void {
  const segmentLength = segment.end - segment.start;
  const stepChars = chunkChars - overlapChars;
  for (let localStart = 0; localStart < segmentLength; localStart += stepChars) {
    const localEnd = Math.min(localStart + chunkChars, segmentLength);
    const startChar = segment.start + localStart;
    const endChar = segment.start + localEnd;
    const inlineText = text.slice(startChar, endChar);
    const chunkIndex = shards.length;
    const shardHash = sha256Text(inlineText);
    shards.push({
      id: `${sourceId}:chunk:${String(chunkIndex + 1).padStart(6, "0")}`,
      source_id: sourceId,
      inline_text: inlineText,
      bounds: {
        chapter: segment.chapter,
        chapter_index: segment.chapterIndex,
        chapter_start_char: segment.start,
        chapter_end_char: segment.end,
        chunk_index: chunkIndex,
        start_char: startChar,
        end_char: endChar,
        chunk_chars: chunkChars,
        overlap_chars: overlapChars,
        source_sha256: sourceSha256,
        shard_sha256: shardHash
      }
    });
    if (endChar === segment.end) {
      break;
    }
  }
}

function assertBookShardPlanBounded(segments: BookSegment[], chunkChars: number, overlapChars: number): void {
  const stepChars = chunkChars - overlapChars;
  let shardCount = 0;
  let materialisedChars = 0;
  for (const segment of segments) {
    const segmentChars = segment.end - segment.start;
    const segmentShards = segmentChars <= chunkChars
      ? 1
      : 1 + Math.ceil((segmentChars - chunkChars) / stepChars);
    const finalShardChars = segmentChars <= chunkChars
      ? segmentChars
      : segmentChars - (segmentShards - 1) * stepChars;
    shardCount += segmentShards;
    materialisedChars += (segmentShards - 1) * chunkChars + finalShardChars;
    if (shardCount > MAX_SHARDS) {
      throw new HarnessError("corpus_shard_limit_exceeded", `Book would create more than ${MAX_SHARDS} shards`);
    }
    if (materialisedChars > MAX_AUTHORING_MANIFEST_CHARS) {
      throw new HarnessError(
        "book_manifest_too_large",
        `Book overlap would materialise more than ${MAX_AUTHORING_MANIFEST_CHARS} manifest characters`
      );
    }
  }
}

function validateExpectedHash(input: BuildAuthoringProcessorInput, actualHash: string): void {
  if (input?.expectedSha256 === undefined) {
    return;
  }
  const expected = requiredText(input.expectedSha256, "expectedSha256");
  if (!/^[a-f0-9]{64}$/i.test(expected)) {
    throw new HarnessError("invalid_corpus_source_hash", "Expected source SHA-256 must be a 64-character hexadecimal digest");
  }
  if (expected.toLowerCase() !== actualHash) {
    throw new HarnessError("corpus_source_hash_mismatch", "Expected source SHA-256 does not match the file read from disk");
  }
}

function sourceIdentifier(sourcePath: string, sourceSha256: string): string {
  return `source:${sha256Text(`${sourcePath}\0${sourceSha256}`).slice(0, 16)}`;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HarnessError("invalid_authoring_input", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HarnessError("invalid_authoring_input", `${field} must be a non-empty string when supplied`);
  }
  return value.trim();
}

function optionalOutlineText(value: unknown, field: string): string | undefined {
  const result = optionalText(value, field);
  if (result && result.length > MAX_TEXT_FIELD_CHARS) {
    throw new HarnessError("invalid_longform_outline", `${field} is too long`);
  }
  return result;
}

function integerOption(value: unknown, fallback: number, field: string, min: number, max: number): number {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved !== "number" || !Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new HarnessError(integerOptionErrorCode(field), `${field} must be an integer between ${min} and ${max}`);
  }
  return resolved;
}

function integerOptionErrorCode(field: string): string {
  const codes: Record<string, string> = {
    chunkChars: "invalid_corpus_chunk_chars",
    overlapChars: "invalid_corpus_overlap_chars",
    concurrency: "invalid_corpus_concurrency",
    maxTokens: "invalid_corpus_max_tokens",
    minimumWordsPerSection: "invalid_longform_minimum_words"
  };
  return codes[field] ?? `invalid_${field}`;
}

function numberOption(value: unknown, fallback: number, field: string, minExclusive: number, max: number): number {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved !== "number" || !Number.isFinite(resolved) || resolved <= minExclusive || resolved > max) {
    throw new HarnessError(field === "costCapUsd" ? "invalid_corpus_cost_cap_usd" : `invalid_${field}`, `${field} must be greater than ${minExclusive} and at most ${max}`);
  }
  return resolved;
}

function booleanOption(value: unknown, fallback: boolean, field: string): boolean {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved !== "boolean") {
    throw new HarnessError(`invalid_${field}`, `${field} must be a boolean`);
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
