import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const corpusJobStatusSchema = z.enum(["running", "completed", "failed", "cancelled"]);
const corpusLedgerSchema = z.object({
  job_id: z.string().min(1),
  project: z.string().min(1),
  status: corpusJobStatusSchema,
  updated_at: z.string().datetime(),
  shards: z.array(z.object({ status: z.string() })),
});

export type CorpusJob = {
  readonly jobId: string;
  readonly project: string;
  readonly status: z.infer<typeof corpusJobStatusSchema>;
  readonly updatedAt: string;
  readonly completedShards: number;
  readonly totalShards: number;
};

export function loadCorpusJobs(artifactRoot: string, limit = 5): readonly CorpusJob[] {
  const corpusRoot = path.join(artifactRoot, "corpus");
  if (!fs.existsSync(corpusRoot)) {
    return [];
  }

  return fs.readdirSync(corpusRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readCorpusJob(path.join(corpusRoot, entry.name, "ledger.json")))
    .filter((job): job is CorpusJob => job !== null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, Math.max(0, limit));
}

export function formatCorpusJob(job: CorpusJob): string {
  return `${job.jobId} ${job.status} ${job.completedShards}/${job.totalShards}`;
}

function readCorpusJob(ledgerPath: string): CorpusJob | null {
  try {
    const parsedJson: unknown = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    const result = corpusLedgerSchema.safeParse(parsedJson);
    if (!result.success) {
      return null;
    }
    return {
      jobId: result.data.job_id,
      project: result.data.project,
      status: result.data.status,
      updatedAt: result.data.updated_at,
      completedShards: result.data.shards.filter((shard) => shard.status === "succeeded").length,
      totalShards: result.data.shards.length,
    };
  } catch (error) {
    if (error instanceof Error) {
      return null;
    }
    throw error;
  }
}
