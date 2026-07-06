import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HarnessError } from "./errors.js";
import type { RunManifest } from "./schema.js";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ItemStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface RunRecord {
  run_id: string;
  status: RunStatus;
  manifest: RunManifest;
  artifact_dir: string;
  created_at: string;
  updated_at: string;
  error: string | null;
}

export interface ItemRecord {
  run_id: string;
  item_id: string;
  status: ItemStatus;
  input: unknown;
  result: unknown;
  error: string | null;
  attempts: number;
  usage: unknown;
  started_at: string | null;
  finished_at: string | null;
}

export class HarnessStore {
  readonly stateDir: string;
  readonly dbPath: string;
  readonly db: DatabaseSync;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    fs.mkdirSync(stateDir, { recursive: true });
    this.dbPath = path.join(stateDir, "deepseek-harness.sqlite");
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        artifact_dir TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS items (
        run_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        usage_json TEXT,
        started_at TEXT,
        finished_at TEXT,
        PRIMARY KEY (run_id, item_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `);
  }

  createRun(runId: string, manifest: RunManifest, artifactDir: string): RunRecord {
    fs.mkdirSync(artifactDir, { recursive: true });
    const now = new Date().toISOString();
    const insertRun = this.db.prepare(`
      INSERT INTO runs (run_id, status, manifest_json, artifact_dir, created_at, updated_at, error)
      VALUES (?, 'queued', ?, ?, ?, ?, NULL)
    `);
    const insertItem = this.db.prepare(`
      INSERT INTO items (run_id, item_id, status, input_json, attempts)
      VALUES (?, ?, 'queued', ?, 0)
    `);

    this.db.exec("BEGIN");
    try {
      insertRun.run(runId, JSON.stringify(manifest), artifactDir, now, now);
      for (const item of manifest.items) {
        insertItem.run(runId, item.id, JSON.stringify(item));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.event(runId, "run_queued", { item_count: manifest.items.length, artifact_dir: artifactDir });
    return this.getRun(runId);
  }

  getRun(runId: string): RunRecord {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE run_id = ?")
      .get(runId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new HarnessError("run_not_found", `Run not found: ${runId}`);
    }

    return {
      run_id: String(row.run_id),
      status: row.status as RunStatus,
      manifest: JSON.parse(String(row.manifest_json)) as RunManifest,
      artifact_dir: String(row.artifact_dir),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      error: row.error === null ? null : String(row.error)
    };
  }

  listRuns(limit = 20): RunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      run_id: String(row.run_id),
      status: row.status as RunStatus,
      manifest: JSON.parse(String(row.manifest_json)) as RunManifest,
      artifact_dir: String(row.artifact_dir),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      error: row.error === null ? null : String(row.error)
    }));
  }

  listItems(runId: string): ItemRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM items WHERE run_id = ? ORDER BY item_id")
      .all(runId) as Record<string, unknown>[];

    return rows.map((row) => ({
      run_id: String(row.run_id),
      item_id: String(row.item_id),
      status: row.status as ItemStatus,
      input: JSON.parse(String(row.input_json)),
      result: row.result_json ? JSON.parse(String(row.result_json)) : null,
      error: row.error === null ? null : String(row.error),
      attempts: Number(row.attempts),
      usage: row.usage_json ? JSON.parse(String(row.usage_json)) : null,
      started_at: row.started_at === null ? null : String(row.started_at),
      finished_at: row.finished_at === null ? null : String(row.finished_at)
    }));
  }

  queuedItems(runId: string): ItemRecord[] {
    return this.listItems(runId).filter((item) => item.status === "queued");
  }

  setRunStatus(runId: string, status: RunStatus, error?: string): void {
    this.db
      .prepare("UPDATE runs SET status = ?, updated_at = ?, error = ? WHERE run_id = ?")
      .run(status, new Date().toISOString(), error ?? null, runId);
    this.event(runId, `run_${status}`, error ? { error } : {});
  }

  markItemRunning(runId: string, itemId: string): void {
    this.db
      .prepare(
        "UPDATE items SET status = 'running', attempts = attempts + 1, started_at = COALESCE(started_at, ?) WHERE run_id = ? AND item_id = ?"
      )
      .run(new Date().toISOString(), runId, itemId);
    this.event(runId, "item_running", { item_id: itemId });
  }

  completeItem(runId: string, itemId: string, result: unknown, usage: unknown): void {
    this.db
      .prepare(
        "UPDATE items SET status = 'completed', result_json = ?, usage_json = ?, finished_at = ?, error = NULL WHERE run_id = ? AND item_id = ?"
      )
      .run(JSON.stringify(result), usage ? JSON.stringify(usage) : null, new Date().toISOString(), runId, itemId);
    this.event(runId, "item_completed", { item_id: itemId });
  }

  failItem(runId: string, itemId: string, error: string): void {
    this.db
      .prepare("UPDATE items SET status = 'failed', error = ?, finished_at = ? WHERE run_id = ? AND item_id = ?")
      .run(error, new Date().toISOString(), runId, itemId);
    this.event(runId, "item_failed", { item_id: itemId, error });
  }

  cancelRun(runId: string): RunRecord {
    this.getRun(runId);
    this.db
      .prepare("UPDATE items SET status = 'cancelled', finished_at = ? WHERE run_id = ? AND status IN ('queued', 'running')")
      .run(new Date().toISOString(), runId);
    this.setRunStatus(runId, "cancelled");
    return this.getRun(runId);
  }

  summary(runId: string): Record<string, unknown> {
    const run = this.getRun(runId);
    const items = this.listItems(runId);
    const counts = items.reduce<Record<string, number>>((acc, item) => {
      acc[item.status] = (acc[item.status] ?? 0) + 1;
      return acc;
    }, {});
    return {
      run_id: run.run_id,
      status: run.status,
      project: run.manifest.project,
      transport: run.manifest.transport,
      model: run.manifest.model,
      artifact_dir: run.artifact_dir,
      created_at: run.created_at,
      updated_at: run.updated_at,
      error: run.error,
      item_count: items.length,
      counts
    };
  }

  runSummaryRecord(run: RunRecord): Record<string, unknown> {
    const items = this.listItems(run.run_id);
    const counts = items.reduce<Record<string, number>>((acc, item) => {
      acc[item.status] = (acc[item.status] ?? 0) + 1;
      return acc;
    }, {});
    return {
      run_id: run.run_id,
      status: run.status,
      project: run.manifest.project,
      transport: run.manifest.transport,
      model: run.manifest.model,
      artifact_dir: run.artifact_dir,
      created_at: run.created_at,
      updated_at: run.updated_at,
      error: run.error,
      item_count: items.length,
      counts
    };
  }

  event(runId: string, type: string, payload: unknown): void {
    this.db
      .prepare("INSERT INTO events (run_id, ts, type, payload_json) VALUES (?, ?, ?, ?)")
      .run(runId, new Date().toISOString(), type, JSON.stringify(payload));
  }
}
