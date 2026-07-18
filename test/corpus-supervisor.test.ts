import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { corpusStart } from "../src/corpus.js";
import { corpusSupervisorAsync } from "../src/corpus_supervisor.js";

function setArtifactRoot(root: string): { restore: () => void } {
  const previous = process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
  process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = root;
  return {
    restore: () => {
      if (previous === undefined) {
        delete process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR;
      } else {
        process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR = previous;
      }
    }
  };
}

function createRunningJob(artifactRoot: string, jobId: string): string {
  const artifactDir = path.join(artifactRoot, "corpus", jobId);
  corpusStart({
    schema_version: "deepseek-harness.corpus.v1",
    job_id: jobId,
    project: `supervisor-${jobId}`,
    workload_type: "dataset_transform",
    privacy_lane: "local_only",
    artifact_dir: artifactDir,
    sources: [{ id: "source", type: "dataset" }],
    shards: [{ id: "shard", source_id: "source", inline_text: jobId }]
  });
  const ledgerPath = path.join(artifactDir, "ledger.json");
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as {
    status: string;
    shards: Array<Record<string, unknown>>;
    updated_at: string;
  };
  ledger.status = "running";
  ledger.updated_at = new Date().toISOString();
  for (const shard of ledger.shards) {
    shard.status = "pending";
    shard.attempts = 0;
    shard.output_path = null;
    shard.output_sha256 = null;
    shard.proof_path = null;
    shard.finished_at = null;
    shard.committed_at = null;
  }
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
  return artifactDir;
}

function createBrokenJob(artifactRoot: string, jobId: string): string {
  const artifactDir = path.join(artifactRoot, "corpus", jobId);
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactDir, "ledger.json"),
    JSON.stringify({
      schema_version: "deepseek-harness.corpus-ledger.v1",
      job_id: jobId,
      status: "running",
      artifact_dir: artifactDir
    })
  );
  return artifactDir;
}

test("discovers running jobs in deterministic order and honours one bounded cycle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-supervisor-"));
  const artifactRoot = path.join(root, "artifacts");
  const env = setArtifactRoot(artifactRoot);

  try {
    createRunningJob(artifactRoot, "job-b");
    createRunningJob(artifactRoot, "job-a");
    const report = await corpusSupervisorAsync({
      corpusRoot: path.join(artifactRoot, "corpus"),
      once: true,
      maxJobsPerCycle: 1,
      maxIterationsPerJob: 1
    });

    assert.equal(report.ok, true);
    assert.equal(report.cycles.length, 1);
    assert.deepEqual(report.cycles[0]?.discovered_job_ids, ["job-a", "job-b"]);
    assert.deepEqual(report.cycles[0]?.selected_job_ids, ["job-a"]);
    assert.equal(report.cycles[0]?.jobs[0]?.job_id, "job-a");
    assert.equal(report.cycles[0]?.jobs[0]?.ok, true);
    assert.equal(fs.existsSync(path.join(artifactRoot, "corpus", "supervisor.lock")), false);

    const remaining = JSON.parse(
      fs.readFileSync(path.join(artifactRoot, "corpus", "job-b", "ledger.json"), "utf8")
    ) as { status: string };
    assert.equal(remaining.status, "running");
  } finally {
    env.restore();
  }
});

test("rejects a duplicate supervisor lock and leaves the lock for its owner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-supervisor-"));
  const artifactRoot = path.join(root, "artifacts");
  const corpusRoot = path.join(artifactRoot, "corpus");
  const env = setArtifactRoot(artifactRoot);
  fs.mkdirSync(corpusRoot, { recursive: true });
  const lockPath = path.join(corpusRoot, "supervisor.lock");
  fs.writeFileSync(lockPath, "held by another supervisor");

  try {
    await assert.rejects(
      () => corpusSupervisorAsync({ corpusRoot }),
      /Corpus supervisor lock already exists/
    );
    assert.equal(fs.readFileSync(lockPath, "utf8"), "held by another supervisor");
  } finally {
    env.restore();
  }
});

test("reclaims a well-formed supervisor lock owned by a dead process", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-supervisor-"));
  const artifactRoot = path.join(root, "artifacts");
  const corpusRoot = path.join(artifactRoot, "corpus");
  const env = setArtifactRoot(artifactRoot);
  fs.mkdirSync(corpusRoot, { recursive: true });
  const lockPath = path.join(corpusRoot, "supervisor.lock");
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ schema_version: "deepseek-harness.corpus-supervisor-lock.v1", pid: 2_147_483_647 })
  );

  try {
    const report = await corpusSupervisorAsync({ corpusRoot, once: true });
    assert.equal(report.ok, true);
    assert.equal(report.cycles.length, 1);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    env.restore();
  }
});

test("runs exactly the requested bounded number of cycles and isolates job errors", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-supervisor-"));
  const artifactRoot = path.join(root, "artifacts");
  const env = setArtifactRoot(artifactRoot);

  try {
    const runningDir = createRunningJob(artifactRoot, "job-running");
    const brokenDir = path.join(artifactRoot, "corpus", "job-broken");
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(
      path.join(brokenDir, "ledger.json"),
      JSON.stringify({
        schema_version: "deepseek-harness.corpus-ledger.v1",
        job_id: "job-broken",
        status: "running",
        artifact_dir: brokenDir
      })
    );

    const report = await corpusSupervisorAsync({
      corpusRoot: path.join(artifactRoot, "corpus"),
      once: false,
      maxCycles: 2,
      maxIterationsPerJob: 1
    });

    assert.equal(report.cycles.length, 2);
    assert.equal(report.supervisor.cycles, 2);
    assert.equal(report.supervisor.bounded, true);
    assert.equal(report.ok, false);
    assert.equal(report.cycles[0]?.jobs.some((job) => job.job_id === "job-broken" && !job.ok), true);
    assert.equal(report.cycles[0]?.jobs.some((job) => job.job_id === "job-running" && job.ok), true);
    assert.equal(report.cycles[1]?.jobs.length, 1);
    assert.equal(report.cycles[1]?.jobs[0]?.job_id, "job-broken");
    assert.equal(fs.existsSync(path.join(path.dirname(runningDir), "supervisor.lock")), false);
  } finally {
    env.restore();
  }
});

test("persists a fair cursor so broken prefix jobs cannot starve healthy suffix jobs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-supervisor-"));
  const artifactRoot = path.join(root, "artifacts");
  const corpusRoot = path.join(artifactRoot, "corpus");
  const env = setArtifactRoot(artifactRoot);

  try {
    createBrokenJob(artifactRoot, "job-00-broken");
    createBrokenJob(artifactRoot, "job-01-broken");
    createRunningJob(artifactRoot, "job-99-healthy");

    const selectedAcrossRuns: string[][] = [];
    const run = async () => {
      const report = await corpusSupervisorAsync({
        corpusRoot,
        once: true,
        maxJobsPerCycle: 1,
        maxIterationsPerJob: 1
      });
      selectedAcrossRuns.push(report.cycles[0]?.selected_job_ids ?? []);
      return report;
    };

    const first = await run();
    const second = await run();
    const third = await run();

    assert.deepEqual(selectedAcrossRuns, [["job-00-broken"], ["job-01-broken"], ["job-99-healthy"]]);
    assert.equal(first.cycles[0]?.jobs[0]?.ok, false);
    assert.equal(second.cycles[0]?.jobs[0]?.ok, false);
    assert.equal(third.cycles[0]?.jobs[0]?.ok, true);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(corpusRoot, "supervisor-state.json"), "utf8")).last_selected_job_id,
      "job-99-healthy"
    );
  } finally {
    env.restore();
  }
});

test("confines an explicit corpus root to the configured artefact root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-supervisor-"));
  const artifactRoot = path.join(root, "artifacts");
  const env = setArtifactRoot(artifactRoot);

  try {
    await assert.rejects(
      () => corpusSupervisorAsync({ corpusRoot: path.join(root, "outside") }),
      /Corpus supervisor root must stay under DEEPSEEK_HARNESS_ARTIFACT_DIR/
    );
    assert.equal(fs.existsSync(path.join(root, "outside")), false);
  } finally {
    env.restore();
  }
});

test("defers live DeepSeek ledgers without mutating them by default", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-supervisor-"));
  const artifactRoot = path.join(root, "artifacts");
  const env = setArtifactRoot(artifactRoot);

  try {
    const artifactDir = createRunningJob(artifactRoot, "job-live");
    const ledgerPath = path.join(artifactDir, "ledger.json");
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as Record<string, unknown>;
    ledger.processor = { type: "deepseek_batch", transport: "deepseek" };
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
    const before = fs.readFileSync(ledgerPath, "utf8");

    const report = await corpusSupervisorAsync({ corpusRoot: path.join(artifactRoot, "corpus") });

    assert.equal(report.ok, true);
    assert.deepEqual(report.cycles[0]?.deferred_job_ids, ["job-live"]);
    assert.deepEqual(report.cycles[0]?.selected_job_ids, []);
    assert.deepEqual(report.cycles[0]?.jobs, []);
    assert.equal(fs.readFileSync(ledgerPath, "utf8"), before);
  } finally {
    env.restore();
  }
});

test("rejects attempts to grant persistent live authority to the supervisor", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-supervisor-"));
  const artifactRoot = path.join(root, "artifacts");
  const env = setArtifactRoot(artifactRoot);

  try {
    await assert.rejects(
      () => corpusSupervisorAsync({ corpusRoot: path.join(artifactRoot, "corpus"), allowLive: true }),
      /signed authority is never persisted/
    );
  } finally {
    env.restore();
  }
});

test("retains only the latest ten cycle reports while preserving aggregate cycle count", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-supervisor-"));
  const artifactRoot = path.join(root, "artifacts");
  const env = setArtifactRoot(artifactRoot);

  try {
    const report = await corpusSupervisorAsync({
      corpusRoot: path.join(artifactRoot, "corpus"),
      maxCycles: 12,
      intervalMs: 0
    });
    assert.equal(report.ok, true);
    assert.equal(report.supervisor.cycles, 12);
    assert.equal(report.cycles.length, 10);
    assert.equal(report.cycles[0]?.cycle, 3);
    assert.equal(report.cycles[9]?.cycle, 12);
  } finally {
    env.restore();
  }
});
