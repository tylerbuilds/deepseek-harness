import test from "node:test";
import assert from "node:assert/strict";
import { validateCorpusWorkload } from "../src/corpus_validation.js";

test("blocks book reading shards without chapter or page bounds", () => {
  assert.deepEqual(
    validateCorpusWorkload({
      workload_type: "book_reading",
      shards: [
        { id: "chapter-1", bounds: { chapter: 1 } },
        { id: "pages-2-3", bounds: { page_start: 2, page_end: 3 } },
        { id: "missing-bounds" }
      ]
    }),
    ["book_reading_missing_chapter_or_page_bounds:missing-bounds"]
  );
});

test("blocks dataset transform shards with missing row bounds and row count mismatches", () => {
  assert.deepEqual(
    validateCorpusWorkload({
      workload_type: "dataset_transform",
      shards: [
        { id: "rows-ok", bounds: { row_start: 10, row_end: 12, row_count: 3 } },
        { id: "rows-missing-end", bounds: { row_start: 13 } },
        { id: "rows-mismatch", bounds: { row_start: 20, row_end: 25, row_count: 4 } }
      ]
    }),
    [
      "dataset_transform_missing_row_bounds:rows-missing-end",
      "dataset_transform_row_count_mismatch:rows-mismatch:expected:6:actual:4"
    ]
  );
});

test("checks workload fields on ledger-like shard records", () => {
  assert.deepEqual(
    validateCorpusWorkload({
      workload_type: "dataset_transform",
      ledgerShards: [
        { shard_id: "ledger-row-batch", bounds: { row_start: 1, row_end: 2 }, row_count: 3 }
      ]
    }),
    ["dataset_transform_row_count_mismatch:ledger-row-batch:expected:2:actual:3"]
  );
});

test("blocks incomplete media catalogue sidecars when sidecar fields are present", () => {
  assert.deepEqual(
    validateCorpusWorkload({
      workload_type: "media_catalogue",
      shards: [
        { id: "media-ok", sidecar: { duration_seconds: 12.5, sha256: "abc" } },
        { id: "media-no-sidecar" },
        { id: "media-missing-duration", sidecar: { sha256: "abc" } },
        { id: "media-missing-hash", sidecar: { duration_ms: 900 } }
      ]
    }),
    ["media_catalogue_missing_duration:media-missing-duration", "media_catalogue_missing_hash:media-missing-hash"]
  );
});

test("blocks incomplete translation language bounds when bounds are present", () => {
  assert.deepEqual(
    validateCorpusWorkload({
      workload_type: "translation",
      shards: [
        { id: "translation-ok", bounds: { source_lang: "en", target_lang: "fr" } },
        { id: "translation-no-bounds" },
        { id: "translation-missing-source", bounds: { target_lang: "cy" } },
        { id: "translation-missing-target", bounds: { source_lang: "en" } }
      ]
    }),
    [
      "translation_missing_source_lang:translation-missing-source",
      "translation_missing_target_lang:translation-missing-target"
    ]
  );
});

test("ignores workloads without specialised postconditions", () => {
  assert.deepEqual(
    validateCorpusWorkload({
      workload_type: "ocr",
      shards: [{ id: "image-1" }]
    }),
    []
  );
});
