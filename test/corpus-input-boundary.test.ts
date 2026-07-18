import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildBookCorpusManifest, buildLongformCorpusManifest } from "../src/corpus_authoring.js";
import { buildMediaCorpusManifest } from "../src/corpus_media.js";
import { buildOcrCorpusManifest } from "../src/corpus_ocr.js";
import { buildTranslationCorpusManifest } from "../src/corpus_translation.js";
import { HarnessError } from "../src/errors.js";
import { corpusPlan } from "../src/corpus.js";
import { exportHarnessState, mcpConfig } from "../src/runner.js";

test("uses the configured input root for legitimate relative book and longform inputs", () => {
  const inputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-input-root-"));
  try {
    fs.writeFileSync(path.join(inputRoot, "book.txt"), "Chapter 1\nA bounded local fixture.");
    fs.writeFileSync(path.join(inputRoot, "outline.json"), JSON.stringify({
      title: "Local outline",
      sections: [{ title: "Opening", brief: "Open clearly." }]
    }));

    withInputRoot(inputRoot, () => {
      const book = buildBookCorpusManifest({ project: "book-safe", sourcePath: "book.txt" });
      const longform = buildLongformCorpusManifest({ project: "longform-safe", outlinePath: "outline.json" });
      assert.equal(book.sources[0].path, fs.realpathSync(path.join(inputRoot, "book.txt")));
      assert.equal(longform.sources[0].path, fs.realpathSync(path.join(inputRoot, "outline.json")));
    });
  } finally {
    fs.rmSync(inputRoot, { recursive: true, force: true });
  }
});

test("blocks lexical and realpath escapes across every file-reading ingest adapter", () => {
  const inputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-input-root-"));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-outside-root-"));
  try {
    const bookPath = path.join(outsideRoot, "book.txt");
    const outlinePath = path.join(outsideRoot, "outline.json");
    const translationPath = path.join(outsideRoot, "translation.txt");
    const glossaryPath = path.join(outsideRoot, "glossary.json");
    const mediaPath = path.join(outsideRoot, "media.wav");
    const ocrPath = path.join(outsideRoot, "scan.png");
    fs.writeFileSync(bookPath, "Chapter 1\nOutside text");
    fs.writeFileSync(outlinePath, JSON.stringify({ title: "Outside", sections: [{ title: "One", brief: "No." }] }));
    fs.writeFileSync(translationPath, "Outside translation source");
    fs.writeFileSync(glossaryPath, JSON.stringify({ source: "target" }));
    fs.writeFileSync(mediaPath, "outside media");
    fs.writeFileSync(ocrPath, "outside image");
    fs.writeFileSync(path.join(inputRoot, "translation.txt"), "Inside translation source");
    fs.writeFileSync(path.join(inputRoot, "inside-book.txt"), "Inside symlink target");
    fs.symlinkSync(bookPath, path.join(inputRoot, "book-link.txt"));
    fs.symlinkSync(path.join(inputRoot, "inside-book.txt"), path.join(inputRoot, "inside-book-link.txt"));
    fs.linkSync(bookPath, path.join(inputRoot, "book-hard-link.txt"));

    withInputRoot(inputRoot, () => {
      assertHarnessCode(() => buildBookCorpusManifest({ project: "blocked-book", sourcePath: bookPath }), "corpus_input_path_blocked");
      assertHarnessCode(() => buildLongformCorpusManifest({ project: "blocked-longform", outlinePath }), "corpus_input_path_blocked");
      assertHarnessCode(() => buildTranslationCorpusManifest({ sourcePath: translationPath, sourceLang: "en", targetLang: "fr" }), "corpus_input_path_blocked");
      assertHarnessCode(() => buildTranslationCorpusManifest({ sourcePath: "translation.txt", glossaryPath, sourceLang: "en", targetLang: "fr" }), "corpus_input_path_blocked");
      assertHarnessCode(() => buildMediaCorpusManifest({ project: "blocked-media", sourcePath: mediaPath, privacyLane: "local_only" }), "corpus_input_path_blocked");
      assertHarnessCode(() => buildOcrCorpusManifest({ project: "blocked-ocr", sourcePath: ocrPath }), "corpus_input_path_blocked");
      assertHarnessCode(() => buildBookCorpusManifest({ project: "blocked-symlink", sourcePath: "book-link.txt" }), "corpus_input_path_blocked");
      assertHarnessCode(() => buildBookCorpusManifest({ project: "blocked-inside-symlink", sourcePath: "inside-book-link.txt" }), "corpus_input_path_blocked");
      assertHarnessCode(() => buildBookCorpusManifest({ project: "blocked-hard-link", sourcePath: "book-hard-link.txt" }), "corpus_input_path_blocked");
      assertHarnessCode(
        () => buildBookCorpusManifest({ project: "blocked-lexical", sourcePath: path.join("..", path.basename(outsideRoot), "book.txt") }),
        "corpus_input_path_blocked"
      );
    });
  } finally {
    fs.rmSync(inputRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test("rejects dangling output symlinks and resolves documented artifact-relative output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-output-root-"));
  try {
    const artifactRoot = path.join(root, "configured-artifacts");
    fs.mkdirSync(artifactRoot);
    const danglingOutput = path.join(artifactRoot, "dangling.json");
    fs.symlinkSync(path.join(root, "missing", "outside.json"), danglingOutput);

    assertHarnessCode(
      () => exportHarnessState({ stateDir: path.join(root, "state"), artifactRoot }, { output: danglingOutput }),
      "artifact_output_path_blocked"
    );

    const exported = exportHarnessState(
      { stateDir: path.join(root, "state"), artifactRoot },
      { output: "artifacts/state.json" }
    ) as { path: string };
    assert.equal(exported.path, path.join(artifactRoot, "state.json"));
    assert.equal(fs.existsSync(exported.path), true);

    const config = mcpConfig({ inputRoot: root }) as {
      mcpServers: { "deepseek-harness": { env: Record<string, string> } };
    };
    assert.equal(config.mcpServers["deepseek-harness"].env.DEEPSEEK_HARNESS_INPUT_ROOT, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("confines direct corpus manifests before an MCP plan can inspect a source", () => {
  const inputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-input-root-"));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-outside-root-"));
  const sourcePath = path.join(outsideRoot, "outside.txt");
  fs.writeFileSync(sourcePath, "not an MCP-readable source");
  try {
    withInputRoot(inputRoot, () => {
      assertHarnessCode(
        () => corpusPlan({
          schema_version: "deepseek-harness.corpus.v1",
          project: "blocked-direct-manifest",
          workload_type: "mixed",
          privacy_lane: "local_only",
          sources: [{ id: "source", path: sourcePath, type: "text", sha256: "0".repeat(64) }],
          shards: [{ id: "shard", source_id: "source", input_path: sourcePath }]
        }),
        "corpus_input_path_blocked"
      );
    });
  } finally {
    fs.rmSync(inputRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test("rejects a configured input root that resolves to the filesystem root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-input-root-"));
  const rootLink = path.join(root, "filesystem-root");
  fs.symlinkSync(path.parse(root).root, rootLink);
  try {
    withInputRoot(rootLink, () => {
      assertHarnessCode(
        () => buildBookCorpusManifest({ project: "blocked-root-link", sourcePath: "README.md" }),
        "corpus_input_root_invalid"
      );
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function withInputRoot<T>(inputRoot: string, run: () => T): T {
  const previous = process.env.DEEPSEEK_HARNESS_INPUT_ROOT;
  process.env.DEEPSEEK_HARNESS_INPUT_ROOT = inputRoot;
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.DEEPSEEK_HARNESS_INPUT_ROOT;
    } else {
      process.env.DEEPSEEK_HARNESS_INPUT_ROOT = previous;
    }
  }
}

function assertHarnessCode(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => error instanceof HarnessError && error.code === code);
}
