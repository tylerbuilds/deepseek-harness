import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { HarnessError } from "./errors.js";

export interface TranslationMemoryOptions {
  dbPath: string;
  allowedRoot: string;
}

export interface TranslationMemoryLookupInput {
  namespace: string;
  sourceText: string;
  sourceLang: string;
  targetLang: string;
  glossarySha256?: string | null;
}

export interface TranslationMemoryUpsertInput extends TranslationMemoryLookupInput {
  targetText: string;
}

export interface TranslationMemoryReviewProvenance {
  readonly receiptId: string;
  readonly receiptSha256: string;
  readonly reviewer: string;
  readonly reviewPayloadSha256: string;
}

export interface TranslationMemoryReviewedBatchInput {
  readonly provenance: TranslationMemoryReviewProvenance;
  readonly entries: readonly TranslationMemoryUpsertInput[];
}

export interface TranslationMemoryLookupMiss {
  hit: false;
  namespace: string;
  source_sha256: string;
  source_lang: string;
  target_lang: string;
  glossary_sha256: string | null;
}

export interface TranslationMemoryLookupHit {
  hit: true;
  namespace: string;
  source_sha256: string;
  source_lang: string;
  target_lang: string;
  glossary_sha256: string | null;
  target_text: string;
  target_sha256: string;
  review_receipt_id: string;
  review_receipt_sha256: string;
  reviewer: string;
  review_payload_sha256: string;
  created_at: string;
  updated_at: string;
}

export type TranslationMemoryLookupResult = TranslationMemoryLookupMiss | TranslationMemoryLookupHit;

export interface TranslationMemoryUpsertResult {
  namespace: string;
  source_sha256: string;
  source_lang: string;
  target_lang: string;
  glossary_sha256: string | null;
  target_sha256: string;
  created_at: string;
  updated_at: string;
  inserted: boolean;
}

export interface TranslationMemoryReviewedWriteResult extends TranslationMemoryUpsertResult {
  review_receipt_id: string;
  review_receipt_sha256: string;
  reviewer: string;
  review_payload_sha256: string;
}

export interface TranslationMemoryStats {
  entry_count: number;
  namespace_count: number;
  source_count: number;
  language_pair_count: number;
  glossary_variant_count: number;
}

interface TranslationMemoryKey {
  namespace: string;
  sourceText: string;
  sourceSha256: string;
  sourceLang: string;
  targetLang: string;
  glossarySha256: string | null;
  glossaryDbValue: string;
}

interface TranslationMemoryRow {
  namespace: string;
  source_sha256: string;
  source_lang: string;
  target_lang: string;
  glossary_sha256: string;
  source_text: string;
  target_text: string;
  target_sha256: string;
  review_receipt_id: string | null;
  review_receipt_sha256: string | null;
  reviewer: string | null;
  review_payload_sha256: string | null;
  created_at: string;
  updated_at: string;
}

interface PreparedTranslationMemoryEntry {
  readonly key: TranslationMemoryKey;
  readonly targetText: string;
  readonly targetSha256: string;
}

interface SafeTranslationMemoryPath {
  dbPath: string;
  allowedRoot: string;
}

const SENSITIVE_PATH_SEGMENTS = new Set([
  ".aws",
  ".config",
  ".gnupg",
  ".git",
  ".ssh",
  "credentials",
  "credential",
  "keychain",
  "keychains",
  "passwords",
  "secrets",
  "secret",
  "tokens",
  "token",
  "private_keys",
  "private-keys",
  "certificates",
  "certs",
  "etc",
  "system"
]);

const TRANSLATION_MEMORY_TABLE = "translation_memory_v2";
const MAX_NAMESPACE_LENGTH = 128;
const MAX_REVIEW_ID_LENGTH = 200;
const MAX_REVIEWER_LENGTH = 200;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_REVIEW_ID = /^[A-Za-z0-9_.:-]+$/;
const REVIEWED_ROW_PREDICATE = `
  review_receipt_id IS NOT NULL
  AND length(trim(review_receipt_id)) BETWEEN 1 AND ${MAX_REVIEW_ID_LENGTH}
  AND review_receipt_sha256 IS NOT NULL
  AND length(review_receipt_sha256) = 64
  AND review_receipt_sha256 NOT GLOB '*[^a-f0-9]*'
  AND reviewer IS NOT NULL
  AND length(trim(reviewer)) BETWEEN 1 AND ${MAX_REVIEWER_LENGTH}
  AND review_payload_sha256 IS NOT NULL
  AND length(review_payload_sha256) = 64
  AND review_payload_sha256 NOT GLOB '*[^a-f0-9]*'`;
const EXISTING_TRANSLATION_MEMORY_ROW_SQL = `
  SELECT created_at, review_receipt_id
    FROM ${TRANSLATION_MEMORY_TABLE}
   WHERE namespace = ?
     AND source_sha256 = ?
     AND source_lang = ?
     AND target_lang = ?
     AND glossary_sha256 = ?`;
const UPSERT_TRANSLATION_MEMORY_ROW_SQL = `
  INSERT INTO ${TRANSLATION_MEMORY_TABLE} (
    namespace, source_sha256, source_lang, target_lang, glossary_sha256,
    source_text, target_text, target_sha256,
    review_receipt_id, review_receipt_sha256, reviewer, review_payload_sha256,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (namespace, source_sha256, source_lang, target_lang, glossary_sha256)
  DO UPDATE SET
    source_text = excluded.source_text,
    target_text = excluded.target_text,
    target_sha256 = excluded.target_sha256,
    review_receipt_id = excluded.review_receipt_id,
    review_receipt_sha256 = excluded.review_receipt_sha256,
    reviewer = excluded.reviewer,
    review_payload_sha256 = excluded.review_payload_sha256,
    updated_at = excluded.updated_at
  RETURNING namespace, source_sha256, source_lang, target_lang, glossary_sha256,
            target_sha256, review_receipt_id, review_receipt_sha256, reviewer,
            review_payload_sha256, created_at, updated_at`;
const REVIEW_PROVENANCE_COLUMN_DEFINITIONS = [
  [
    "review_receipt_id",
    `review_receipt_id TEXT CHECK (
      review_receipt_id IS NULL OR length(trim(review_receipt_id)) BETWEEN 1 AND ${MAX_REVIEW_ID_LENGTH}
    )`
  ],
  [
    "review_receipt_sha256",
    `review_receipt_sha256 TEXT CHECK (
      review_receipt_sha256 IS NULL OR (
        length(review_receipt_sha256) = 64 AND review_receipt_sha256 NOT GLOB '*[^a-f0-9]*'
      )
    )`
  ],
  [
    "reviewer",
    `reviewer TEXT CHECK (
      reviewer IS NULL OR length(trim(reviewer)) BETWEEN 1 AND ${MAX_REVIEWER_LENGTH}
    )`
  ],
  [
    "review_payload_sha256",
    `review_payload_sha256 TEXT CHECK (
      review_payload_sha256 IS NULL OR (
        length(review_payload_sha256) = 64 AND review_payload_sha256 NOT GLOB '*[^a-f0-9]*'
      )
    )`
  ]
] as const;

export function openTranslationMemory(options: TranslationMemoryOptions): TranslationMemory {
  return new TranslationMemory(options);
}

export function createTranslationMemory(options: TranslationMemoryOptions): TranslationMemory {
  return openTranslationMemory(options);
}

export function lookupTranslationMemory(
  memory: TranslationMemory,
  input: TranslationMemoryLookupInput
): TranslationMemoryLookupResult {
  return memory.lookup(input);
}

export function upsertUnreviewedTranslationMemoryForTest(
  memory: TranslationMemory,
  input: TranslationMemoryUpsertInput
): TranslationMemoryUpsertResult {
  return memory.upsertUnreviewedForTest(input);
}

export function commitReviewedTranslationMemoryBatch(
  memory: TranslationMemory,
  input: TranslationMemoryReviewedBatchInput
): readonly TranslationMemoryReviewedWriteResult[] {
  return memory.commitReviewedBatch(input);
}

export function translationMemoryStats(memory: TranslationMemory): TranslationMemoryStats {
  return memory.stats();
}

export class TranslationMemory {
  readonly dbPath: string;
  readonly allowedRoot: string;
  readonly db: DatabaseSync;
  private closed = false;

  constructor(options: TranslationMemoryOptions) {
    const safePath = resolveSafeTranslationMemoryPath(options);
    this.dbPath = safePath.dbPath;
    this.allowedRoot = safePath.allowedRoot;

    const db = new DatabaseSync(this.dbPath, { timeout: 5000 });
    try {
      db.exec("PRAGMA busy_timeout = 5000;");
      try {
        db.exec("PRAGMA journal_mode = WAL;");
      } catch {
        db.exec("PRAGMA journal_mode = DELETE;");
      }
      db.exec("PRAGMA synchronous = FULL;");
      db.exec(`
        CREATE TABLE IF NOT EXISTS ${TRANSLATION_MEMORY_TABLE} (
          namespace TEXT NOT NULL CHECK (length(namespace) BETWEEN 1 AND ${MAX_NAMESPACE_LENGTH}),
          source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
          source_lang TEXT NOT NULL,
          target_lang TEXT NOT NULL,
          glossary_sha256 TEXT NOT NULL DEFAULT '' CHECK (glossary_sha256 = '' OR length(glossary_sha256) = 64),
          source_text TEXT NOT NULL,
          target_text TEXT NOT NULL,
          target_sha256 TEXT NOT NULL CHECK (length(target_sha256) = 64),
          review_receipt_id TEXT CHECK (
            review_receipt_id IS NULL OR length(trim(review_receipt_id)) BETWEEN 1 AND ${MAX_REVIEW_ID_LENGTH}
          ),
          review_receipt_sha256 TEXT CHECK (
            review_receipt_sha256 IS NULL OR (
              length(review_receipt_sha256) = 64 AND review_receipt_sha256 NOT GLOB '*[^a-f0-9]*'
            )
          ),
          reviewer TEXT CHECK (
            reviewer IS NULL OR length(trim(reviewer)) BETWEEN 1 AND ${MAX_REVIEWER_LENGTH}
          ),
          review_payload_sha256 TEXT CHECK (
            review_payload_sha256 IS NULL OR (
              length(review_payload_sha256) = 64 AND review_payload_sha256 NOT GLOB '*[^a-f0-9]*'
            )
          ),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (
            (review_receipt_id IS NULL AND review_receipt_sha256 IS NULL AND reviewer IS NULL AND review_payload_sha256 IS NULL)
            OR
            (review_receipt_id IS NOT NULL AND review_receipt_sha256 IS NOT NULL AND reviewer IS NOT NULL AND review_payload_sha256 IS NOT NULL)
          ),
          PRIMARY KEY (namespace, source_sha256, source_lang, target_lang, glossary_sha256)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS translation_memory_v2_language_idx
          ON ${TRANSLATION_MEMORY_TABLE} (namespace, source_lang, target_lang);
        CREATE INDEX IF NOT EXISTS translation_memory_v2_updated_idx
          ON ${TRANSLATION_MEMORY_TABLE} (updated_at);
      `);
      ensureReviewProvenanceColumns(db);
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }

  lookup(input: TranslationMemoryLookupInput): TranslationMemoryLookupResult {
    this.assertOpen();
    const key = keyForLookup(input);
    const row = this.db
      .prepare(
        `SELECT namespace, source_sha256, source_lang, target_lang, glossary_sha256,
                target_text, target_sha256, review_receipt_id, review_receipt_sha256,
                reviewer, review_payload_sha256, created_at, updated_at
           FROM ${TRANSLATION_MEMORY_TABLE}
          WHERE namespace = ?
            AND source_sha256 = ?
            AND source_lang = ?
            AND target_lang = ?
            AND glossary_sha256 = ?
            AND ${REVIEWED_ROW_PREDICATE}`
      )
      .get(key.namespace, key.sourceSha256, key.sourceLang, key.targetLang, key.glossaryDbValue);

    const metadata = {
      namespace: key.namespace,
      source_sha256: key.sourceSha256,
      source_lang: key.sourceLang,
      target_lang: key.targetLang,
      glossary_sha256: key.glossarySha256
    };
    if (!row) {
      return { hit: false, ...metadata };
    }

    return {
      hit: true,
      ...metadata,
      target_text: String(row.target_text),
      target_sha256: String(row.target_sha256),
      review_receipt_id: String(row.review_receipt_id),
      review_receipt_sha256: String(row.review_receipt_sha256),
      reviewer: String(row.reviewer),
      review_payload_sha256: String(row.review_payload_sha256),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at)
    };
  }

  upsertUnreviewedForTest(input: TranslationMemoryUpsertInput): TranslationMemoryUpsertResult {
    this.assertOpen();
    const entry = prepareTranslationMemoryEntry(input);
    const now = new Date().toISOString();

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.db.prepare(EXISTING_TRANSLATION_MEMORY_ROW_SQL).get(...entryKeyValues(entry.key));
      if (typeof existing?.review_receipt_id === "string") {
        throw new HarnessError(
          "translation_memory_unreviewed_overwrite_blocked",
          "Unsigned test/setup writes cannot overwrite a reviewed translation-memory entry"
        );
      }
      const row = this.db.prepare(UPSERT_TRANSLATION_MEMORY_ROW_SQL).get(
        ...entryKeyValues(entry.key),
        entry.key.sourceText,
        entry.targetText,
        entry.targetSha256,
        null,
        null,
        null,
        null,
        now,
        now
      );
      if (!row) {
        throw new HarnessError("translation_memory_write_failed", "Unsigned translation-memory setup write failed");
      }
      this.db.exec("COMMIT;");
      return writeResult(row, existing === undefined);
    } catch (error) {
      if (this.db.isTransaction) {
        this.db.exec("ROLLBACK;");
      }
      throw error;
    }
  }

  commitReviewedBatch(input: TranslationMemoryReviewedBatchInput): readonly TranslationMemoryReviewedWriteResult[] {
    this.assertOpen();
    if (!input || typeof input !== "object" || !Array.isArray(input.entries) || input.entries.length === 0) {
      throw new HarnessError(
        "invalid_translation_memory_reviewed_batch",
        "Reviewed translation-memory batch must contain at least one entry"
      );
    }
    const provenance = normalizeReviewProvenance(input.provenance);
    const preparedEntries = input.entries.map(prepareTranslationMemoryEntry);
    const identities = new Set<string>();
    for (const entry of preparedEntries) {
      const identity = JSON.stringify(entryKeyValues(entry.key));
      if (identities.has(identity)) {
        throw new HarnessError(
          "duplicate_translation_memory_reviewed_entry",
          "Reviewed translation-memory batch contains a duplicate entry key"
        );
      }
      identities.add(identity);
    }

    const now = new Date().toISOString();
    const results: TranslationMemoryReviewedWriteResult[] = [];
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const existingStatement = this.db.prepare(EXISTING_TRANSLATION_MEMORY_ROW_SQL);
      const upsertStatement = this.db.prepare(UPSERT_TRANSLATION_MEMORY_ROW_SQL);
      for (const entry of preparedEntries) {
        const keyValues = entryKeyValues(entry.key);
        const existing = existingStatement.get(...keyValues);
        const row = upsertStatement.get(
          ...keyValues,
          entry.key.sourceText,
          entry.targetText,
          entry.targetSha256,
          provenance.receiptId,
          provenance.receiptSha256,
          provenance.reviewer,
          provenance.reviewPayloadSha256,
          now,
          now
        );
        if (!row) {
          throw new HarnessError(
            "translation_memory_write_failed",
            "Reviewed translation-memory batch write failed"
          );
        }
        results.push(reviewedWriteResult(row, existing === undefined));
      }
      this.db.exec("COMMIT;");
      return results;
    } catch (error) {
      if (this.db.isTransaction) {
        this.db.exec("ROLLBACK;");
      }
      throw error;
    }
  }

  stats(): TranslationMemoryStats {
    this.assertOpen();
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS entry_count,
           COUNT(DISTINCT namespace) AS namespace_count,
           COUNT(DISTINCT source_sha256) AS source_count,
           COUNT(DISTINCT source_lang || char(0) || target_lang) AS language_pair_count,
           COUNT(DISTINCT NULLIF(glossary_sha256, '')) AS glossary_variant_count
         FROM ${TRANSLATION_MEMORY_TABLE}
        WHERE ${REVIEWED_ROW_PREDICATE}`
      )
      .get() as Record<string, unknown>;

    return {
      entry_count: Number(row.entry_count),
      namespace_count: Number(row.namespace_count),
      source_count: Number(row.source_count),
      language_pair_count: Number(row.language_pair_count),
      glossary_variant_count: Number(row.glossary_variant_count)
    };
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new HarnessError("translation_memory_closed", "Translation-memory database is closed");
    }
  }
}

function prepareTranslationMemoryEntry(input: TranslationMemoryUpsertInput): PreparedTranslationMemoryEntry {
  const key = keyForLookup(input);
  const targetText = requireText(input.targetText, "targetText");
  return { key, targetText, targetSha256: sha256Text(targetText) };
}

function entryKeyValues(key: TranslationMemoryKey): [string, string, string, string, string] {
  return [key.namespace, key.sourceSha256, key.sourceLang, key.targetLang, key.glossaryDbValue];
}

function normalizeReviewProvenance(input: unknown): TranslationMemoryReviewProvenance {
  if (!isRecord(input)) {
    throw new HarnessError(
      "invalid_translation_memory_review_provenance",
      "Reviewed translation-memory batch requires signed-review provenance"
    );
  }
  return {
    receiptId: requireReviewId(input.receiptId),
    receiptSha256: requireReviewDigest(input.receiptSha256, "receiptSha256"),
    reviewer: requireReviewer(input.reviewer),
    reviewPayloadSha256: requireReviewDigest(input.reviewPayloadSha256, "reviewPayloadSha256")
  };
}

function requireReviewId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    [...value].length > MAX_REVIEW_ID_LENGTH ||
    !SAFE_REVIEW_ID.test(value)
  ) {
    throw new HarnessError(
      "invalid_translation_memory_review_provenance",
      "receiptId must be a safe non-empty signed-review receipt identifier"
    );
  }
  return value;
}

function requireReviewDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new HarnessError(
      "invalid_translation_memory_review_provenance",
      `${field} must be a lowercase SHA-256 hex digest`
    );
  }
  return value;
}

function requireReviewer(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    [...value].length > MAX_REVIEWER_LENGTH
  ) {
    throw new HarnessError(
      "invalid_translation_memory_review_provenance",
      "reviewer must be a non-empty signed-review identity"
    );
  }
  return value;
}

function writeResult(row: Record<string, unknown>, inserted: boolean): TranslationMemoryUpsertResult {
  return {
    namespace: String(row.namespace),
    source_sha256: String(row.source_sha256),
    source_lang: String(row.source_lang),
    target_lang: String(row.target_lang),
    glossary_sha256: row.glossary_sha256 === "" ? null : String(row.glossary_sha256),
    target_sha256: String(row.target_sha256),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    inserted
  };
}

function reviewedWriteResult(
  row: Record<string, unknown>,
  inserted: boolean
): TranslationMemoryReviewedWriteResult {
  if (
    typeof row.review_receipt_id !== "string" ||
    typeof row.review_receipt_sha256 !== "string" ||
    typeof row.reviewer !== "string" ||
    typeof row.review_payload_sha256 !== "string"
  ) {
    throw new HarnessError(
      "translation_memory_write_failed",
      "Reviewed translation-memory write did not retain signed-review provenance"
    );
  }
  return {
    ...writeResult(row, inserted),
    review_receipt_id: row.review_receipt_id,
    review_receipt_sha256: row.review_receipt_sha256,
    reviewer: row.reviewer,
    review_payload_sha256: row.review_payload_sha256
  };
}

function ensureReviewProvenanceColumns(db: DatabaseSync): void {
  const columnNames = new Set(
    db.prepare(`PRAGMA table_info(${TRANSLATION_MEMORY_TABLE})`).all().map((row) => String(row.name))
  );
  const missingColumns = REVIEW_PROVENANCE_COLUMN_DEFINITIONS.filter(([name]) => !columnNames.has(name));
  if (missingColumns.length === 0) {
    return;
  }

  db.exec("BEGIN IMMEDIATE;");
  try {
    for (const [, definition] of missingColumns) {
      db.exec(`ALTER TABLE ${TRANSLATION_MEMORY_TABLE} ADD COLUMN ${definition};`);
    }
    db.exec("COMMIT;");
  } catch (error) {
    if (db.isTransaction) {
      db.exec("ROLLBACK;");
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeTranslationSource(sourceText: string): string {
  return requireText(sourceText, "sourceText").replace(/\r\n/g, "\n").normalize("NFC");
}

function keyForLookup(input: TranslationMemoryLookupInput): TranslationMemoryKey {
  const namespace = normalizeNamespace(input.namespace);
  const sourceText = normalizeTranslationSource(input.sourceText);
  const sourceLang = requireText(input.sourceLang, "sourceLang");
  const targetLang = requireText(input.targetLang, "targetLang");
  const glossarySha256 = normalizeGlossarySha256(input.glossarySha256);
  return {
    namespace,
    sourceText,
    sourceSha256: sha256Text(sourceText),
    sourceLang,
    targetLang,
    glossarySha256,
    glossaryDbValue: glossarySha256 ?? ""
  };
}

function normalizeNamespace(value: unknown): string {
  if (typeof value !== "string") {
    throw new HarnessError("invalid_translation_memory_namespace", "namespace must be a string");
  }
  const namespace = value.trim();
  if (namespace.length === 0) {
    throw new HarnessError("invalid_translation_memory_namespace", "namespace must not be empty");
  }
  if ([...namespace].length > MAX_NAMESPACE_LENGTH) {
    throw new HarnessError(
      "invalid_translation_memory_namespace",
      `namespace must be at most ${MAX_NAMESPACE_LENGTH} characters`
    );
  }
  return namespace;
}

function normalizeGlossarySha256(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new HarnessError("invalid_translation_memory_glossary", "glossarySha256 must be a SHA-256 hex digest");
  }
  return value.toLowerCase();
}

function requireText(value: string, field: string): string {
  if (typeof value !== "string") {
    throw new HarnessError("invalid_translation_memory_input", `${field} must be a string`);
  }
  if ((field === "sourceLang" || field === "targetLang") && value.trim().length === 0) {
    throw new HarnessError("invalid_translation_memory_input", `${field} must not be empty`);
  }
  if ((field === "sourceText" || field === "targetText") && value.trim().length === 0) {
    throw new HarnessError("invalid_translation_memory_input", `${field} must not be empty`);
  }
  return value;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function resolveSafeTranslationMemoryPath(options: TranslationMemoryOptions): SafeTranslationMemoryPath {
  if (!options || typeof options !== "object") {
    throw new HarnessError("invalid_translation_memory_path", "Translation-memory path options are required");
  }
  if (typeof options.allowedRoot !== "string" || options.allowedRoot.trim().length === 0) {
    throw new HarnessError("invalid_translation_memory_path", "allowedRoot must be an explicit non-empty path");
  }
  if (typeof options.dbPath !== "string" || options.dbPath.trim().length === 0) {
    throw new HarnessError("invalid_translation_memory_path", "dbPath must be an explicit non-empty path");
  }

  const allowedRoot = path.resolve(options.allowedRoot);
  const dbPath = path.isAbsolute(options.dbPath)
    ? path.resolve(options.dbPath)
    : path.resolve(allowedRoot, options.dbPath);

  if (!isWithin(allowedRoot, dbPath) || allowedRoot === dbPath) {
    throw new HarnessError(
      "translation_memory_path_outside_allowed_root",
      "Translation-memory database path must be a child of allowedRoot"
    );
  }
  if (isForbiddenSensitivePath(allowedRoot) || isForbiddenSensitivePath(dbPath)) {
    throw new HarnessError(
      "translation_memory_sensitive_path",
      "Translation-memory database path is within a forbidden sensitive path"
    );
  }

  try {
    fs.mkdirSync(allowedRoot, { recursive: true });
    const rootStat = fs.lstatSync(allowedRoot);
    if (!rootStat.isDirectory()) {
      throw new HarnessError("invalid_translation_memory_path", "allowedRoot must be a directory");
    }
    if (rootStat.isSymbolicLink()) {
      throw new HarnessError("translation_memory_symlink_path", "allowedRoot must not be a symbolic link");
    }

    const canonicalRoot = fs.realpathSync.native(allowedRoot);

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const canonicalParent = fs.realpathSync.native(path.dirname(dbPath));
    if (!isWithinOrEqual(canonicalRoot, canonicalParent)) {
      throw new HarnessError(
        "translation_memory_symlink_escape",
        "Translation-memory database path resolves outside allowedRoot"
      );
    }

    let dbStat: fs.Stats | undefined;
    try {
      dbStat = fs.lstatSync(dbPath);
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (dbStat) {
      if (dbStat.isSymbolicLink()) {
        throw new HarnessError("translation_memory_symlink_path", "Translation-memory database path must not be a symbolic link");
      }
      if (!dbStat.isFile()) {
        throw new HarnessError("invalid_translation_memory_path", "Translation-memory database path must be a file");
      }
    }

    const canonicalDbPath = path.join(canonicalParent, path.basename(dbPath));
    if (!isWithin(canonicalRoot, canonicalDbPath)) {
      throw new HarnessError(
        "translation_memory_symlink_escape",
        "Translation-memory database path resolves outside allowedRoot"
      );
    }
    return { dbPath: canonicalDbPath, allowedRoot: canonicalRoot };
  } catch (error) {
    if (error instanceof HarnessError) {
      throw error;
    }
    throw new HarnessError("invalid_translation_memory_path", "Unable to prepare translation-memory database path");
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isWithinOrEqual(root: string, candidate: string): boolean {
  return root === candidate || isWithin(root, candidate);
}

function isForbiddenSensitivePath(candidate: string): boolean {
  const segments = candidate
    .split(path.sep)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  if (segments.some((segment) => SENSITIVE_PATH_SEGMENTS.has(segment) || /^\.env(?:\.|$)/.test(segment))) {
    return true;
  }

  const basename = path.basename(candidate).toLowerCase();
  return (
    /^\.env(?:\.|$)/.test(basename) ||
    /^(?:passwd|shadow|authorized_keys|id_rsa|id_ed25519)$/.test(basename) ||
    /(?:credential|secret|token|password|private[_-]?key)/.test(basename)
  );
}
