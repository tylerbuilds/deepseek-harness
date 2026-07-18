# Heavy Corpus Workloads

The corpus runner is the durable workload plane for books, OCR, translations,
datasets, long-form writing and media catalogues. Its operating shape is:

`ingest -> plan -> start/work -> validate -> reconcile -> review`

Every job has a manifest, shard ledger, per-shard output and proof file, event
log, retry/quarantine state and a confined artefact directory. Source hashes
are verified again before work starts, so a changed book, scan or dataset fails
before producing mixed-provenance output. Completed shards use atomic local
checkpoints plus output/proof recovery, so a stale ledger after a process crash
does not blindly rerun expensive work.

Shard publication is crash-recoverable rather than a sequence of ordinary
writes. Output and proof bytes are written to confined same-directory temporary
files, flushed, and atomically published without clobbering unrelated files.
Recognised truncated remnants from an interrupted publication are quarantined
before deterministic reprocessing. Recovery also binds the proof processor to
the processor or OCR engine selected by the manifest.

## Workload entry points

| Workload | CLI builder | Processing lane |
| --- | --- | --- |
| Whole-book analysis | `corpus ingest-book` | DeepSeek fake, dry-run or approval-gated live batch |
| OCR image/PDF | `corpus ingest-ocr` | local focr, Tesseract or macOS Vision |
| Translation | `corpus ingest-translation` | DeepSeek batch plus glossary, placeholder and length-ratio QA |
| JSONL dataset | `corpus ingest-jsonl` | streaming, deterministic file-backed row shards |
| Long-form article/story | `corpus ingest-longform` | one generated shard per outline section plus minimum-word QA |
| Media catalogue | `corpus ingest-media` | local ffprobe metadata and streaming SHA-256 |

Builders return `{ "ok": true, "manifest": ... }`. Extract the manifest before
planning or starting it:

```bash
deepseek-harness corpus ingest-book book.txt \
  --project whole-book \
  --chunk-chars 12000 \
  --overlap-chars 1000 \
  --transport fake \
  --artifact-dir artifacts/corpus/whole-book \
  | jq '.manifest' > /tmp/whole-book.manifest.json

deepseek-harness corpus plan /tmp/whole-book.manifest.json
deepseek-harness corpus start /tmp/whole-book.manifest.json --enqueue-only
deepseek-harness corpus supervise --once --max-jobs-per-cycle 4 --max-iterations-per-job 10
deepseek-harness corpus validate <job_id> --artifact-dir artifacts/corpus/whole-book
deepseek-harness corpus reconcile <job_id> --artifact-dir artifacts/corpus/whole-book
```

Use `fake` to prove orchestration and `dry-run` to inspect the network plan.
Neither produces useful model prose. A real DeepSeek corpus uses
`--transport deepseek`, `external_inference_allowed`, a bounded token/cost
configuration, an owner-signed one-use receipt and the explicit live flag.

Local, fake and dry-run jobs churn across bounded batches. The manifest defaults
to 25 shards and 16 MiB of rendered prompt plus system-prompt bytes per batch;
the hard limits are 1,000 shards and 64 MiB. An individual file-backed shard is
also capped at 64 MiB and must carry both source and shard SHA-256 provenance.

JSONL ingestion reads in 64 KiB chunks, validates UTF-8 and JSON one record at a
time, and stores byte/row ranges rather than duplicating records into the
manifest. It allows at most 10,000 shards and 16 MiB per JSONL record.

Builder limits are checked before shard arrays or overlapped text are
materialised:

| Builder | Source/input cap | Fan-out/materialisation cap |
| --- | --- | --- |
| Text | 64 MiB UTF-8 file | 10,000 shards; 128 MiB overlapped manifest text |
| Book | 64 MiB UTF-8 file | 10,000 shards; 128 MiB overlapped manifest text |
| Translation | 64 MiB UTF-8 source | 10,000 shards; 128 MiB overlapped manifest text |
| Long-form | 16 MiB JSON outline | 10,000 sections; 128 MiB manifest text |
| OCR | streamed PDF/image source | 10,000 page shards |
| Media | streamed directory walk and file hashes | 1,000 files by default; 10,000 maximum |

These are admission ceilings, not claims that a single Mac process should run
at every ceiling. Batch limits, free-space preflight and bounded supervision
still determine how much work is active at once.

## OCR

```bash
deepseek-harness corpus ingest-ocr scanned-book.pdf \
  --project scanned-book \
  --engine auto \
  --language en-GB \
  --artifact-dir artifacts/corpus/scanned-book \
  | jq '.manifest' > /tmp/scanned-book.manifest.json
```

`auto` selects installed `focr`, then Tesseract, then macOS Vision. PDF manifests
contain one 1-based shard per page, up to 10,000 pages. PDF hashing is streamed, page count is read
through `pdfinfo` or PDFKit, and the macOS Vision helper is compiled once into a
script-hash cache rather than once per page. Explicit unavailable engines fail
closed. This lane performs text recognition; it does not rewrite or optimise the
source PDF.

## Translation and reviewed memory

```bash
deepseek-harness corpus ingest-translation source.txt \
  --project handbook-fr \
  --source-lang en \
  --target-lang fr \
  --glossary examples/translation-glossary.json \
  --translation-memory translation-memory/handbook.sqlite \
  --transport fake \
  --artifact-dir artifacts/corpus/handbook-fr \
  | jq '.manifest' > /tmp/handbook-fr.manifest.json
```

The translation-memory path is relative to
`DEEPSEEK_HARNESS_ARTIFACT_DIR` unless an absolute path under that root is
supplied. Exact reviewed hits bypass inference. New output must pass language,
placeholder, glossary and length-ratio checks before reconciliation. It enters
memory only through the explicit reviewed gate:

```bash
deepseek-harness corpus validate <job_id> --artifact-dir artifacts/corpus/handbook-fr
deepseek-harness corpus translation-review-packet <job_id> \
  --artifact-dir artifacts/corpus/handbook-fr > /tmp/handbook-fr-review-packet.json

# A separate owner-controlled signer reviews the packet and emits a short-lived
# deepseek-harness.translation-review-receipt.v1 receipt bound to its digest.
export DEEPSEEK_HARNESS_TRANSLATION_REVIEW_PUBLIC_KEY="$(cat /secure/path/reviewer-public-key.pem)"
deepseek-harness corpus commit-translation-memory <job_id> \
  --artifact-dir artifacts/corpus/handbook-fr \
  --review-receipt /secure/path/handbook-fr-review-receipt.json
```

The receipt binds the job, project namespace, confined SQLite path, language
pair, glossary digest and every reviewed source/target hash. The signature is
verified with Ed25519 and is never persisted. Commit holds the per-job worker
lock and re-hashes the exact source and target strings it will upsert against
the signed entries, closing the review-to-write race. All entries covered by one
review payload are committed in one SQLite transaction. Rows without complete
review provenance are never returned as translation-memory hits. The project is
the translation memory namespace, so identical text cannot bleed across
projects. The harness does not claim human review merely because automatic QA
passed.

## Long-form authoring

```bash
deepseek-harness corpus ingest-longform examples/longform-outline.json \
  --project durable-work-handbook \
  --minimum-words-per-section 800 \
  --transport fake \
  --artifact-dir artifacts/corpus/durable-work-handbook \
  | jq '.manifest' > /tmp/durable-work-handbook.manifest.json
```

The builder creates one deterministic shard per outline section and carries the
title, audience, voice and section brief into each prompt. Validation blocks a
section below the configured word floor. Continuity and citation policy remain
review criteria; they are not falsely presented as machine-proven quality.

## Media catalogue

```bash
deepseek-harness corpus ingest-media media-library \
  --project media-library \
  --recursive \
  --max-files 5000 \
  | jq '.manifest' > /tmp/media-library.manifest.json
```

The builder rejects symlinks, sorts files deterministically, streams hashes and
stores curated ffprobe fields without copying raw media or ffprobe filename/tag
payloads into catalogue records. Directory entries are walked without loading
an entire tree listing into memory. It deliberately catalogues media; transcoding,
renaming, deletion and publishing are outside this adapter.

## Corpus approval packet

For a live `deepseek_batch` corpus, generate the exact packet after the final
manifest is frozen:

```bash
deepseek-harness corpus approval-packet /tmp/whole-book.manifest.json
deepseek-harness corpus plan /tmp/whole-book.manifest.json --allow-live
```

The packet binds the rendered shard prompts, item count, model, egress class,
concurrency and cost cap. It does not sign or approve itself.

A live corpus must fit one count-and-byte-bounded batch and execute immediately
with `--allow-live`. Live `--enqueue-only`, live supervisor execution and
multi-batch reuse of one receipt are rejected. Split larger live work into
separate corpus jobs, freeze each payload and obtain a distinct signed receipt
for each job. This is deliberate: the harness never stores reusable live
authority. Privacy lane, API-key presence, exact signed authority and execution
flags are all checked before the corpus manifest or ledger is created.

## Persistent supervisor on macOS

`corpus supervise` is bounded in-process. Each cycle selects at most 1,000 jobs
and the report retains only the latest ten cycles while preserving aggregate
failure state. A confined, atomically persisted round-robin cursor advances
before processing, so repeatedly broken early-sorting jobs cannot starve later
healthy jobs. The checked-in launchd example keeps restarting bounded
10,000-cycle runs and uses both a supervisor lock and per-job worker locks.
Well-formed locks owned by dead processes are reclaimed; malformed or live locks
remain blocked for operator inspection.

Review before installing:

```bash
cp ops/launchd/io.github.deepseek-harness-corpus-supervisor.plist.example \
  "$HOME/Library/LaunchAgents/io.github.deepseek-harness-corpus-supervisor.plist"

# Replace the four __DEEPSEEK_HARNESS_*__ placeholders in the copied file with
# absolute paths for this checkout before loading it.
plutil -lint "$HOME/Library/LaunchAgents/io.github.deepseek-harness-corpus-supervisor.plist"
launchctl bootstrap "gui/$UID" "$HOME/Library/LaunchAgents/io.github.deepseek-harness-corpus-supervisor.plist"
```

The supervisor reports live DeepSeek ledgers as `deferred_job_ids` without
mutating their ledgers or consuming retries. Supplying `--allow-live` to the
supervisor is rejected. Run an individually signed, single-batch live job
directly with `corpus start ... --allow-live`.

External processes are bounded too: ffprobe has a 60-second timeout and 8 MiB
buffer, OCR/PDF/Swift tools have phase-specific timeouts and bounded buffers,
and DeepSeek HTTP requests default to a 120-second abort deadline.

The repository does not install or bootstrap launchd automatically.
