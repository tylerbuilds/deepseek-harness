import fs from "node:fs";
import { createHash } from "node:crypto";
import { HarnessError } from "./errors.js";
import { assertSafeCorpusSourcePath } from "./paths.js";

export type TranslationTransport = "fake" | "dry-run" | "deepseek";

export type TranslationPrivacyLane = "local_only" | "external_inference_allowed" | "redacted_external_allowed";

export interface TranslationGlossaryTerm {
  source: string;
  target: string;
}

export type TranslationGlossaryInput =
  | Record<string, string>
  | readonly TranslationGlossaryTerm[]
  | readonly (readonly [string, string])[]
  | string
  | null
  | undefined;

export interface BuildTranslationCorpusManifestInput {
  sourceText?: string;
  sourcePath?: string;
  project?: string;
  sourceLang: string;
  targetLang: string;
  glossary?: TranslationGlossaryInput;
  glossaryPath?: string;
  chunkChars?: number;
  overlapChars?: number;
  transport?: TranslationTransport;
  privacyLane?: TranslationPrivacyLane;
  model?: "deepseek-v4-flash" | "deepseek-v4-pro";
  concurrency?: number;
  costCapUsd?: number;
  maxTokens?: number;
  maxRetries?: number;
  artifactDir?: string;
  translationMemoryPath?: string;
  systemPrompt?: string;
  minLengthRatio?: number;
  maxLengthRatio?: number;
  approvalReceipt?: unknown;
}

export interface TranslationCorpusSource {
  id: string;
  path?: string;
  sha256: string;
  type: "text";
}

export interface TranslationShardBounds {
  chunk_index: number;
  start_char: number;
  end_char: number;
  chunk_chars: number;
  overlap_chars: number;
  source_sha256: string;
  shard_sha256: string;
  source_lang: string;
  target_lang: string;
}

export interface TranslationCorpusShard {
  id: string;
  source_id: string;
  inline_text: string;
  source_lang: string;
  target_lang: string;
  bounds: TranslationShardBounds;
}

export interface TranslationProcessor {
  type: "deepseek_batch";
  transport: TranslationTransport;
  model: "deepseek-v4-flash" | "deepseek-v4-pro";
  thinking: { type: "enabled" };
  response_format: "text";
  prompt_template: string;
  system_prompt: string;
  concurrency: number;
  cost_cap_usd: number;
  max_tokens: number;
  approval_receipt?: unknown;
}

export interface TranslationAcceptance {
  translation: {
    source_lang: string;
    target_lang: string;
    glossary_sha256: string | null;
    glossary: Record<string, string>;
    min_length_ratio: number;
    max_length_ratio: number;
    preserve_placeholders: true;
    translation_memory_path?: string;
  };
  language_pair_label: string;
}

export interface TranslationCorpusManifest {
  schema_version: "deepseek-harness.corpus.v1";
  project: string;
  workload_type: "translation";
  privacy_lane: TranslationPrivacyLane;
  artifact_dir?: string;
  processor: TranslationProcessor;
  max_retries: number;
  sources: TranslationCorpusSource[];
  shards: TranslationCorpusShard[];
  acceptance: TranslationAcceptance;
}

export interface TranslationQaInput {
  sourceText: string;
  outputText: string;
  sourceLang: string;
  targetLang: string;
  glossary?: TranslationGlossaryInput;
  minLengthRatio?: number;
  maxLengthRatio?: number;
}

export interface TranslationQaMetrics {
  source_lang: string;
  target_lang: string;
  languages_differ: boolean;
  source_chars: number;
  output_chars: number;
  source_words: number;
  output_words: number;
  source_nontrivial: boolean;
  unchanged: boolean;
  length_ratio: number | null;
  min_length_ratio: number;
  max_length_ratio: number;
  length_ratio_checked: boolean;
  placeholders_required: string[];
  placeholders_missing: string[];
  placeholder_counts: Record<string, { required: number; present: number }>;
  glossary_terms_required: TranslationGlossaryTerm[];
  glossary_terms_missing: TranslationGlossaryTerm[];
  glossary_sha256: string | null;
  glossary_invalid: boolean;
}

export interface TranslationQaResult {
  ok: boolean;
  blockers: string[];
  metrics: TranslationQaMetrics;
}

const DEFAULT_CHUNK_CHARS = 4_000;
const MAX_CHUNK_CHARS = 100_000;
const MAX_TRANSLATION_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_TRANSLATION_SHARDS = 10_000;
const MAX_TRANSLATION_MANIFEST_CHARS = 128 * 1024 * 1024;
const DEFAULT_OVERLAP_CHARS = 0;
const DEFAULT_MIN_LENGTH_RATIO = 0.25;
const DEFAULT_MAX_LENGTH_RATIO = 4;
const MAX_GLOSSARY_BYTES = 1_000_000;
const MAX_GLOSSARY_TERMS = 10_000;
const MAX_TERM_CHARS = 10_000;
const CORE_PROMPT_MAX_CHARS = 65_536;
const MIN_NONTRIVIAL_SOURCE_CHARS = 8;

export function buildTranslationCorpusManifest(input: BuildTranslationCorpusManifestInput): TranslationCorpusManifest {
  const sourceLang = normaliseLanguage(input.sourceLang, "sourceLang");
  const targetLang = normaliseLanguage(input.targetLang, "targetLang");
  const source = readSourceText(input);
  if (source.trim().length === 0) {
    throw new HarnessError("empty_translation_source", "Translation source text must not be empty");
  }

  const chunkChars = input.chunkChars ?? DEFAULT_CHUNK_CHARS;
  const overlapChars = input.overlapChars ?? DEFAULT_OVERLAP_CHARS;
  validateChunkOptions(chunkChars, overlapChars);
  assertTranslationShardPlanBounded(source.length, chunkChars, overlapChars);
  const glossary = parseGlossaryFromInput(input);
  const glossarySha256 = glossary.terms.length > 0 ? sha256Text(JSON.stringify(glossary.terms)) : null;
  const sourceSha256 = sha256Text(source);
  const sourcePath = sourcePathFromInput(input);
  const sourceIdSeed = [sourceSha256, sourceLang, targetLang].join("\0");
  const sourceId = `source:${sha256Text(sourceIdSeed).slice(0, 16)}`;
  const project = projectName(input.project, sourceLang, targetLang);
  const transport = input.transport ?? "fake";
  const minLengthRatio = ratioBound(input.minLengthRatio, DEFAULT_MIN_LENGTH_RATIO, "minLengthRatio");
  const maxLengthRatio = ratioBound(input.maxLengthRatio, DEFAULT_MAX_LENGTH_RATIO, "maxLengthRatio");
  if (minLengthRatio > maxLengthRatio) {
    throw new HarnessError("invalid_translation_ratio_bounds", "minLengthRatio must not exceed maxLengthRatio");
  }

  const shards = chunkTranslationText(source, {
    sourceId,
    sourceSha256,
    sourceLang,
    targetLang,
    chunkChars,
    overlapChars
  });
  const glossaryMap = termsToMap(glossary.terms);
  const translationMemoryPath = stringOption(input.translationMemoryPath);
  const languagePairLabel = `${sourceLang}->${targetLang}`;
  const acceptance: TranslationAcceptance = {
    translation: {
      source_lang: sourceLang,
      target_lang: targetLang,
      glossary_sha256: glossarySha256,
      glossary: glossaryMap,
      min_length_ratio: minLengthRatio,
      max_length_ratio: maxLengthRatio,
      preserve_placeholders: true,
      ...(translationMemoryPath ? { translation_memory_path: translationMemoryPath } : {})
    },
    language_pair_label: languagePairLabel
  };

  return {
    schema_version: "deepseek-harness.corpus.v1",
    project,
    workload_type: "translation",
    privacy_lane: input.privacyLane ?? "local_only",
    ...(input.artifactDir ? { artifact_dir: input.artifactDir } : {}),
    processor: buildTranslationProcessor({ input, sourceLang, targetLang, glossary, transport }),
    max_retries: integerOption(input.maxRetries, 2, "maxRetries", 0, 10),
    sources: [
      {
        id: sourceId,
        ...(sourcePath ? { path: sourcePath } : {}),
        sha256: sourceSha256,
        type: "text"
      }
    ],
    shards,
    acceptance
  };
}

export function evaluateTranslationQa(input: TranslationQaInput): TranslationQaResult {
  const sourceText = typeof input.sourceText === "string" ? input.sourceText : "";
  const outputText = typeof input.outputText === "string" ? input.outputText : "";
  const sourceLang = safeLanguage(input.sourceLang);
  const targetLang = safeLanguage(input.targetLang);
  const minLengthRatio = ratioBound(input.minLengthRatio, DEFAULT_MIN_LENGTH_RATIO, "minLengthRatio");
  const maxLengthRatio = ratioBound(input.maxLengthRatio, DEFAULT_MAX_LENGTH_RATIO, "maxLengthRatio");
  if (minLengthRatio > maxLengthRatio) {
    throw new HarnessError("invalid_translation_ratio_bounds", "minLengthRatio must not exceed maxLengthRatio");
  }

  const sourceTrimmed = sourceText.trim();
  const outputTrimmed = outputText.trim();
  const sourceChars = characterLength(sourceTrimmed);
  const outputChars = characterLength(outputTrimmed);
  const sourceWords = wordCount(sourceTrimmed);
  const outputWords = wordCount(outputTrimmed);
  const languagesDiffer = languagesDifferForQa(sourceLang, targetLang);
  const sourceNontrivial = isNontrivialSource(sourceTrimmed);
  const unchanged = normaliseComparable(sourceTrimmed) === normaliseComparable(outputTrimmed);
  const lengthRatio = sourceChars > 0 ? outputChars / sourceChars : null;
  const lengthRatioChecked = sourceChars >= MIN_NONTRIVIAL_SOURCE_CHARS;

  const sourcePlaceholders = placeholderCounts(sourceText);
  const outputPlaceholders = placeholderCounts(outputText);
  const placeholdersRequired = [...sourcePlaceholders.keys()].sort();
  const placeholdersMissing = placeholdersRequired.filter(
    (token) => (outputPlaceholders.get(token) ?? 0) < (sourcePlaceholders.get(token) ?? 0)
  );
  const placeholderCountsMetric = Object.fromEntries(
    placeholdersRequired.map((token) => [
      token,
      { required: sourcePlaceholders.get(token) ?? 0, present: outputPlaceholders.get(token) ?? 0 }
    ])
  );

  let glossaryTerms: TranslationGlossaryTerm[] = [];
  let glossaryInvalid = false;
  try {
    glossaryTerms = parseGlossaryValue(input.glossary).terms;
  } catch {
    glossaryInvalid = input.glossary !== undefined && input.glossary !== null;
  }
  const glossaryRequired = glossaryTerms.filter((term) => containsTerm(sourceText, term.source));
  const glossaryTermsMissing = glossaryRequired.filter((term) => !outputText.includes(term.target));
  const glossarySha256 = glossaryInvalid || glossaryTerms.length === 0 ? null : sha256Text(JSON.stringify(glossaryTerms));

  const blockers: string[] = [];
  if (outputTrimmed.length === 0) {
    blockers.push("empty_output");
  }
  if (languagesDiffer && sourceNontrivial && unchanged) {
    blockers.push("unchanged_nontrivial_output");
  }
  if (placeholdersMissing.length > 0) {
    blockers.push("placeholders_lost");
  }
  if (glossaryInvalid) {
    blockers.push("invalid_glossary");
  } else if (glossaryTermsMissing.length > 0) {
    blockers.push("glossary_terms_missing");
  }
  if (outputTrimmed.length > 0 && lengthRatioChecked && lengthRatio !== null && (lengthRatio < minLengthRatio || lengthRatio > maxLengthRatio)) {
    blockers.push("length_ratio_out_of_bounds");
  }

  const metrics: TranslationQaMetrics = {
    source_lang: sourceLang,
    target_lang: targetLang,
    languages_differ: languagesDiffer,
    source_chars: sourceChars,
    output_chars: outputChars,
    source_words: sourceWords,
    output_words: outputWords,
    source_nontrivial: sourceNontrivial,
    unchanged,
    length_ratio: lengthRatio,
    min_length_ratio: minLengthRatio,
    max_length_ratio: maxLengthRatio,
    length_ratio_checked: lengthRatioChecked,
    placeholders_required: placeholdersRequired,
    placeholders_missing: placeholdersMissing,
    placeholder_counts: placeholderCountsMetric,
    glossary_terms_required: glossaryRequired,
    glossary_terms_missing: glossaryTermsMissing,
    glossary_sha256: glossarySha256,
    glossary_invalid: glossaryInvalid,
  };
  return { ok: blockers.length === 0, blockers, metrics };
}

function buildTranslationProcessor(options: {
  input: BuildTranslationCorpusManifestInput;
  sourceLang: string;
  targetLang: string;
  glossary: ParsedGlossary;
  transport: TranslationTransport;
}): TranslationProcessor {
  const { input, sourceLang, targetLang, glossary, transport } = options;
  const glossaryMap = termsToMap(glossary.terms);
  const glossaryInstruction = Object.keys(glossaryMap).length > 0
    ? `Required glossary mappings (use the target terms exactly): ${JSON.stringify(glossaryMap)}`
    : "There is no glossary for this batch.";
  const systemContract = [
    "You are a careful translation engine.",
    `Translate from ${sourceLang} to ${targetLang}.`,
    "Preserve every placeholder exactly as written, including its spelling and multiplicity.",
    "Apply the required glossary mappings whenever the source term occurs; do not alter the required target terms.",
    glossaryInstruction,
    "Return only the translated text. Do not add explanations, labels, or commentary."
  ].join(" ");
  const customSystemPrompt = stringOption(input.systemPrompt);
  const systemPrompt = customSystemPrompt ? `${systemContract} ${customSystemPrompt}` : systemContract;
  const promptTemplate = [
    `Translate this text from ${sourceLang} to ${targetLang}.`,
    glossaryInstruction,
    "Preserve all placeholders exactly and return only the translation.",
    "SOURCE TEXT:",
    "{{text}}"
  ].join("\n");

  validatePromptTemplate(promptTemplate);
  validateSystemPrompt(systemPrompt);

  return {
    type: "deepseek_batch",
    transport,
    model: input.model ?? "deepseek-v4-flash",
    thinking: { type: "enabled" },
    response_format: "text",
    prompt_template: promptTemplate,
    system_prompt: systemPrompt,
    concurrency: integerOption(input.concurrency, 5, "concurrency", 1, 100),
    cost_cap_usd: positiveNumberOption(input.costCapUsd, 0.1, "costCapUsd", 100),
    max_tokens: integerOption(input.maxTokens, 4_096, "maxTokens", 1, 384_000),
    ...(input.approvalReceipt !== undefined ? { approval_receipt: input.approvalReceipt } : {})
  };
}

function validatePromptTemplate(promptTemplate: string): void {
  const placeholderCount = (promptTemplate.match(/\{\{text\}\}/g) ?? []).length;
  if (placeholderCount !== 1) {
    throw new HarnessError("invalid_translation_prompt", "Translation prompt template must contain {{text}} exactly once");
  }
  if (promptTemplate.length > CORE_PROMPT_MAX_CHARS) {
    throw new HarnessError(
      "invalid_translation_prompt",
      `Translation prompt template must be at most ${CORE_PROMPT_MAX_CHARS} characters`
    );
  }
}

function validateSystemPrompt(systemPrompt: string): void {
  if (systemPrompt.length > CORE_PROMPT_MAX_CHARS) {
    throw new HarnessError(
      "invalid_translation_system_prompt",
      `Translation system prompt must be at most ${CORE_PROMPT_MAX_CHARS} characters`
    );
  }
}

function chunkTranslationText(
  text: string,
  options: {
    sourceId: string;
    sourceSha256: string;
    sourceLang: string;
    targetLang: string;
    chunkChars: number;
    overlapChars: number;
  }
): TranslationCorpusShard[] {
  const shards: TranslationCorpusShard[] = [];
  const step = options.chunkChars - options.overlapChars;
  for (let start = 0; start < text.length; start += step) {
    const end = Math.min(start + options.chunkChars, text.length);
    const inlineText = text.slice(start, end);
    const chunkIndex = shards.length;
    const shardSha256 = sha256Text(inlineText);
    const id = `${options.sourceId}:chunk:${String(chunkIndex + 1).padStart(6, "0")}`;
    const bounds: TranslationShardBounds = {
      chunk_index: chunkIndex,
      start_char: start,
      end_char: end,
      chunk_chars: options.chunkChars,
      overlap_chars: options.overlapChars,
      source_sha256: options.sourceSha256,
      shard_sha256: shardSha256,
      source_lang: options.sourceLang,
      target_lang: options.targetLang
    };
    shards.push({
      id,
      source_id: options.sourceId,
      inline_text: inlineText,
      source_lang: options.sourceLang,
      target_lang: options.targetLang,
      bounds
    });
    if (end === text.length) {
      break;
    }
  }
  return shards;
}

interface ParsedGlossary {
  terms: TranslationGlossaryTerm[];
}

function parseGlossaryFromInput(input: BuildTranslationCorpusManifestInput): ParsedGlossary {
  const filePath = stringOption(input.glossaryPath);
  if (filePath) {
    return parseGlossaryFile(filePath);
  }
  return parseGlossaryValue(input.glossary);
}

function parseGlossaryValue(value: unknown): ParsedGlossary {
  if (value === undefined || value === null || value === "") {
    return { terms: [] };
  }
  let parsed: unknown = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return { terms: [] };
    }
    if (!looksLikeJson(trimmed) && isExistingRegularFile(trimmed)) {
      return parseGlossaryFile(trimmed);
    }
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      throw new HarnessError("invalid_translation_glossary", "Glossary must be valid JSON or a readable JSON file");
    }
  }

  if (isRecord(parsed) && ("terms" in parsed || "entries" in parsed)) {
    const wrapped = parsed.terms ?? parsed.entries;
    return parseGlossaryValue(wrapped);
  }
  const terms: TranslationGlossaryTerm[] = [];
  if (Array.isArray(parsed)) {
    for (const [index, valueAtIndex] of parsed.entries()) {
      const term = glossaryTermFromValue(valueAtIndex, index);
      terms.push(term);
    }
  } else if (isRecord(parsed)) {
    for (const source of Object.keys(parsed).sort()) {
      const target = parsed[source];
      if (typeof target !== "string") {
        throw new HarnessError("invalid_translation_glossary", `Glossary target for ${source} must be a string`);
      }
      terms.push(validateGlossaryTerm({ source, target }, source));
    }
  } else {
    throw new HarnessError("invalid_translation_glossary", "Glossary JSON must be an object map or an array of terms");
  }

  if (terms.length > MAX_GLOSSARY_TERMS) {
    throw new HarnessError("invalid_translation_glossary", `Glossary must contain at most ${MAX_GLOSSARY_TERMS} terms`);
  }
  const unique = new Map<string, TranslationGlossaryTerm>();
  for (const term of terms) {
    const key = `${term.source}\0${term.target}`;
    unique.set(key, term);
  }
  return { terms: [...unique.values()].sort(compareGlossaryTerms) };
}

function glossaryTermFromValue(value: unknown, index: number): TranslationGlossaryTerm {
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string") {
    return validateGlossaryTerm({ source: value[0], target: value[1] }, `term ${index + 1}`);
  }
  if (!isRecord(value)) {
    throw new HarnessError("invalid_translation_glossary", `Glossary term ${index + 1} must be an object or pair`);
  }
  const source = firstString(value, ["source", "source_term", "sourceTerm", "from", "term"]);
  const target = firstString(value, ["target", "target_term", "targetTerm", "to", "translation"]);
  if (source === undefined || target === undefined) {
    throw new HarnessError("invalid_translation_glossary", `Glossary term ${index + 1} must include source and target strings`);
  }
  return validateGlossaryTerm({ source, target }, `term ${index + 1}`);
}

function validateGlossaryTerm(term: TranslationGlossaryTerm, label: string): TranslationGlossaryTerm {
  const source = term.source.trim();
  const target = term.target.trim();
  if (source.length === 0 || target.length === 0) {
    throw new HarnessError("invalid_translation_glossary", `Glossary ${label} must have non-empty source and target terms`);
  }
  if (source.length > MAX_TERM_CHARS || target.length > MAX_TERM_CHARS) {
    throw new HarnessError("invalid_translation_glossary", `Glossary ${label} exceeds the ${MAX_TERM_CHARS}-character term limit`);
  }
  return { source, target };
}

function parseGlossaryFile(filePathValue: string): ParsedGlossary {
  const filePath = assertSafeCorpusSourcePath(filePathValue);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new HarnessError("invalid_translation_glossary", "Glossary file does not exist or cannot be read");
  }
  if (!stat.isFile()) {
    throw new HarnessError("invalid_translation_glossary", "Glossary path must point to a regular file");
  }
  if (stat.size > MAX_GLOSSARY_BYTES) {
    throw new HarnessError("invalid_translation_glossary", `Glossary file exceeds the ${MAX_GLOSSARY_BYTES}-byte limit`);
  }
  let text: string;
  try {
    const bytes = fs.readFileSync(filePath);
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HarnessError("invalid_translation_glossary", "Glossary file must contain valid UTF-8 JSON");
  }
  if (text.trim().length === 0) {
    throw new HarnessError("invalid_translation_glossary", "Glossary file must contain JSON");
  }
  try {
    return parseGlossaryValue(text);
  } catch (error) {
    if (error instanceof HarnessError) {
      throw error;
    }
    throw new HarnessError("invalid_translation_glossary", "Glossary file must contain valid JSON");
  }
}

function readSourceText(input: BuildTranslationCorpusManifestInput): string {
  const sourcePathValue = stringOption(input.sourcePath);
  if (sourcePathValue) {
    const filePath = assertSafeCorpusSourcePath(sourcePathValue);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      throw new HarnessError("invalid_translation_source", "Translation source file does not exist or cannot be read");
    }
    if (!stat.isFile()) {
      throw new HarnessError("invalid_translation_source", "Translation source path must point to a regular file");
    }
    if (stat.size > MAX_TRANSLATION_SOURCE_BYTES) {
      throw new HarnessError(
        "translation_source_too_large",
        `Translation source exceeds the ${MAX_TRANSLATION_SOURCE_BYTES}-byte ingest cap`
      );
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(filePath));
    } catch {
      throw new HarnessError("invalid_utf8_translation_source", "Translation source must be valid UTF-8");
    }
  }
  const value = input.sourceText;
  if (typeof value !== "string") {
    throw new HarnessError("invalid_translation_source", "Translation input requires sourceText or sourcePath");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_TRANSLATION_SOURCE_BYTES) {
    throw new HarnessError(
      "translation_source_too_large",
      `Translation source exceeds the ${MAX_TRANSLATION_SOURCE_BYTES}-byte ingest cap`
    );
  }
  return value;
}

function sourcePathFromInput(input: BuildTranslationCorpusManifestInput): string | undefined {
  const sourcePathValue = stringOption(input.sourcePath);
  return sourcePathValue ? assertSafeCorpusSourcePath(sourcePathValue) : undefined;
}

function validateChunkOptions(chunkChars: number, overlapChars: number): void {
  if (!Number.isInteger(chunkChars) || chunkChars <= 0 || chunkChars > MAX_CHUNK_CHARS) {
    throw new HarnessError("invalid_translation_chunk_chars", `chunkChars must be an integer between 1 and ${MAX_CHUNK_CHARS}`);
  }
  if (!Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= chunkChars) {
    throw new HarnessError("invalid_translation_overlap_chars", "overlapChars must be a non-negative integer smaller than chunkChars");
  }
}

function assertTranslationShardPlanBounded(textChars: number, chunkChars: number, overlapChars: number): void {
  const stepChars = chunkChars - overlapChars;
  const shardCount = textChars <= chunkChars ? 1 : 1 + Math.ceil((textChars - chunkChars) / stepChars);
  if (shardCount > MAX_TRANSLATION_SHARDS) {
    throw new HarnessError(
      "translation_too_many_shards",
      `Translation corpus would create more than ${MAX_TRANSLATION_SHARDS} shards`
    );
  }
  const finalShardChars = textChars <= chunkChars
    ? textChars
    : textChars - (shardCount - 1) * stepChars;
  const materialisedChars = (shardCount - 1) * chunkChars + finalShardChars;
  if (materialisedChars > MAX_TRANSLATION_MANIFEST_CHARS) {
    throw new HarnessError(
      "translation_manifest_too_large",
      `Translation overlap would materialise more than ${MAX_TRANSLATION_MANIFEST_CHARS} manifest characters`
    );
  }
}

function normaliseLanguage(value: unknown, label: string): string {
  const result = safeLanguage(value);
  if (!result) {
    throw new HarnessError("invalid_translation_language", `${label} must be a non-empty language code`);
  }
  if (!/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(result)) {
    throw new HarnessError("invalid_translation_language", `${label} must be a BCP-47-like language code`);
  }
  return result.replace(/_/g, "-");
}

function safeLanguage(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function projectName(value: unknown, sourceLang: string, targetLang: string): string {
  const project = stringOption(value);
  if (project) {
    return project;
  }
  return `translation-${sourceLang}-${targetLang}`;
}

function ratioBound(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new HarnessError("invalid_translation_ratio_bounds", `${label} must be a finite number between 0 and 100`);
  }
  return value;
}

function integerOption(value: unknown, fallback: number, label: string, min: number, max: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new HarnessError("invalid_translation_processor_option", `${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function positiveNumberOption(value: unknown, fallback: number, label: string, max: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max) {
    throw new HarnessError("invalid_translation_processor_option", `${label} must be a positive number no greater than ${max}`);
  }
  return value;
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function termsToMap(terms: readonly TranslationGlossaryTerm[]): Record<string, string> {
  return Object.fromEntries(terms.slice().sort(compareGlossaryTerms).map((term) => [term.source, term.target]));
}

function compareGlossaryTerms(left: TranslationGlossaryTerm, right: TranslationGlossaryTerm): number {
  return left.source.localeCompare(right.source) || left.target.localeCompare(right.target);
}

function firstString(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === "string") {
      return value[key] as string;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExistingRegularFile(value: string): boolean {
  try {
    return fs.statSync(assertSafeCorpusSourcePath(value)).isFile();
  } catch {
    return false;
  }
}

function looksLikeJson(value: string): boolean {
  return value.startsWith("{") || value.startsWith("[") || value.startsWith('"');
}

function characterLength(value: string): number {
  return Array.from(value).length;
}

function wordCount(value: string): number {
  return value.match(/\p{L}[\p{L}\p{M}\p{N}'’_-]*/gu)?.length ?? 0;
}

function isNontrivialSource(value: string): boolean {
  const letters = value.match(/\p{L}/gu)?.length ?? 0;
  return letters >= MIN_NONTRIVIAL_SOURCE_CHARS || wordCount(value) >= 2;
}

function normaliseComparable(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function languagesDifferForQa(sourceLang: string, targetLang: string): boolean {
  if (!sourceLang || !targetLang) {
    return false;
  }
  const sourceBase = sourceLang.toLocaleLowerCase().replace(/_/g, "-").split("-")[0];
  const targetBase = targetLang.toLocaleLowerCase().replace(/_/g, "-").split("-")[0];
  return sourceBase !== targetBase;
}

function placeholderCounts(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  const patterns = [
    /\{\{[^{}\r\n]+\}\}/g,
    /\$\{[^{}\r\n]+\}/g,
    /\[\[[^\]\r\n]+\]\]/g,
    /(?<!\{)\{[A-Za-z][A-Za-z0-9_.:-]*\}(?!\})/g,
    /%[A-Za-z][A-Za-z0-9_.:-]*%/g,
    /%(?:\d+\$)?[+#-]?(?:\d+)?(?:\.\d+)?[sdif](?![A-Za-z0-9_])/g
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const token = match[0];
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return counts;
}

function containsTerm(text: string, term: string): boolean {
  return text.toLocaleLowerCase().includes(term.toLocaleLowerCase());
}
