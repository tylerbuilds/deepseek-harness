import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HarnessError } from "./errors.js";
import type { ApprovalReceipt, RunManifest } from "./schema.js";
import type { BudgetEstimate } from "./budget.js";

export const STATE_SCHEMA_VERSION = 2;

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "budget_exhausted";
export type ItemStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "budget_exhausted";

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

export interface SessionRecord {
  id: string;
  created_at: string;
  updated_at: string;
  cwd: string;
  model: string;
  summary: string;
  message_count: number;
  total_tokens: number;
  total_cost_usd: number;
}

export interface MessageRecord {
  id: number;
  session_id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls_json: string | null;
  tool_call_id: string | null;
  token_count: number | null;
  created_at: string;
}

export class HarnessStore {
  readonly stateDir: string;
  readonly dbPath: string;
  readonly db: DatabaseSync;
  readonly schemaVersion: number;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    fs.mkdirSync(stateDir, { recursive: true });
    this.dbPath = path.join(stateDir, "deepseek-harness.sqlite");
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    const existingSchemaVersion = this.readSchemaVersion();
    if (existingSchemaVersion > STATE_SCHEMA_VERSION) {
      this.db.close();
      throw new HarnessError(
        "state_schema_too_new",
        `State schema ${existingSchemaVersion} is newer than supported schema ${STATE_SCHEMA_VERSION}. Upgrade deepseek-harness before using this state directory.`,
        {
          state_dir: this.stateDir,
          found_schema: existingSchemaVersion,
          supported_schema: STATE_SCHEMA_VERSION,
          recoverable: true,
          next_actions: ["Upgrade deepseek-harness, then rerun deepseek-harness doctor."]
        }
      );
    }
    this.migrate();
    this.schemaVersion = this.readSchemaVersion();
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
      CREATE TABLE IF NOT EXISTS approval_receipt_consumptions (
        receipt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        receipt_sha256 TEXT NOT NULL,
        network_payload_sha256 TEXT NOT NULL,
        consumed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS budget_reservations (
        run_id TEXT PRIMARY KEY,
        receipt_id TEXT NOT NULL,
        local_date TEXT NOT NULL,
        rate_snapshot_id TEXT NOT NULL,
        reserved_usd REAL NOT NULL,
        charged_usd REAL NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reconciled_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_budget_reservations_local_date ON budget_reservations(local_date);
      CREATE INDEX IF NOT EXISTS idx_budget_reservations_created_at ON budget_reservations(created_at);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        cwd TEXT NOT NULL,
        model TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        message_count INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        total_cost_usd REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_calls_json TEXT,
        tool_call_id TEXT,
        token_count INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
      PRAGMA user_version = ${STATE_SCHEMA_VERSION};
    `);
  }

  private readSchemaVersion(): number {
    const row = this.db.prepare("PRAGMA user_version;").get() as { user_version?: number } | undefined;
    return Number(row?.user_version ?? 0);
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

  authoriseAndReserveLiveRun(
    runId: string,
    receipt: ApprovalReceipt,
    receiptSha256: string,
    estimate: BudgetEstimate,
    networkPayloadSha256: string,
    now = new Date()
  ): void {
    const consumedAt = now.toISOString();
    const localDate = consumedAt.slice(0, 10);
    const rollingWindowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const replay = this.db
        .prepare("SELECT run_id FROM approval_receipt_consumptions WHERE receipt_id = ?")
        .get(receipt.receipt_id) as Record<string, unknown> | undefined;
      if (replay) {
        throw new HarnessError("approval_receipt_replayed", "Approval receipt has already been consumed", {
          receipt_id: receipt.receipt_id
        });
      }
      const existingBudget = this.db
        .prepare(
          "SELECT COALESCE(SUM(CASE WHEN status = 'reserved' THEN reserved_usd ELSE charged_usd END), 0) AS total FROM budget_reservations WHERE created_at >= ?"
        )
        .get(rollingWindowStart) as Record<string, unknown>;
      const dailyCommitted = Number(existingBudget.total ?? 0);
      if (dailyCommitted + estimate.reserved_usd > receipt.daily_cost_cap_usd + 1e-9) {
        throw new HarnessError("daily_budget_exhausted", "Daily DeepSeek cost ceiling would be exceeded", {
          daily_committed_usd: Number(dailyCommitted.toFixed(8)),
          requested_reservation_usd: estimate.reserved_usd,
          daily_cost_cap_usd: receipt.daily_cost_cap_usd,
          rolling_window_started_at: rollingWindowStart
        });
      }
      this.db
        .prepare(
          "INSERT INTO approval_receipt_consumptions (receipt_id, run_id, receipt_sha256, network_payload_sha256, consumed_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(receipt.receipt_id, runId, receiptSha256, networkPayloadSha256, consumedAt);
      this.db
        .prepare(
          "INSERT INTO budget_reservations (run_id, receipt_id, local_date, rate_snapshot_id, reserved_usd, charged_usd, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)"
        )
        .run(
          runId,
          receipt.receipt_id,
          localDate,
          estimate.rate_snapshot_id,
          estimate.reserved_usd,
          estimate.reserved_usd,
          consumedAt
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.event(runId, "live_run_authorised", {
      receipt_sha256: receiptSha256,
      network_payload_sha256: networkPayloadSha256,
      reserved_usd: estimate.reserved_usd,
      rate_snapshot_id: estimate.rate_snapshot_id
    });
    this.redactConsumedReceipt(runId);
  }

  redactConsumedReceipt(runId: string): void {
    const run = this.getRun(runId);
    if (!run.manifest.approval_receipt) {
      return;
    }
    const redactedManifest: RunManifest = {
      ...run.manifest,
      approval_receipt: {
        ...run.manifest.approval_receipt,
        signature_base64: "[consumed-signature-redacted]"
      }
    };
    this.db
      .prepare("UPDATE runs SET manifest_json = ?, updated_at = ? WHERE run_id = ?")
      .run(JSON.stringify(redactedManifest), new Date().toISOString(), runId);
  }

  markBudgetExhausted(runId: string, reason: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE items SET status = 'budget_exhausted', error = ?, finished_at = ? WHERE run_id = ? AND status = 'queued'"
      )
      .run(reason, now, runId);
    this.setRunStatus(runId, "budget_exhausted", reason);
  }

  reconcileBudget(runId: string, chargedUsd: number | null): void {
    const row = this.db
      .prepare("SELECT reserved_usd FROM budget_reservations WHERE run_id = ?")
      .get(runId) as Record<string, unknown> | undefined;
    if (!row) {
      return;
    }
    const reserved = Number(row.reserved_usd);
    const retainReservation = chargedUsd === null;
    const charged = retainReservation ? reserved : Math.max(0, chargedUsd);
    const status = retainReservation ? "retained_conservative" : charged > reserved + 1e-9 ? "overrun" : "reconciled";
    this.db
      .prepare(
        "UPDATE budget_reservations SET charged_usd = ?, status = ?, reconciled_at = ? WHERE run_id = ?"
      )
      .run(charged, status, new Date().toISOString(), runId);
    this.event(runId, "budget_reconciled", {
      charged_usd: Number(charged.toFixed(8)),
      reserved_usd: Number(reserved.toFixed(8)),
      missing_usage_retained_reservation: retainReservation,
      reservation_overrun: status === "overrun"
    });
  }

  budgetStatus(runId: string): Record<string, unknown> | null {
    const row = this.db
      .prepare(
        "SELECT local_date, rate_snapshot_id, reserved_usd, charged_usd, status, created_at, reconciled_at FROM budget_reservations WHERE run_id = ?"
      )
      .get(runId) as Record<string, unknown> | undefined;
    return row ? { ...row } : null;
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
      counts,
      budget: this.budgetStatus(runId)
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

  createSession(id: string, cwd: string, model: string): SessionRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO sessions (id, created_at, updated_at, cwd, model) VALUES (?, ?, ?, ?, ?)"
      )
      .run(id, now, now, cwd, model);
    return this.getSession(id);
  }

  getSession(id: string): SessionRecord {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new HarnessError("session_not_found", `Session not found: ${id}`);
    }
    return {
      id: String(row.id),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      cwd: String(row.cwd),
      model: String(row.model),
      summary: String(row.summary ?? ""),
      message_count: Number(row.message_count ?? 0),
      total_tokens: Number(row.total_tokens ?? 0),
      total_cost_usd: Number(row.total_cost_usd ?? 0),
    };
  }

  listSessions(limit = 20): SessionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      cwd: String(row.cwd),
      model: String(row.model),
      summary: String(row.summary ?? ""),
      message_count: Number(row.message_count ?? 0),
      total_tokens: Number(row.total_tokens ?? 0),
      total_cost_usd: Number(row.total_cost_usd ?? 0),
    }));
  }

  updateSession(id: string, updates: { summary?: string; message_count?: number; total_tokens?: number; total_cost_usd?: number }): void {
    const now = new Date().toISOString();
    const existing = this.getSession(id);
    const summary = updates.summary ?? existing.summary;
    const messageCount = updates.message_count ?? existing.message_count;
    const totalTokens = updates.total_tokens ?? existing.total_tokens;
    const totalCostUsd = updates.total_cost_usd ?? existing.total_cost_usd;
    this.db
      .prepare(
        "UPDATE sessions SET updated_at = ?, summary = ?, message_count = ?, total_tokens = ?, total_cost_usd = ? WHERE id = ?"
      )
      .run(now, summary, messageCount, totalTokens, totalCostUsd, id);
  }

  addMessage(sessionId: string, message: { role: string; content?: string | null; tool_calls_json?: string | null; tool_call_id?: string | null; token_count?: number | null }): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "INSERT INTO messages (session_id, role, content, tool_calls_json, tool_call_id, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        sessionId,
        message.role,
        message.content ?? null,
        message.tool_calls_json ?? null,
        message.tool_call_id ?? null,
        message.token_count ?? null,
        now
      );
    return Number(result.lastInsertRowid);
  }

  getMessages(sessionId: string, limit?: number, offset = 0): MessageRecord[] {
    const query = limit !== undefined
      ? "SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT ? OFFSET ?"
      : "SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC";
    const rows = limit !== undefined
      ? this.db.prepare(query).all(sessionId, limit, offset) as Record<string, unknown>[]
      : this.db.prepare(query).all(sessionId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row.id),
      session_id: String(row.session_id),
      role: String(row.role) as MessageRecord["role"],
      content: row.content === null ? null : String(row.content),
      tool_calls_json: row.tool_calls_json === null ? null : String(row.tool_calls_json),
      tool_call_id: row.tool_call_id === null ? null : String(row.tool_call_id),
      token_count: row.token_count === null ? null : Number(row.token_count),
      created_at: String(row.created_at),
    }));
  }

  countMessages(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM messages WHERE session_id = ?")
      .get(sessionId) as { cnt: number };
    return row.cnt;
  }

  deleteSession(sessionId: string): void {
    this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  }
}
