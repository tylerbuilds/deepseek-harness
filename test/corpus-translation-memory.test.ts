import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  commitReviewedTranslationMemoryBatch,
  lookupTranslationMemory,
  openTranslationMemory,
  translationMemoryStats,
  upsertUnreviewedTranslationMemoryForTest
} from "../src/corpus_translation_memory.js";

const REVIEW_PROVENANCE = {
  receiptId: "review-receipt-0001",
  receiptSha256: "c".repeat(64),
  reviewer: "owner-reviewer",
  reviewPayloadSha256: "d".repeat(64)
} as const;

function temporaryRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-translation-memory-"));
}

test("normalised exact source text returns a target only on a hit", () => {
  const allowedRoot = temporaryRoot();
  const memory = openTranslationMemory({
    allowedRoot,
    dbPath: path.join(allowedRoot, "memory.sqlite")
  });
  try {
    commitReviewedTranslationMemoryBatch(memory, {
      provenance: REVIEW_PROVENANCE,
      entries: [{
        namespace: "fixture",
        sourceText: "Hello\r\nworld",
        sourceLang: "en",
        targetLang: "fr",
        targetText: "Bonjour\nmonde"
      }]
    });

    const hit = lookupTranslationMemory(memory, {
      namespace: "fixture",
      sourceText: "Hello\nworld",
      sourceLang: "en",
      targetLang: "fr"
    });
    assert.equal(hit.hit, true);
    if (hit.hit) {
      assert.equal(hit.target_text, "Bonjour\nmonde");
      assert.match(hit.source_sha256, /^[a-f0-9]{64}$/);
    }

    const miss = lookupTranslationMemory(memory, {
      namespace: "fixture",
      sourceText: "Hello\nthere",
      sourceLang: "en",
      targetLang: "fr"
    });
    assert.equal(miss.hit, false);
    assert.equal("target_text" in miss, false);
    assert.equal("source_text" in miss, false);
  } finally {
    memory.close();
  }
});

test("language and glossary values remain separate exact-match dimensions", () => {
  const allowedRoot = temporaryRoot();
  const memory = openTranslationMemory({ allowedRoot, dbPath: "memory.sqlite" });
  try {
    const glossaryA = "a".repeat(64);
    const glossaryB = "b".repeat(64);
    commitReviewedTranslationMemoryBatch(memory, {
      provenance: REVIEW_PROVENANCE,
      entries: [
        {
          namespace: "fixture",
          sourceText: "Same source",
          sourceLang: "en",
          targetLang: "fr",
          glossarySha256: glossaryA,
          targetText: "Glossary A"
        },
        {
          namespace: "fixture",
          sourceText: "Same source",
          sourceLang: "en",
          targetLang: "de",
          glossarySha256: glossaryA,
          targetText: "German"
        },
        {
          namespace: "fixture",
          sourceText: "Same source",
          sourceLang: "en",
          targetLang: "fr",
          glossarySha256: glossaryB,
          targetText: "Glossary B"
        }
      ]
    });

    const german = lookupTranslationMemory(memory, {
      namespace: "fixture",
      sourceText: "Same source",
      sourceLang: "en",
      targetLang: "de",
      glossarySha256: glossaryA
    });
    assert.equal(german.hit, true);
    if (german.hit) assert.equal(german.target_text, "German");

    const wrongGlossary = lookupTranslationMemory(memory, {
      namespace: "fixture",
      sourceText: "Same source",
      sourceLang: "en",
      targetLang: "fr",
      glossarySha256: glossaryB
    });
    assert.equal(wrongGlossary.hit, true);
    if (wrongGlossary.hit) assert.equal(wrongGlossary.target_text, "Glossary B");

    const noGlossary = lookupTranslationMemory(memory, {
      namespace: "fixture",
      sourceText: "Same source",
      sourceLang: "en",
      targetLang: "fr"
    });
    assert.equal(noGlossary.hit, false);
  } finally {
    memory.close();
  }
});

test("reviewed batch commit is idempotent for a key and updates the reviewed target", () => {
  const allowedRoot = temporaryRoot();
  const memory = openTranslationMemory({ allowedRoot, dbPath: "memory.sqlite" });
  try {
    const [first] = commitReviewedTranslationMemoryBatch(memory, {
      provenance: REVIEW_PROVENANCE,
      entries: [{
        namespace: "fixture",
        sourceText: "Review me",
        sourceLang: "en",
        targetLang: "cy",
        targetText: "Adolyga fi"
      }]
    });
    const [second] = commitReviewedTranslationMemoryBatch(memory, {
      provenance: REVIEW_PROVENANCE,
      entries: [{
        namespace: "fixture",
        sourceText: "Review me",
        sourceLang: "en",
        targetLang: "cy",
        targetText: "Adolyga fi eto"
      }]
    });
    assert.equal(first?.inserted, true);
    assert.equal(second?.inserted, false);
    assert.equal(translationMemoryStats(memory).entry_count, 1);

    const hit = lookupTranslationMemory(memory, {
      namespace: "fixture",
      sourceText: "Review me",
      sourceLang: "en",
      targetLang: "cy"
    });
    assert.equal(hit.hit, true);
    if (hit.hit) assert.equal(hit.target_text, "Adolyga fi eto");
  } finally {
    memory.close();
  }
});

test("namespace isolates identical keys and prevents cross-project overwrite", () => {
  const allowedRoot = temporaryRoot();
  const memory = openTranslationMemory({ allowedRoot, dbPath: "memory.sqlite" });
  try {
    const [projectA] = commitReviewedTranslationMemoryBatch(memory, {
      provenance: REVIEW_PROVENANCE,
      entries: [{
        namespace: "project-a",
        sourceText: "Same source",
        sourceLang: "en",
        targetLang: "fr",
        targetText: "Projet A"
      }]
    });
    const [projectB] = commitReviewedTranslationMemoryBatch(memory, {
      provenance: REVIEW_PROVENANCE,
      entries: [{
        namespace: "project-b",
        sourceText: "Same source",
        sourceLang: "en",
        targetLang: "fr",
        targetText: "Projet B"
      }]
    });
    assert.equal(projectA?.namespace, "project-a");
    assert.equal(projectB?.namespace, "project-b");
    assert.equal(projectA?.inserted, true);
    assert.equal(projectB?.inserted, true);

    const [updatedA] = commitReviewedTranslationMemoryBatch(memory, {
      provenance: REVIEW_PROVENANCE,
      entries: [{
        namespace: "project-a",
        sourceText: "Same source",
        sourceLang: "en",
        targetLang: "fr",
        targetText: "Projet A révise"
      }]
    });
    assert.equal(updatedA?.inserted, false);

    const hitA = lookupTranslationMemory(memory, {
      namespace: "project-a",
      sourceText: "Same source",
      sourceLang: "en",
      targetLang: "fr"
    });
    const hitB = lookupTranslationMemory(memory, {
      namespace: "project-b",
      sourceText: "Same source",
      sourceLang: "en",
      targetLang: "fr"
    });
    assert.equal(hitA.hit, true);
    assert.equal(hitB.hit, true);
    if (hitA.hit) assert.equal(hitA.target_text, "Projet A révise");
    if (hitB.hit) assert.equal(hitB.target_text, "Projet B");

    assert.deepEqual(translationMemoryStats(memory), {
      entry_count: 2,
      namespace_count: 2,
      source_count: 1,
      language_pair_count: 1,
      glossary_variant_count: 0
    });
  } finally {
    memory.close();
  }
});

test("does not reinterpret legacy unnamespaced rows when opening a v2 database", () => {
  const allowedRoot = temporaryRoot();
  const dbPath = path.join(allowedRoot, "memory.sqlite");
  const legacyDb = new DatabaseSync(dbPath);
  try {
    legacyDb.exec(`
      CREATE TABLE translation_memory (
        source_sha256 TEXT NOT NULL,
        source_lang TEXT NOT NULL,
        target_lang TEXT NOT NULL,
        glossary_sha256 TEXT NOT NULL DEFAULT '',
        source_text TEXT NOT NULL,
        target_text TEXT NOT NULL,
        target_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source_sha256, source_lang, target_lang, glossary_sha256)
      );
      INSERT INTO translation_memory (
        source_sha256, source_lang, target_lang, glossary_sha256,
        source_text, target_text, target_sha256, created_at, updated_at
      ) VALUES (
        '${"a".repeat(64)}', 'en', 'fr', '', 'Legacy source', 'Legacy target',
        '${"b".repeat(64)}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);
  } finally {
    legacyDb.close();
  }

  const memory = openTranslationMemory({ allowedRoot, dbPath });
  try {
    const legacyLookup = lookupTranslationMemory(memory, {
      namespace: "legacy-project",
      sourceText: "Legacy source",
      sourceLang: "en",
      targetLang: "fr"
    });
    assert.equal(legacyLookup.hit, false);

    const [inserted] = commitReviewedTranslationMemoryBatch(memory, {
      provenance: REVIEW_PROVENANCE,
      entries: [{
        namespace: "legacy-project",
        sourceText: "Legacy source",
        sourceLang: "en",
        targetLang: "fr",
        targetText: "New namespaced target"
      }]
    });
    assert.equal(inserted?.inserted, true);
    assert.equal(translationMemoryStats(memory).entry_count, 1);
  } finally {
    memory.close();
  }

  const verifyDb = new DatabaseSync(dbPath);
  try {
    const legacyRow = verifyDb
      .prepare("SELECT target_text FROM translation_memory WHERE source_text = ?")
      .get("Legacy source") as { target_text: string } | undefined;
    assert.equal(legacyRow?.target_text, "Legacy target");
    const v2Count = verifyDb
      .prepare("SELECT COUNT(*) AS count FROM translation_memory_v2")
      .get() as { count: number };
    assert.equal(Number(v2Count.count), 1);
  } finally {
    verifyDb.close();
  }
});

test("rejects traversal, sensitive paths, and symlink escapes", () => {
  const allowedRoot = temporaryRoot();
  assert.throws(
    () => openTranslationMemory({ allowedRoot, dbPath: path.join(allowedRoot, "..", "escape.sqlite") }),
    /child of allowedRoot/
  );
  assert.throws(
    () => openTranslationMemory({ allowedRoot, dbPath: path.join(allowedRoot, ".ssh", "memory.sqlite") }),
    /forbidden sensitive path/
  );

  const outside = temporaryRoot();
  const link = path.join(allowedRoot, "linked");
  fs.symlinkSync(outside, link, "dir");
  assert.throws(
    () => openTranslationMemory({ allowedRoot, dbPath: path.join(link, "memory.sqlite") }),
    /outside allowedRoot/
  );
});

test("rejects empty source and reviewed target text", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-translation-memory-"));
  const memory = openTranslationMemory({ dbPath: "memory.sqlite", allowedRoot: root });
  try {
    assert.throws(
      () => memory.lookup({ namespace: "fixture", sourceText: " ", sourceLang: "en", targetLang: "fr" }),
      /sourceText must not be empty/
    );
    assert.throws(
      () => commitReviewedTranslationMemoryBatch(memory, {
        provenance: REVIEW_PROVENANCE,
        entries: [{ namespace: "fixture", sourceText: "Hello", targetText: " ", sourceLang: "en", targetLang: "fr" }]
      }),
      /targetText must not be empty/
    );
    assert.throws(
      () => memory.lookup({ namespace: " ", sourceText: "Hello", sourceLang: "en", targetLang: "fr" }),
      /namespace must not be empty/
    );
    assert.throws(
      () => memory.lookup({ namespace: "n".repeat(129), sourceText: "Hello", sourceLang: "en", targetLang: "fr" }),
      /namespace must be at most 128 characters/
    );
  } finally {
    memory.close();
  }
});

test("unsigned setup rows are never returned as reviewed hits", () => {
  // Given: an unsigned row written through the explicit test/setup API.
  const allowedRoot = temporaryRoot();
  const memory = openTranslationMemory({ allowedRoot, dbPath: "memory.sqlite" });
  try {
    upsertUnreviewedTranslationMemoryForTest(memory, {
      namespace: "fixture",
      sourceText: "Unsigned source",
      sourceLang: "en",
      targetLang: "fr",
      targetText: "Unsigned target"
    });

    // When: production lookup asks for the exact key.
    const result = lookupTranslationMemory(memory, {
      namespace: "fixture",
      sourceText: "Unsigned source",
      sourceLang: "en",
      targetLang: "fr"
    });

    // Then: the unsigned row is neither a hit nor counted as trusted memory.
    assert.equal(result.hit, false);
    assert.equal(translationMemoryStats(memory).entry_count, 0);
  } finally {
    memory.close();
  }
});

test("reviewed batch hits expose complete signed-review provenance", () => {
  // Given: one entry committed with validated signed-review provenance.
  const allowedRoot = temporaryRoot();
  const memory = openTranslationMemory({ allowedRoot, dbPath: "memory.sqlite" });
  try {
    commitReviewedTranslationMemoryBatch(memory, {
      provenance: REVIEW_PROVENANCE,
      entries: [{
        namespace: "fixture",
        sourceText: "Reviewed source",
        sourceLang: "en",
        targetLang: "fr",
        targetText: "Reviewed target"
      }]
    });

    // When: production lookup asks for that reviewed key.
    const result = lookupTranslationMemory(memory, {
      namespace: "fixture",
      sourceText: "Reviewed source",
      sourceLang: "en",
      targetLang: "fr"
    });

    // Then: the hit carries every provenance field needed to audit the signed review.
    assert.equal(result.hit, true);
    if (result.hit) {
      assert.equal(result.target_text, "Reviewed target");
      assert.equal(result.review_receipt_id, REVIEW_PROVENANCE.receiptId);
      assert.equal(result.review_receipt_sha256, REVIEW_PROVENANCE.receiptSha256);
      assert.equal(result.reviewer, REVIEW_PROVENANCE.reviewer);
      assert.equal(result.review_payload_sha256, REVIEW_PROVENANCE.reviewPayloadSha256);
    }
  } finally {
    memory.close();
  }
});

test("reviewed batch rolls back every entry when a later SQLite write fails", () => {
  // Given: a real SQLite trigger which rejects the second entry in a two-entry batch.
  const allowedRoot = temporaryRoot();
  const memory = openTranslationMemory({ allowedRoot, dbPath: "memory.sqlite" });
  try {
    memory.db.exec(`
      CREATE TRIGGER reject_second_reviewed_entry
      BEFORE INSERT ON translation_memory_v2
      WHEN NEW.source_text = 'Reject this entry'
      BEGIN
        SELECT RAISE(ABORT, 'forced reviewed batch failure');
      END;
    `);

    // When: the reviewed set reaches the failing second write.
    assert.throws(
      () => commitReviewedTranslationMemoryBatch(memory, {
        provenance: REVIEW_PROVENANCE,
        entries: [
          {
            namespace: "fixture",
            sourceText: "First entry",
            sourceLang: "en",
            targetLang: "fr",
            targetText: "Premiere entree"
          },
          {
            namespace: "fixture",
            sourceText: "Reject this entry",
            sourceLang: "en",
            targetLang: "fr",
            targetText: "Entree rejetee"
          }
        ]
      }),
      /forced reviewed batch failure/
    );

    // Then: SQLite contains no partial first entry from the failed reviewed set.
    const row = memory.db.prepare("SELECT COUNT(*) AS count FROM translation_memory_v2").get();
    assert.equal(Number(row?.count), 0);
  } finally {
    memory.close();
  }
});

test("opening an existing v2 table migrates provenance columns and distrusts its unsigned rows", () => {
  // Given: a pre-provenance v2 database containing an exact unsigned row.
  const allowedRoot = temporaryRoot();
  const dbPath = path.join(allowedRoot, "memory.sqlite");
  const sourceText = "Existing unsigned v2 source";
  const sourceSha256 = createHash("sha256").update(sourceText, "utf8").digest("hex");
  const existingDb = new DatabaseSync(dbPath);
  try {
    existingDb.exec(`
      CREATE TABLE translation_memory_v2 (
        namespace TEXT NOT NULL,
        source_sha256 TEXT NOT NULL,
        source_lang TEXT NOT NULL,
        target_lang TEXT NOT NULL,
        glossary_sha256 TEXT NOT NULL DEFAULT '',
        source_text TEXT NOT NULL,
        target_text TEXT NOT NULL,
        target_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace, source_sha256, source_lang, target_lang, glossary_sha256)
      ) WITHOUT ROWID;
      INSERT INTO translation_memory_v2 (
        namespace, source_sha256, source_lang, target_lang, glossary_sha256,
        source_text, target_text, target_sha256, created_at, updated_at
      ) VALUES (
        'fixture', '${sourceSha256}', 'en', 'fr', '', '${sourceText}', 'Unsigned target',
        '${"e".repeat(64)}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);
  } finally {
    existingDb.close();
  }

  // When: the current adapter opens and looks up the old row.
  const memory = openTranslationMemory({ allowedRoot, dbPath });
  try {
    const result = lookupTranslationMemory(memory, {
      namespace: "fixture",
      sourceText,
      sourceLang: "en",
      targetLang: "fr"
    });

    // Then: migration is present but the unsigned legacy row remains untrusted.
    assert.equal(result.hit, false);
    const columnNames = memory.db
      .prepare("PRAGMA table_info(translation_memory_v2)")
      .all()
      .map((row) => String(row.name));
    assert.deepEqual(
      ["review_receipt_id", "review_receipt_sha256", "reviewer", "review_payload_sha256"].every((name) =>
        columnNames.includes(name)
      ),
      true
    );
  } finally {
    memory.close();
  }
});
