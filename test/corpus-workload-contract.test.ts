import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  corpusPlan,
  corpusReconcile,
  corpusStart,
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

function prepareLegacyJob(
  scenario: InvalidWorkloadScenario,
  jobId: string,
  artifactDir: string
): void {
  const invalidManifest = scenario.buildManifest(jobId, artifactDir);
  corpusStart({ ...invalidManifest, workload_type: "mixed" });
  fs.writeFileSync(path.join(artifactDir, "manifest.json"), JSON.stringify(invalidManifest, null, 2));
}

function withArtifactRoot(run: (artifactRoot: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-workload-contract-"));
  const artifactRoot = path.join(root, "artifacts");
  const previousArtifactRoot = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = artifactRoot;
  try {
    run(artifactRoot);
  } finally {
    if (previousArtifactRoot === undefined) {
      delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
    } else {
      process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = previousArtifactRoot;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
