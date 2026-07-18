import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { buildMediaCorpusManifest } from "../src/corpus_media.js";
import { validateCorpusWorkload } from "../src/corpus_validation.js";

process.env.DEEPSEEK_HARNESS_INPUT_ROOT = os.tmpdir();

const TEST_COMMAND_TIMEOUT_MS = 30_000;
const TEST_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const mediaToolsAvailable = commandAvailable("ffmpeg") && commandAvailable("ffprobe");
const mediaToolTestOptions = mediaToolsAvailable ? undefined : { skip: "ffmpeg and ffprobe are required for media fixture tests" };

test("builds deterministic sorted media catalogue shards from ffprobe JSON", mediaToolTestOptions, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-media-"));
  try {
    createAudioFixture(path.join(root, "z-last.wav"), 440);
    createAudioFixture(path.join(root, "a-first.wav"), 880);

    const manifest = buildMediaCorpusManifest({
      project: "unit-media-catalogue",
      sourcePath: root,
      privacyLane: "local_only"
    });
    const rebuilt = buildMediaCorpusManifest({
      project: "unit-media-catalogue",
      sourcePath: root,
      privacyLane: "local_only"
    });

    assert.deepEqual(rebuilt, manifest);
    assert.equal(manifest.schema_version, "deepseek-harness.corpus.v1");
    assert.equal(manifest.workload_type, "media_catalogue");
    assert.deepEqual(
      manifest.shards.map((shard) => shard.bounds.relative_path),
      ["a-first.wav", "z-last.wav"]
    );
    assert.equal(manifest.processor.type, "copy_text");
    assert.equal(manifest.sources.length, 2);
    assert.equal(manifest.shards.length, 2);
    assert.deepEqual(
      manifest.sources.map((source) => source.path),
      [fs.realpathSync(path.join(root, "a-first.wav")), fs.realpathSync(path.join(root, "z-last.wav"))]
    );
    const workloadContract = {
      workload_type: manifest.workload_type,
      processor: manifest.processor,
      sources: manifest.sources,
      shards: manifest.shards
    };
    assert.deepEqual(validateCorpusWorkload(workloadContract), []);

    for (const [index, shard] of manifest.shards.entries()) {
      const sidecar = JSON.parse(shard.inline_text) as {
        duration_seconds: number;
        sha256: string;
        format: string;
        container: string;
        size_bytes: number;
        streams: unknown[];
        relative_path: string;
      };
      const source = manifest.sources[index];
      assert.equal(source?.type, "audio");
      assert.ok(source?.path && fs.statSync(source.path).isFile());
      assert.match(source?.sha256 ?? "", /^[a-f0-9]{64}$/);
      assert.match(sidecar.sha256, /^[a-f0-9]{64}$/);
      assert.equal(sidecar.sha256, source?.sha256);
      assert.equal(sidecar.relative_path, shard.bounds.relative_path);
      assert.equal(sidecar.size_bytes, shard.bounds.size_bytes);
      assert.equal(sidecar.size_bytes, shard.bounds.size);
      assert.equal(typeof sidecar.duration_seconds, "number");
      assert.ok(sidecar.duration_seconds > 0);
      assert.equal(typeof sidecar.format, "string");
      assert.equal(typeof sidecar.container, "string");
      assert.ok(Array.isArray(sidecar.streams));
      assert.equal(shard.bounds.duration_seconds, sidecar.duration_seconds);
      assert.equal(shard.bounds.sha256, sidecar.sha256);
      assert.equal(shard.bounds.sidecar_sha256, sha256Text(shard.inline_text));
      assert.equal(shard.inline_text.includes(path.resolve(root)), false);
      assert.equal(shard.bounds.streams, JSON.stringify(sidecar.streams));
      assert.equal(source?.sha256, sha256File(source.path));
    }

    const driftSource = manifest.sources.find((source) => source.path.endsWith("a-first.wav"));
    assert.ok(driftSource);
    fs.appendFileSync(driftSource.path, Buffer.from("post-ingest drift"));
    assert.notEqual(sha256File(driftSource.path), driftSource.sha256);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("supports recursive media directory enumeration", mediaToolTestOptions, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-media-"));
  try {
    const nested = path.join(root, "nested");
    fs.mkdirSync(nested);
    createAudioFixture(path.join(root, "top.wav"), 440);
    createAudioFixture(path.join(nested, "inside.wav"), 660);

    const shallow = buildMediaCorpusManifest({
      project: "unit-media-recursion",
      sourcePath: root,
      privacyLane: "local_only"
    });
    const deep = buildMediaCorpusManifest({
      project: "unit-media-recursion",
      sourcePath: root,
      privacyLane: "local_only",
      recursive: true
    });

    assert.deepEqual(shallow.shards.map((shard) => shard.bounds.relative_path), ["top.wav"]);
    assert.deepEqual(deep.shards.map((shard) => shard.bounds.relative_path), ["nested/inside.wav", "top.wav"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects media fan-out configuration above the corpus shard cap", () => {
  assert.throws(
    () =>
      buildMediaCorpusManifest({
        project: "unit-media-shard-cap",
        sourcePath: "/unused",
        privacyLane: "local_only",
        maxFiles: 10_001
      }),
    /no greater than 10000/
  );
});

test("rejects symlinked media entries", mediaToolTestOptions, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-media-"));
  try {
    const original = path.join(root, "original.wav");
    createAudioFixture(original, 440);
    fs.symlinkSync(original, path.join(root, "linked.wav"));

    assert.throws(
      () =>
        buildMediaCorpusManifest({
          project: "unit-media-symlink",
          sourcePath: root,
          privacyLane: "local_only"
        }),
      /symlink/i
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects hard-linked media entries outside the configured input root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-media-hard-link-"));
  const inputRoot = path.join(root, "input");
  const outsideRoot = path.join(root, "outside");
  const previousInputRoot = process.env.DEEPSEEK_HARNESS_INPUT_ROOT;
  try {
    fs.mkdirSync(inputRoot);
    fs.mkdirSync(outsideRoot);
    const outsideMedia = path.join(outsideRoot, "outside.wav");
    fs.writeFileSync(outsideMedia, "outside media content");
    fs.linkSync(outsideMedia, path.join(inputRoot, "linked.wav"));
    process.env.DEEPSEEK_HARNESS_INPUT_ROOT = inputRoot;

    assert.throws(
      () => buildMediaCorpusManifest({
        project: "unit-media-hard-link",
        sourcePath: inputRoot,
        privacyLane: "local_only"
      }),
      /hard-linked regular file/
    );
  } finally {
    if (previousInputRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_INPUT_ROOT;
    } else {
      process.env.DEEPSEEK_HARNESS_INPUT_ROOT = previousInputRoot;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when regular files exceed maxFiles", mediaToolTestOptions, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-media-"));
  try {
    createAudioFixture(path.join(root, "one.wav"), 440);
    createAudioFixture(path.join(root, "two.wav"), 660);

    assert.throws(
      () =>
        buildMediaCorpusManifest({
          project: "unit-media-cap",
          sourcePath: root,
          privacyLane: "local_only",
          maxFiles: 1
        }),
      /maxFiles cap/i
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createAudioFixture(filePath: string, frequency: number): void {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:sample_rate=8000:duration=0.1`,
      "-c:a",
      "pcm_s16le",
      filePath
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
  assert.equal(result.status, 0, result.stderr?.toString() ?? "ffmpeg fixture generation failed");
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

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}
