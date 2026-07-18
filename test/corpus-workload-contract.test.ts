import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  corpusPlan,
  corpusReconcile,
  corpusStart,
  corpusStartAsync,
  corpusValidate
} from "../src/corpus.js";

type InvalidWorkloadScenario = {
  readonly name: string;
  readonly expectedBlocker: string;
  readonly buildManifest: (jobId: string, artifactDir: string) => Record<string, unknown>;
};

const invalidWorkloadScenarios = [
  {
    name: "translation copy_text manifest",
    expectedBlocker: "translation_processor_incompatible:copy_text",
    buildManifest: (jobId: string, artifactDir: string) => ({
      schema_version: "deepseek-harness.corpus.v1",
      job_id: jobId,
      project: "invalid-translation-copy",
      workload_type: "translation",
      privacy_lane: "local_only",
      artifact_dir: artifactDir,
      processor: { type: "copy_text" },
      sources: [{ id: "source", type: "text" }],
      shards: [{ id: "chunk-1", source_id: "source", inline_text: "Bonjour" }]
    })
  },
  {
    name: "media copy_text manifest without catalogue provenance",
    expectedBlocker: "media_catalogue_missing_duration:media-1",
    buildManifest: (jobId: string, artifactDir: string) => ({
      schema_version: "deepseek-harness.corpus.v1",
      job_id: jobId,
      project: "invalid-media-copy",
      workload_type: "media_catalogue",
      privacy_lane: "local_only",
      artifact_dir: artifactDir,
      processor: { type: "copy_text" },
      sources: [{ id: "media", type: "audio" }],
      shards: [{ id: "media-1", source_id: "media", inline_text: "{}" }]
    })
  }
] as const satisfies readonly InvalidWorkloadScenario[];

for (const scenario of invalidWorkloadScenarios) {
  test(`plan rejects ${scenario.name}`, () => {
    withArtifactRoot((artifactRoot) => {
      const artifactDir = path.join(artifactRoot, "corpus", `plan-${scenario.name.replaceAll(" ", "-")}`);

      const planned = corpusPlan(scenario.buildManifest("contract-plan", artifactDir));

      const blockers = planned.blockers;
      assert.ok(Array.isArray(blockers));
      assert.equal(blockers.includes(scenario.expectedBlocker), true);
    });
  });

  test(`start rejects ${scenario.name} before reserving state`, () => {
    withArtifactRoot((artifactRoot) => {
      const artifactDir = path.join(artifactRoot, "corpus", `start-${scenario.name.replaceAll(" ", "-")}`);

      assert.throws(
        () => corpusStart(scenario.buildManifest("contract-start", artifactDir)),
        /Corpus workload contract failed/
      );

      assert.equal(fs.existsSync(path.join(artifactDir, "manifest.json")), false);
    });
  });

  test(`validate rejects legacy ${scenario.name}`, () => {
    withArtifactRoot((artifactRoot) => {
      const jobId = `contract-validate-${scenario.name.replaceAll(" ", "-")}`;
      const artifactDir = path.join(artifactRoot, "corpus", jobId);
      prepareLegacyJob(scenario, jobId, artifactDir);

      const validation = corpusValidate(jobId, { artifactDir });

      const blockers = validation.blockers;
      assert.ok(Array.isArray(blockers));
      assert.equal(blockers.includes(scenario.expectedBlocker), true);
    });
  });

  test(`reconcile rejects legacy ${scenario.name}`, () => {
    withArtifactRoot((artifactRoot) => {
      const jobId = `contract-reconcile-${scenario.name.replaceAll(" ", "-")}`;
      const artifactDir = path.join(artifactRoot, "corpus", jobId);
      prepareLegacyJob(scenario, jobId, artifactDir);

      assert.throws(
        () => corpusReconcile(jobId, { artifactDir }),
        /Corpus job cannot be reconciled until validation passes/
      );
    });
  });
}

test("translation contract requires language and hash provenance on every shard", async () => {
  await withArtifactRoot(async (artifactRoot) => {
    const digest = "a".repeat(64);
    const manifest = {
      schema_version: "deepseek-harness.corpus.v1",
      job_id: "translation-missing-provenance",
      project: "invalid-translation-provenance",
      workload_type: "translation",
      privacy_lane: "local_only",
      artifact_dir: path.join(artifactRoot, "corpus", "translation-missing-provenance"),
      processor: {
        type: "deepseek_batch",
        transport: "fake",
        prompt_template: "Translate {{text}}"
      },
      sources: [{ id: "source", type: "text", sha256: digest }],
      shards: [{ id: "chunk-1", source_id: "source", inline_text: "Bonjour" }],
      acceptance: {
        translation: { source_lang: "fr", target_lang: "en", preserve_placeholders: true }
      }
    };

    const planned = corpusPlan(manifest);
    const blockers = planned.blockers as string[];
    assert.equal(blockers.includes("translation_missing_source_lang:chunk-1"), true);
    assert.equal(blockers.includes("translation_missing_target_lang:chunk-1"), true);
    assert.equal(blockers.includes("translation_missing_source_sha256:chunk-1"), true);
    assert.equal(blockers.includes("translation_missing_shard_sha256:chunk-1"), true);
    await assert.rejects(() => corpusStartAsync(manifest), /Corpus workload contract failed/);
  });
});

function prepareLegacyJob(
  scenario: InvalidWorkloadScenario,
  jobId: string,
  artifactDir: string
): void {
  const invalidManifest = scenario.buildManifest(jobId, artifactDir);
  corpusStart({ ...invalidManifest, workload_type: "mixed" });
  fs.writeFileSync(path.join(artifactDir, "manifest.json"), JSON.stringify(invalidManifest, null, 2));
}

async function withArtifactRoot(run: (artifactRoot: string) => void | Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-workload-contract-"));
  const artifactRoot = path.join(root, "artifacts");
  const previousArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = artifactRoot;
  try {
    await run(artifactRoot);
  } finally {
    if (previousArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = previousArtifactRoot;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
