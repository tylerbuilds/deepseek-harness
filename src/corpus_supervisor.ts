import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { corpusWorkAsync } from "./corpus.js";
import { HarnessError } from "./errors.js";
import { defaultArtifactRoot } from "./paths.js";

export interface CorpusSupervisorOptions {
  corpusRoot?: string;
  once?: boolean;
  maxCycles?: number;
  intervalMs?: number;
  maxJobsPerCycle?: number;
  maxIterationsPerJob?: number;
  allowLive?: boolean;
}

export interface CorpusSupervisorJobReport {
  job_id: string;
  artifact_dir: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
}

export interface CorpusSupervisorCycleReport {
  cycle: number;
  discovered_job_ids: string[];
  selected_job_ids: string[];
  deferred_job_ids: string[];
  jobs: CorpusSupervisorJobReport[];
  discovery_errors: Array<{
    artifact_dir: string;
    error: {
      code: string;
      message: string;
    };
  }>;
}

export interface CorpusSupervisorReport {
  ok: boolean;
  corpus_root: string;
  lock_path: string;
  cycles: CorpusSupervisorCycleReport[];
  supervisor: {
    cycles: number;
    max_cycles: number;
    bounded: true;
    terminal: boolean;
  };
}

interface SupervisorConfig {
  corpusRoot: string;
  lockPath: string;
  statePath: string;
  maxCycles: number;
  intervalMs: number;
  maxJobsPerCycle: number;
  maxIterationsPerJob: number;
}

interface DiscoveredCorpusJob {
  jobId: string;
  artifactDir: string;
  liveRequired: boolean;
}

interface CorpusLedgerHeader {
  job_id?: unknown;
  status?: unknown;
  artifact_dir?: unknown;
  processor?: unknown;
}

interface SupervisorCursor {
  jobId: string;
  artifactDir: string;
}

interface CorpusSupervisorState {
  schema_version: "deepseek-harness.corpus-supervisor-state.v1";
  last_selected_job_id: string;
  last_selected_artifact_dir: string;
}

const DEFAULT_MAX_CYCLES = 1;
const DEFAULT_INTERVAL_MS = 0;
const DEFAULT_MAX_JOBS_PER_CYCLE = 100;
const DEFAULT_MAX_ITERATIONS_PER_JOB = 100;
const MAX_CYCLES = 10_000;
const MAX_JOBS_PER_CYCLE = 1_000;
const MAX_INTERVAL_MS = 3_600_000;
const MAX_RETAINED_CYCLES = 10;
const SUPERVISOR_STATE_SCHEMA = "deepseek-harness.corpus-supervisor-state.v1" as const;
const MAX_STATE_VALUE_LENGTH = 4_096;

export async function corpusSupervisorAsync(
  options: CorpusSupervisorOptions = {}
): Promise<CorpusSupervisorReport> {
  const config = normaliseOptions(options);
  const lockFd = acquireSupervisorLock(config.lockPath);

  try {
    const cycles: CorpusSupervisorCycleReport[] = [];
    let cursor = loadSupervisorCursor(config.statePath, config.corpusRoot);
    let completedCycles = 0;
    let hasFailures = false;
    for (let cycle = 1; cycle <= config.maxCycles; cycle += 1) {
      const result = await runSupervisorCycle(cycle, config, cursor);
      cursor = result.cursor;
      const report = result.report;
      completedCycles = cycle;
      hasFailures = hasFailures || report.discovery_errors.length > 0 || report.jobs.some((job) => !job.ok);
      cycles.push(report);
      if (cycles.length > MAX_RETAINED_CYCLES) {
        cycles.shift();
      }
      if (cycle < config.maxCycles && config.intervalMs > 0) {
        await delay(config.intervalMs);
      }
    }

    return {
      ok: !hasFailures,
      corpus_root: config.corpusRoot,
      lock_path: config.lockPath,
      cycles,
      supervisor: {
        cycles: completedCycles,
        max_cycles: config.maxCycles,
        bounded: true,
        terminal: completedCycles >= config.maxCycles
      }
    };
  } finally {
    releaseSupervisorLock(config.lockPath, lockFd);
  }
}

function normaliseOptions(options: CorpusSupervisorOptions): SupervisorConfig {
  if (options.once !== undefined && typeof options.once !== "boolean") {
    throw new HarnessError("invalid_corpus_supervisor_once", "once must be a boolean");
  }
  if (options.allowLive !== undefined && typeof options.allowLive !== "boolean") {
    throw new HarnessError("invalid_corpus_supervisor_allow_live", "allowLive must be a boolean");
  }
  if (options.allowLive === true) {
    throw new HarnessError(
      "corpus_supervisor_live_not_supported",
      "The persistent corpus supervisor cannot execute live DeepSeek work because signed authority is never persisted"
    );
  }

  const maxCycles = positiveIntegerOption(
    options.maxCycles,
    DEFAULT_MAX_CYCLES,
    MAX_CYCLES,
    "maxCycles",
    "invalid_corpus_supervisor_cycles"
  );
  const intervalMs = nonNegativeIntegerOption(
    options.intervalMs,
    DEFAULT_INTERVAL_MS,
    MAX_INTERVAL_MS,
    "intervalMs",
    "invalid_corpus_supervisor_interval"
  );
  const maxJobsPerCycle = positiveIntegerOption(
    options.maxJobsPerCycle,
    DEFAULT_MAX_JOBS_PER_CYCLE,
    MAX_JOBS_PER_CYCLE,
    "maxJobsPerCycle",
    "invalid_corpus_supervisor_jobs"
  );
  const maxIterationsPerJob = positiveIntegerOption(
    options.maxIterationsPerJob,
    DEFAULT_MAX_ITERATIONS_PER_JOB,
    10_000,
    "maxIterationsPerJob",
    "invalid_corpus_supervisor_iterations"
  );

  const artifactRoot = path.resolve(defaultArtifactRoot());
  const corpusRoot = resolveConfinedCorpusRoot(options.corpusRoot, artifactRoot);
  fs.mkdirSync(corpusRoot, { recursive: true });
  const corpusRootStat = fs.statSync(corpusRoot);
  if (!corpusRootStat.isDirectory()) {
    throw new HarnessError("invalid_corpus_supervisor_root", `Corpus supervisor root is not a directory: ${corpusRoot}`);
  }

  return {
    corpusRoot,
    lockPath: path.join(corpusRoot, "supervisor.lock"),
    statePath: path.join(corpusRoot, "supervisor-state.json"),
    maxCycles: options.once === true ? 1 : maxCycles,
    intervalMs,
    maxJobsPerCycle,
    maxIterationsPerJob
  };
}

function positiveIntegerOption(
  value: number | undefined,
  defaultValue: number,
  maximum: number,
  name: string,
  code: string
): number {
  const resolved = value ?? defaultValue;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new HarnessError(code, `${name} must be an integer between 1 and ${maximum}`);
  }
  return resolved;
}

function nonNegativeIntegerOption(
  value: number | undefined,
  defaultValue: number,
  maximum: number,
  name: string,
  code: string
): number {
  const resolved = value ?? defaultValue;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > maximum) {
    throw new HarnessError(code, `${name} must be an integer between 0 and ${maximum}`);
  }
  return resolved;
}

function resolveConfinedCorpusRoot(explicitRoot: string | undefined, artifactRoot: string): string {
  const candidate = path.resolve(explicitRoot ?? path.join(artifactRoot, "corpus"));
  assertSafePath(candidate, artifactRoot);

  const realArtifactRoot = existingRealPath(artifactRoot);
  const realCandidate = existingRealPath(candidate);
  if (realArtifactRoot && realCandidate && !isWithin(realCandidate, realArtifactRoot)) {
    throw new HarnessError(
      "corpus_supervisor_path_blocked",
      "Corpus supervisor root must stay under DEEPSEEK_HARNESS_ARTIFACT_DIR"
    );
  }
  return candidate;
}

function existingRealPath(candidate: string): string | null {
  let current = path.resolve(candidate);
  try {
    return fs.realpathSync(current);
  } catch (error) {
    if (!isNoEntryError(error)) {
      throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
    return existingRealPath(current);
  }
}

async function runSupervisorCycle(
  cycleNumber: number,
  config: SupervisorConfig,
  cursor: SupervisorCursor | null
): Promise<{ report: CorpusSupervisorCycleReport; cursor: SupervisorCursor | null }> {
  const discovered = discoverRunningJobs(config.corpusRoot);
  const deferred = discovered.jobs.filter((job) => job.liveRequired);
  const eligible = discovered.jobs.filter((job) => !job.liveRequired);
  const selected = selectFairJobs(eligible, config.maxJobsPerCycle, cursor);
  const nextCursor = selected.length > 0 ? cursorForJob(selected[selected.length - 1]!) : cursor;
  if (nextCursor && (!cursor || compareSupervisorJobs(nextCursor, cursor) !== 0)) {
    writeSupervisorCursor(config.statePath, config.corpusRoot, nextCursor);
  }
  const jobs: CorpusSupervisorJobReport[] = [];

  for (const job of selected) {
    try {
      const result = await corpusWorkAsync(job.jobId, {
        artifactDir: job.artifactDir,
        allowLive: false,
        maxIterations: config.maxIterationsPerJob,
        intervalMs: 0
      });
      jobs.push({
        job_id: job.jobId,
        artifact_dir: job.artifactDir,
        ok: result.ok === true,
        result
      });
    } catch (error) {
      jobs.push({
        job_id: job.jobId,
        artifact_dir: job.artifactDir,
        ok: false,
        error: errorPayload(error)
      });
    }
  }

  return {
    report: {
      cycle: cycleNumber,
      discovered_job_ids: discovered.jobs.map((job) => job.jobId),
      selected_job_ids: selected.map((job) => job.jobId),
      deferred_job_ids: deferred.map((job) => job.jobId),
      jobs,
      discovery_errors: discovered.errors
    },
    cursor: nextCursor
  };
}

function selectFairJobs(
  eligible: DiscoveredCorpusJob[],
  maxJobsPerCycle: number,
  cursor: SupervisorCursor | null
): DiscoveredCorpusJob[] {
  if (eligible.length === 0) {
    return [];
  }

  let start = 0;
  if (cursor) {
    const nextIndex = eligible.findIndex((job) => compareSupervisorJobs(job, cursor) > 0);
    start = nextIndex === -1 ? 0 : nextIndex;
  }
  const ordered = [...eligible.slice(start), ...eligible.slice(0, start)];
  return ordered.slice(0, maxJobsPerCycle);
}

function cursorForJob(job: DiscoveredCorpusJob): SupervisorCursor {
  return { jobId: job.jobId, artifactDir: job.artifactDir };
}

function compareSupervisorJobs(left: SupervisorCursor | DiscoveredCorpusJob, right: SupervisorCursor): number {
  return compareDeterministically(left.jobId, right.jobId) || compareDeterministically(left.artifactDir, right.artifactDir);
}

function loadSupervisorCursor(statePath: string, corpusRoot: string): SupervisorCursor | null {
  let stateStat: fs.Stats;
  try {
    stateStat = fs.lstatSync(statePath);
  } catch (error) {
    if (isNoEntryError(error)) {
      return null;
    }
    throw error;
  }
  if (!stateStat.isFile() || stateStat.isSymbolicLink()) {
    throw new HarnessError("invalid_corpus_supervisor_state", `Supervisor state must be a regular file: ${statePath}`);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<CorpusSupervisorState>;
    if (parsed.schema_version !== SUPERVISOR_STATE_SCHEMA) {
      throw new HarnessError("invalid_corpus_supervisor_state", "Supervisor state schema is unsupported");
    }
    const jobId = boundedStateString(parsed.last_selected_job_id, "last_selected_job_id");
    const artifactDir = boundedStateString(parsed.last_selected_artifact_dir, "last_selected_artifact_dir");
    if (!isWithin(path.resolve(artifactDir), path.resolve(corpusRoot))) {
      throw new HarnessError("corpus_supervisor_path_blocked", "Supervisor state cursor is outside the confined corpus root");
    }
    return { jobId, artifactDir: path.resolve(artifactDir) };
  } catch (error) {
    if (error instanceof HarnessError) {
      throw error;
    }
    throw new HarnessError("invalid_corpus_supervisor_state", `Supervisor state could not be read: ${statePath}`);
  }
}

function writeSupervisorCursor(statePath: string, corpusRoot: string, cursor: SupervisorCursor): void {
  const artifactDir = path.resolve(cursor.artifactDir);
  if (!isWithin(artifactDir, corpusRoot)) {
    throw new HarnessError("corpus_supervisor_path_blocked", "Supervisor state cursor is outside the confined corpus root");
  }
  const state: CorpusSupervisorState = {
    schema_version: SUPERVISOR_STATE_SCHEMA,
    last_selected_job_id: boundedStateString(cursor.jobId, "last_selected_job_id"),
    last_selected_artifact_dir: boundedStateString(artifactDir, "last_selected_artifact_dir")
  };
  assertRegularStatePath(statePath);

  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(state)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporaryPath, statePath);
    fsyncDirectory(path.dirname(statePath));
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if (!isNoEntryError(error)) {
        throw error;
      }
    }
  }
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function boundedStateString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_STATE_VALUE_LENGTH || value.includes("\0")) {
    throw new HarnessError("invalid_corpus_supervisor_state", `Supervisor state ${field} is invalid`);
  }
  return value;
}

function assertRegularStatePath(statePath: string): void {
  try {
    const stat = fs.lstatSync(statePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new HarnessError("invalid_corpus_supervisor_state", `Supervisor state must be a regular file: ${statePath}`);
    }
  } catch (error) {
    if (!isNoEntryError(error)) {
      throw error;
    }
  }
}

function discoverRunningJobs(corpusRoot: string): {
  jobs: DiscoveredCorpusJob[];
  errors: CorpusSupervisorCycleReport["discovery_errors"];
} {
  const jobs: DiscoveredCorpusJob[] = [];
  const errors: CorpusSupervisorCycleReport["discovery_errors"] = [];
  const entries = fs.readdirSync(corpusRoot, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }

    const artifactDir = path.join(corpusRoot, entry.name);
    const ledgerPath = path.join(artifactDir, "ledger.json");
    try {
      const ledgerStat = fs.lstatSync(ledgerPath);
      if (!ledgerStat.isFile()) {
        continue;
      }
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as CorpusLedgerHeader;
      if (ledger.status !== "running") {
        continue;
      }
      if (typeof ledger.job_id !== "string" || ledger.job_id.length === 0) {
        throw new HarnessError("invalid_corpus_supervisor_ledger", "Running corpus ledger is missing a job_id");
      }
      if (ledger.artifact_dir !== undefined) {
        if (typeof ledger.artifact_dir !== "string" || path.resolve(ledger.artifact_dir) !== path.resolve(artifactDir)) {
          throw new HarnessError(
            "corpus_supervisor_path_blocked",
            "Running corpus ledger artifact_dir must match its confined job directory"
          );
        }
      }
      jobs.push({ jobId: ledger.job_id, artifactDir, liveRequired: isLiveDeepSeekProcessor(ledger.processor) });
    } catch (error) {
      errors.push({ artifact_dir: artifactDir, error: errorPayload(error) });
    }
  }

  jobs.sort((left, right) => compareDeterministically(left.jobId, right.jobId) || compareDeterministically(left.artifactDir, right.artifactDir));
  return { jobs, errors };
}

function isLiveDeepSeekProcessor(processor: unknown): boolean {
  if (!processor || typeof processor !== "object") {
    return false;
  }
  const candidate = processor as { type?: unknown; transport?: unknown };
  return candidate.type === "deepseek_batch" && candidate.transport === "deepseek";
}

function acquireSupervisorLock(lockPath: string): number {
  let fd: number | null = null;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fd = fs.openSync(lockPath, "wx");
        break;
      } catch (error) {
        if (attempt === 0 && isFileExistsError(error) && removeStaleSupervisorLock(lockPath)) {
          continue;
        }
        throw error;
      }
    }
    if (fd === null) {
      throw new HarnessError("corpus_supervisor_lock_failed", `Corpus supervisor lock could not be acquired: ${lockPath}`);
    }
    fs.writeFileSync(
      fd,
      JSON.stringify({
        schema_version: "deepseek-harness.corpus-supervisor-lock.v1",
        pid: process.pid,
        acquired_at: new Date().toISOString()
      })
    );
    return fd;
  } catch (error) {
    if (isFileExistsError(error)) {
      throw new HarnessError("corpus_supervisor_already_running", `Corpus supervisor lock already exists: ${lockPath}`);
    }
    if (fd !== null) {
      fs.closeSync(fd);
      try {
        fs.unlinkSync(lockPath);
      } catch (cleanupError) {
        if (!isNoEntryError(cleanupError)) {
          throw cleanupError;
        }
      }
    }
    throw error;
  }
}

function removeStaleSupervisorLock(lockPath: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown };
    if (!Number.isInteger(parsed.pid) || Number(parsed.pid) <= 0 || processExists(Number(parsed.pid))) {
      return false;
    }
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ESRCH");
  }
}

function releaseSupervisorLock(lockPath: string, fd: number): void {
  fs.closeSync(fd);
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (!isNoEntryError(error)) {
      throw error;
    }
  }
}

function errorPayload(error: unknown): { code: string; message: string } {
  if (error instanceof HarnessError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: "unexpected_error", message: error.message };
  }
  return { code: "unexpected_error", message: String(error) };
}

function assertSafePath(candidate: string, artifactRoot: string): void {
  if (!isWithin(candidate, artifactRoot)) {
    throw new HarnessError(
      "corpus_supervisor_path_blocked",
      "Corpus supervisor root must stay under DEEPSEEK_HARNESS_ARTIFACT_DIR"
    );
  }
  const normalised = candidate.split(path.sep).join("/");
  const protectedWorkspaceRoot = path.resolve(os.homedir(), "Documents", "Obsidian").split(path.sep).join("/");
  const forbidden = [
    `${protectedWorkspaceRoot}/`,
    "/.ssh/",
    "/.gnupg/",
    "/Library/Keychains/",
    "/.config/opencode/auth",
    "/.codex/auth"
  ];
  if (forbidden.some((part) => normalised.includes(part))) {
    throw new HarnessError("corpus_path_forbidden", `Corpus path is forbidden: ${candidate}`);
  }
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function compareDeterministically(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function delay(intervalMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, intervalMs));
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}

function isNoEntryError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
