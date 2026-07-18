import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildBookCorpusManifest, buildLongformCorpusManifest } from "../src/corpus_authoring.js";
import { validateCorpusWorkload } from "../src/corpus_validation.js";

process.env.DEEPSEEK_HARNESS_INPUT_ROOT = os.tmpdir();

test("builds bounded book shards at Markdown and plain chapter boundaries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-authoring-"));
  const sourcePath = path.join(root, "book.txt");
  fs.writeFileSync(sourcePath, "# Chapter 1\nOne two three four five six.\n\nChapter 2: Return\nSeven eight nine ten eleven.");

  const manifest = buildBookCorpusManifest({
    project: "book-analysis",
    sourcePath,
    privacyLane: "local_only",
    chunkChars: 24,
    overlapChars: 4
  });

  assert.equal(manifest.workload_type, "book_reading");
  assert.equal(manifest.processor.type, "deepseek_batch");
  assert.equal(manifest.processor.transport, "fake");
  assert.equal(manifest.sources[0]?.type, "text");
  assertCorePromptTemplate(manifest.processor.prompt_template);
  assert.deepEqual([...new Set(manifest.shards.map((shard) => shard.bounds.chapter))], ["Chapter 1", "Chapter 2: Return"]);
  assert.deepEqual(validateCorpusWorkload({ workload_type: "book_reading", shards: manifest.shards }), []);
  for (const shard of manifest.shards) {
    assert.equal(shard.inline_text, sourceText(sourcePath).slice(Number(shard.bounds.start_char), Number(shard.bounds.end_char)));
    assert.equal(typeof shard.bounds.chapter, "string");
    assert.equal(shard.bounds.source_sha256, manifest.sources[0].sha256);
  }
});

test("builds one deterministic long-form shard per outline section", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-authoring-"));
  const outlinePath = path.join(root, "outline.json");
  fs.writeFileSync(
    outlinePath,
    JSON.stringify({
      title: "A Useful Guide",
      audience: "Readers",
      voice: "Warm and precise",
      sections: [
        { title: "Opening", brief: "Set the problem and promise." },
        { title: "Practice", brief: "Show a practical method." }
      ]
    })
  );

  const input = {
    project: "longform-guide",
    outlinePath,
    privacyLane: "local_only" as const,
    minimumWordsPerSection: 500,
    continuityRequired: true,
    citationPolicy: "Cite supplied sources and flag gaps."
  };
  const manifest = buildLongformCorpusManifest(input);
  const rebuilt = buildLongformCorpusManifest(input);

  assert.deepEqual(rebuilt, manifest);
  assert.equal(manifest.workload_type, "longform_generation");
  assert.equal(manifest.processor.type, "deepseek_batch");
  assert.equal(manifest.processor.transport, "fake");
  assert.equal(manifest.acceptance.minimum_words_per_section, 500);
  assert.equal(manifest.acceptance.continuity_required, true);
  assert.equal(manifest.acceptance.citation_policy, "Cite supplied sources and flag gaps.");
  assert.deepEqual(
    manifest.shards.map((shard) => [shard.bounds.section, shard.bounds.section_index]),
    [
      ["Opening", 1],
      ["Practice", 2]
    ]
  );
  assert.match(manifest.shards[0]?.inline_text ?? "", /Set the problem and promise/);
  assertCorePromptTemplate(manifest.processor.prompt_template);
});

test("enforces core prompt and system-prompt boundaries after authoring defaults are materialised", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-authoring-"));
  const sourcePath = path.join(root, "book.txt");
  fs.writeFileSync(sourcePath, "Chapter 1\nText");

  const exactPrompt = "p".repeat(CORE_PROMPT_MAX_CHARS - TEXT_PLACEHOLDER.length) + TEXT_PLACEHOLDER;
  const exactSystemPrompt = "s".repeat(CORE_PROMPT_MAX_CHARS);
  const exactManifest = buildBookCorpusManifest({
    project: "prompt-boundary",
    sourcePath,
    promptTemplate: exactPrompt,
    systemPrompt: exactSystemPrompt
  });
  assert.equal(exactManifest.processor.prompt_template.length, CORE_PROMPT_MAX_CHARS);
  assert.equal(exactManifest.processor.system_prompt?.length, CORE_PROMPT_MAX_CHARS);
  assertCorePromptTemplate(exactManifest.processor.prompt_template);

  assert.throws(
    () => buildBookCorpusManifest({
      project: "prompt-boundary",
      sourcePath,
      promptTemplate: `${exactPrompt}p`
    }),
    /Prompt template must be at most 65536 characters/
  );
  assert.throws(
    () => buildBookCorpusManifest({
      project: "prompt-boundary",
      sourcePath,
      systemPrompt: `${exactSystemPrompt}s`
    }),
    /systemPrompt must be at most 65536 characters/
  );

  const authoringSuffix = "\n\nSource text:\n{{text}}\n\nShard bounds:\n{{bounds}}";
  const promptBeforeDefaultConcatenation = "p".repeat(CORE_PROMPT_MAX_CHARS - authoringSuffix.length);
  const concatenated = buildBookCorpusManifest({
    project: "prompt-concatenation-boundary",
    sourcePath,
    promptTemplate: promptBeforeDefaultConcatenation
  });
  assert.equal(concatenated.processor.prompt_template.length, CORE_PROMPT_MAX_CHARS);
  assertCorePromptTemplate(concatenated.processor.prompt_template);
  assert.throws(
    () => buildBookCorpusManifest({
      project: "prompt-concatenation-boundary",
      sourcePath,
      promptTemplate: `${promptBeforeDefaultConcatenation}p`
    }),
    /Prompt template must be at most 65536 characters/
  );
});

test("rejects empty, malformed, duplicate, and hash-mismatched inputs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-authoring-"));
  const emptyBook = path.join(root, "empty.txt");
  fs.writeFileSync(emptyBook, " \n\t");
  assert.throws(
    () => buildBookCorpusManifest({ project: "bad", sourcePath: emptyBook, chunkChars: 10, overlapChars: 2 }),
    /must contain non-whitespace text/
  );

  const duplicateOutline = path.join(root, "duplicate.json");
  fs.writeFileSync(duplicateOutline, JSON.stringify({ title: "Bad", sections: [{ title: "One", brief: "A" }, { title: " one ", brief: "B" }] }));
  assert.throws(
    () => buildLongformCorpusManifest({ project: "bad", outlinePath: duplicateOutline }),
    /Duplicate long-form section title/
  );

  const goodBook = path.join(root, "good.txt");
  fs.writeFileSync(goodBook, "Chapter 1\nText");
  assert.throws(
    () => buildBookCorpusManifest({ project: "bad", sourcePath: goodBook, chunkChars: 10, overlapChars: 2, expectedSha256: "0".repeat(64) }),
    /does not match the file read from disk/
  );
  assert.throws(
    () => buildBookCorpusManifest({ project: "bad", sourcePath: path.join(root, "missing.txt"), chunkChars: 10, overlapChars: 2 }),
    /Could not read corpus source/
  );
});

test("rejects a whole-book plan before materialising more than 10,000 shards", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-authoring-"));
  const sourcePath = path.join(root, "book.txt");
  fs.writeFileSync(sourcePath, "x".repeat(20_001));

  assert.throws(
    () => buildBookCorpusManifest({
      project: "bounded-book",
      sourcePath,
      chunkChars: 1,
      overlapChars: 0
    }),
    /more than 10000 shards/
  );
});

function sourceText(sourcePath: string): string {
  return fs.readFileSync(sourcePath, "utf8");
}

const CORE_PROMPT_MAX_CHARS = 65_536;
const TEXT_PLACEHOLDER = "{{text}}";

function assertCorePromptTemplate(prompt: string): void {
  assert.ok(prompt.length <= CORE_PROMPT_MAX_CHARS);
  assert.equal((prompt.match(/\{\{text\}\}/g) ?? []).length, 1);
}
