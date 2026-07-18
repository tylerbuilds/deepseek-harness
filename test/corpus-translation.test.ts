import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildTranslationCorpusManifest,
  evaluateTranslationQa
} from "../src/corpus_translation.js";
import { validateCorpusWorkload } from "../src/corpus_validation.js";

process.env.DEEPSEEK_HARNESS_INPUT_ROOT = os.tmpdir();

test("builds a deterministic translation manifest with bounded, language-aware shards", () => {
  const input = {
    project: "translation-fixture",
    sourceText: "Hello {{name}}. Keep the phrase medical cannabis in every section.",
    sourceLang: "en",
    targetLang: "fr",
    glossary: { "medical cannabis": "cannabis médical" },
    chunkChars: 24,
    overlapChars: 3,
    transport: "dry-run" as const,
    minLengthRatio: 0.4,
    maxLengthRatio: 2.5
  };

  const manifest = buildTranslationCorpusManifest(input);
  const rebuilt = buildTranslationCorpusManifest(input);

  assert.deepEqual(rebuilt, manifest);
  assert.equal(manifest.schema_version, "deepseek-harness.corpus.v1");
  assert.equal(manifest.workload_type, "translation");
  assert.equal(manifest.processor.type, "deepseek_batch");
  assert.equal(manifest.processor.transport, "dry-run");
  assertCorePromptContract(manifest.processor.prompt_template, manifest.processor.system_prompt);
  assert.equal(manifest.sources.length, 1);
  assert.match(manifest.sources[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.ok(manifest.shards.length > 1);
  for (const shard of manifest.shards) {
    assert.equal(shard.source_lang, "en");
    assert.equal(shard.target_lang, "fr");
    assert.equal(shard.bounds.source_lang, "en");
    assert.equal(shard.bounds.target_lang, "fr");
    assert.ok(shard.inline_text.length <= input.chunkChars);
    assert.match(shard.id, /^[A-Za-z0-9_.:-]+$/);
    assert.match(shard.bounds.shard_sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(manifest.acceptance.translation.source_lang, "en");
  assert.equal(manifest.acceptance.translation.target_lang, "fr");
  assert.deepEqual(manifest.acceptance.translation.glossary, { "medical cannabis": "cannabis médical" });
  assert.match(manifest.acceptance.translation.glossary_sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(manifest.acceptance.translation.min_length_ratio, 0.4);
  assert.equal(manifest.acceptance.translation.max_length_ratio, 2.5);
  assert.equal(manifest.acceptance.translation.preserve_placeholders, true);
  assert.deepEqual(Object.keys(manifest.acceptance), ["translation", "language_pair_label"]);
  assert.deepEqual(Object.keys(manifest.acceptance.translation), [
    "source_lang",
    "target_lang",
    "glossary_sha256",
    "glossary",
    "min_length_ratio",
    "max_length_ratio",
    "preserve_placeholders"
  ]);
  const workloadContract = {
    workload_type: manifest.workload_type,
    processor: manifest.processor,
    sources: manifest.sources,
    shards: manifest.shards.map((shard) => ({ ...shard })),
    acceptance: manifest.acceptance
  };
  assert.deepEqual(validateCorpusWorkload(workloadContract), []);
});

test("enforces core prompt boundaries after translation instructions and custom text are concatenated", () => {
  const baseInput = {
    project: "translation-prompt-boundary",
    sourceText: "Hello {{name}}.",
    sourceLang: "en",
    targetLang: "fr"
  };
  const baseline = buildTranslationCorpusManifest(baseInput);
  const systemContractLength = baseline.processor.system_prompt.length;
  const customAtLimit = "x".repeat(CORE_PROMPT_MAX_CHARS - systemContractLength - 1);
  const exact = buildTranslationCorpusManifest({ ...baseInput, systemPrompt: customAtLimit });
  assert.equal(exact.processor.system_prompt.length, CORE_PROMPT_MAX_CHARS);
  assertCorePromptContract(exact.processor.prompt_template, exact.processor.system_prompt);

  assert.throws(
    () => buildTranslationCorpusManifest({
      ...baseInput,
      systemPrompt: `${customAtLimit}x`
    }),
    /Translation system prompt must be at most 65536 characters/
  );

  const oversizedGlossary = Object.fromEntries(
    Array.from({ length: 4 }, (_, index) => [
      `${"s".repeat(9_990)}${String(index).padStart(2, "0")}`,
      `${"t".repeat(9_990)}${String(index).padStart(2, "0")}`
    ])
  );
  assert.throws(
    () => buildTranslationCorpusManifest({ ...baseInput, glossary: oversizedGlossary }),
    /Translation (?:prompt template|system prompt) must be at most 65536 characters/
  );
});

test("reads UTF-8 source files and rejects malformed glossary JSON safely", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-translation-"));
  const sourcePath = path.join(root, "source.txt");
  const glossaryPath = path.join(root, "glossary.json");
  fs.writeFileSync(sourcePath, "Café {{customer}}", "utf8");
  fs.writeFileSync(glossaryPath, "{\"café\":", "utf8");

  assert.throws(
    () =>
      buildTranslationCorpusManifest({
        sourcePath,
        sourceLang: "fr",
        targetLang: "en",
        glossaryPath
      }),
    /Glossary must be valid JSON|Glossary file must contain valid JSON/
  );

  fs.writeFileSync(glossaryPath, JSON.stringify({ café: "coffee" }), "utf8");
  const manifest = buildTranslationCorpusManifest({
    sourcePath,
    sourceLang: "fr",
    targetLang: "en",
    glossaryPath,
    chunkChars: 100
  });
  assert.equal(manifest.sources[0]?.path, path.resolve(sourcePath));
  assert.deepEqual(manifest.acceptance.translation.glossary, { café: "coffee" });
});

test("rejects translation plans that would exceed the 10,000-shard manifest cap", () => {
  assert.throws(
    () => buildTranslationCorpusManifest({
      sourceText: "x".repeat(20_001),
      sourceLang: "en",
      targetLang: "fr",
      chunkChars: 1,
      overlapChars: 0
    }),
    /more than 10000 shards/
  );
});

test("blocks lost placeholders and required glossary translations", () => {
  const result = evaluateTranslationQa({
    sourceText: "Please greet {{name}} and mention medical cannabis.",
    outputText: "Veuillez saluer la personne.",
    sourceLang: "en",
    targetLang: "fr",
    glossary: { "medical cannabis": "cannabis médical" }
  });

  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("placeholders_lost"));
  assert.ok(result.blockers.includes("glossary_terms_missing"));
  assert.deepEqual(result.metrics.placeholders_missing, ["{{name}}"]);
  assert.deepEqual(result.metrics.glossary_terms_missing, [
    { source: "medical cannabis", target: "cannabis médical" }
  ]);
});

test("blocks empty output, unchanged nontrivial output, and extreme length ratios", () => {
  const empty = evaluateTranslationQa({
    sourceText: "Hello world",
    outputText: "",
    sourceLang: "en",
    targetLang: "fr"
  });
  assert.ok(empty.blockers.includes("empty_output"));

  const unchanged = evaluateTranslationQa({
    sourceText: "This is a substantial sentence.",
    outputText: "This is a substantial sentence.",
    sourceLang: "en",
    targetLang: "fr"
  });
  assert.ok(unchanged.blockers.includes("unchanged_nontrivial_output"));

  const extreme = evaluateTranslationQa({
    sourceText: "A reasonably long source sentence.",
    outputText: "x".repeat(400),
    sourceLang: "en",
    targetLang: "fr",
    minLengthRatio: 0.5,
    maxLengthRatio: 2
  });
  assert.ok(extreme.blockers.includes("length_ratio_out_of_bounds"));
});

test("passes QA when language, glossary, placeholders, and ratio checks are satisfied", () => {
  const result = evaluateTranslationQa({
    sourceText: "Hello {{name}}, medical cannabis is listed.",
    outputText: "Bonjour {{name}}, cannabis médical est répertorié.",
    sourceLang: "en",
    targetLang: "fr",
    glossary: { "medical cannabis": "cannabis médical" },
    minLengthRatio: 0.4,
    maxLengthRatio: 2.5
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.metrics.placeholders_missing.length, 0);
  assert.equal(result.metrics.glossary_terms_missing.length, 0);
  assert.equal(result.metrics.length_ratio_checked, true);
  assert.equal("sourceLength" in result.metrics, false);
});

test("does not flag tiny unchanged text or same-language output", () => {
  const tiny = evaluateTranslationQa({
    sourceText: "OK",
    outputText: "OK",
    sourceLang: "en",
    targetLang: "fr"
  });
  assert.equal(tiny.ok, true);

  const sameLanguage = evaluateTranslationQa({
    sourceText: "This is a substantial sentence.",
    outputText: "This is a substantial sentence.",
    sourceLang: "en",
    targetLang: "en-GB"
  });
  assert.equal(sameLanguage.ok, true);
});

const CORE_PROMPT_MAX_CHARS = 65_536;

function assertCorePromptContract(promptTemplate: string, systemPrompt: string): void {
  assert.ok(promptTemplate.length <= CORE_PROMPT_MAX_CHARS);
  assert.equal((promptTemplate.match(/\{\{text\}\}/g) ?? []).length, 1);
  assert.ok(systemPrompt.length > 0);
  assert.ok(systemPrompt.length <= CORE_PROMPT_MAX_CHARS);
}
