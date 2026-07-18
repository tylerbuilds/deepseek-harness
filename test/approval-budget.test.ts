import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  networkPayloadDigest,
  receiptDigest,
  receiptSigningPayload
} from "../src/approval.js";
import { estimateManifestReservation } from "../src/budget.js";
import { HarnessError } from "../src/errors.js";
import { getStatus, processRun, submitManifest } from "../src/runner.js";
import { buildExecutionPlan, parseManifest, type ApprovalReceipt, type RunManifest } from "../src/schema.js";
import { HarnessStore } from "../src/store.js";
import { DeepSeekLiveTransport } from "../src/transport.js";

const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

function baseManifest(overrides: Record<string, unknown> = {}): RunManifest {
  return parseManifest({
    schema_version: "deepseek-harness.run.v1",
    project: "signed-unit",
    egress_class: "non_sensitive_bulk",
    transport: "deepseek",
    model: "deepseek-v4-flash",
    max_tokens: 128,
    concurrency: 1,
    cost_cap_usd: 0.02,
    canonical_writes: false,
    external_side_effects: false,
    items: [{ id: "a", prompt: "Return the word READY." }],
    ...overrides
  });
}

function signedReceipt(manifest: RunManifest, overrides: Partial<ApprovalReceipt> = {}): ApprovalReceipt {
  const now = Date.now();
  const unsigned: ApprovalReceipt = {
    schema_version: "deepseek-harness.inference-receipt.v1",
    receipt_id: `receipt-${now}-${Math.random().toString(16).slice(2)}`,
    status: "approved",
    issuer: "owner",
    issued_at: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + 10 * 60_000).toISOString(),
    nonce: `nonce-${Math.random().toString(36).slice(2)}-1234567890`,
    provider: "deepseek",
    model: manifest.model,
    network_payload_sha256: networkPayloadDigest(manifest),
    egress_class: "non_sensitive_bulk",
    max_items: manifest.items.length,
    max_concurrency: manifest.concurrency,
    max_cost_usd: manifest.cost_cap_usd,
    daily_cost_cap_usd: 0.1,
    rate_snapshot: {
      id: "operator-rate-fixture-v1",
      input_usd_per_million: 1,
      output_usd_per_million: 10
    },
    signature_base64: "pending-signature",
    ...overrides
  };
  return {
    ...unsigned,
    signature_base64: sign(null, Buffer.from(receiptSigningPayload(unsigned)), keys.privateKey).toString("base64")
  };
}

function authorisedManifest(overrides: Record<string, unknown> = {}): RunManifest {
  const manifest = baseManifest(overrides);
  return parseManifest({ ...manifest, approval_receipt: signedReceipt(manifest) });
}

test("valid owner signature binds the exact payload, model and budget", () => {
  const manifest = authorisedManifest();
  const plan = buildExecutionPlan(manifest, {
    mode: "execute",
    allowLive: true,
    apiKeyPresent: true,
    approvalPublicKey: publicKeyPem
  });

  assert.equal(plan.ok, true, plan.blockers.join(","));
  assert.equal(plan.approval.network_payload_sha256, manifest.approval_receipt?.network_payload_sha256);
  assert.equal(plan.budget_reservation?.rate_snapshot_id, "operator-rate-fixture-v1");
  assert.ok(Number(plan.budget_reservation?.reserved_usd) > 0);
});

test("receipt fails closed after payload change, expiry or signature tampering", () => {
  const original = authorisedManifest();
  const changed = parseManifest({
    ...original,
    items: [{ id: "a", prompt: "Return the word CHANGED." }]
  });
  const changedPlan = buildExecutionPlan(changed, {
    mode: "execute",
    allowLive: true,
    apiKeyPresent: true,
    approvalPublicKey: publicKeyPem
  });
  assert.equal(changedPlan.ok, false);
  assert.ok(changedPlan.blockers.includes("approval_receipt_payload_digest_mismatch"));

  const base = baseManifest();
  const expired = parseManifest({
    ...base,
    approval_receipt: signedReceipt(base, {
      issued_at: "2026-01-01T00:00:00.000Z",
      expires_at: "2026-01-01T00:05:00.000Z"
    })
  });
  const expiredPlan = buildExecutionPlan(expired, {
    mode: "execute",
    allowLive: true,
    apiKeyPresent: true,
    approvalPublicKey: publicKeyPem,
    now: new Date("2026-01-01T00:06:00.000Z")
  });
  assert.ok(expiredPlan.blockers.includes("approval_receipt_expired"));

  const tampered = parseManifest({
    ...original,
    approval_receipt: { ...original.approval_receipt, signature_base64: Buffer.alloc(64, 1).toString("base64") }
  });
  const tamperedPlan = buildExecutionPlan(tampered, {
    mode: "execute",
    allowLive: true,
    apiKeyPresent: true,
    approvalPublicKey: publicKeyPem
  });
  assert.ok(tamperedPlan.blockers.includes("approval_receipt_signature_invalid"));

  const modelChanged = parseManifest({ ...original, model: "deepseek-v4-pro" });
  const modelPlan = buildExecutionPlan(modelChanged, {
    mode: "execute",
    allowLive: true,
    apiKeyPresent: true,
    approvalPublicKey: publicKeyPem
  });
  assert.ok(modelPlan.blockers.includes("approval_receipt_model_mismatch"));

  const egressChanged = parseManifest({ ...original, egress_class: "local_private" });
  const egressPlan = buildExecutionPlan(egressChanged, {
    mode: "execute",
    allowLive: true,
    apiKeyPresent: true,
    approvalPublicKey: publicKeyPem
  });
  assert.ok(egressPlan.blockers.includes("approval_receipt_egress_mismatch"));

  const costChanged = parseManifest({ ...original, cost_cap_usd: original.approval_receipt!.max_cost_usd + 0.01 });
  const costPlan = buildExecutionPlan(costChanged, {
    mode: "execute",
    allowLive: true,
    apiKeyPresent: true,
    approvalPublicKey: publicKeyPem
  });
  assert.ok(costPlan.blockers.includes("approval_receipt_run_cost_cap_exceeded"));
});

test("SQLite receipt consumption is one-use and the daily budget is accumulated atomically", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-receipt-"));
  const store = new HarnessStore(path.join(root, ".state"));
  try {
    const first = authorisedManifest({ run_id: "run-one" });
    const firstReceipt = first.approval_receipt!;
    const estimate = estimateManifestReservation(first, firstReceipt);
    store.createRun("run-one", first, path.join(root, "run-one"));
    store.authoriseAndReserveLiveRun(
      "run-one",
      firstReceipt,
      receiptDigest(firstReceipt),
      estimate,
      networkPayloadDigest(first)
    );
    assert.equal(store.budgetStatus("run-one")?.status, "reserved");

    const replay = parseManifest({ ...first, run_id: "run-replay" });
    store.createRun("run-replay", replay, path.join(root, "run-replay"));
    assert.throws(
      () => store.authoriseAndReserveLiveRun(
        "run-replay",
        firstReceipt,
        receiptDigest(firstReceipt),
        estimate,
        networkPayloadDigest(replay)
      ),
      (error: unknown) => error instanceof HarnessError && error.code === "approval_receipt_replayed"
    );

    const secondBase = baseManifest({ run_id: "run-two" });
    const secondReceipt = signedReceipt(secondBase, {
      daily_cost_cap_usd: Number((estimate.reserved_usd * 1.5).toFixed(8))
    });
    const second = parseManifest({ ...secondBase, approval_receipt: secondReceipt });
    store.createRun("run-two", second, path.join(root, "run-two"));
    assert.throws(
      () => store.authoriseAndReserveLiveRun(
        "run-two",
        secondReceipt,
        receiptDigest(secondReceipt),
        estimateManifestReservation(second, secondReceipt),
        networkPayloadDigest(second)
      ),
      (error: unknown) => error instanceof HarnessError && error.code === "daily_budget_exhausted"
    );

    store.reconcileBudget("run-one", null);
    assert.equal(store.budgetStatus("run-one")?.status, "retained_conservative");
    assert.equal(store.budgetStatus("run-one")?.charged_usd, store.budgetStatus("run-one")?.reserved_usd);
  } finally {
    store.close();
  }
});

test("live transport rescans outbound payload and sanitises provider errors", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    };
    const secretManifest = baseManifest({
      items: [{ id: "a", prompt: ["api", "_key", " = ", "abcDEF0123456789", "abcDEF0123456789"].join("") }]
    });
    await assert.rejects(
      () => new DeepSeekLiveTransport("not-a-real-key", "https://unused.invalid").complete(secretManifest, secretManifest.items[0]),
      (error: unknown) => error instanceof HarnessError && error.code === "outbound_privacy_check_failed"
    );
    assert.equal(fetchCalled, false);

    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: { code: "rate_limited", message: "private provider body must not escape" } }),
      { status: 429, headers: { "x-request-id": "request-safe-1" } }
    );
    const safeManifest = baseManifest();
    await assert.rejects(
      () => new DeepSeekLiveTransport("not-a-real-key", "https://unused.invalid").complete(safeManifest, safeManifest.items[0]),
      (error: unknown) => {
        assert.ok(error instanceof HarnessError);
        assert.equal(error.code, "deepseek_api_error");
        assert.equal(JSON.stringify(error.details).includes("private provider body"), false);
        assert.equal((error.details as Record<string, unknown>).request_id, "request-safe-1");
        return true;
      }
    );

    globalThis.fetch = async () => new Response(JSON.stringify({
      model: "deepseek-v4-pro",
      choices: [{ message: { content: "READY" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }), { status: 200 });
    await assert.rejects(
      () => new DeepSeekLiveTransport("not-a-real-key", "https://unused.invalid").complete(safeManifest, safeManifest.items[0]),
      (error: unknown) => error instanceof HarnessError && error.code === "deepseek_response_model_mismatch"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live transport aborts a hung provider request at the configured deadline", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")), { once: true });
    });
    const manifest = baseManifest();
    await assert.rejects(
      () => new DeepSeekLiveTransport("not-a-real-key", "https://unused.invalid", 5).complete(manifest, manifest.items[0]),
      (error: unknown) => error instanceof HarnessError && error.code === "deepseek_request_timeout"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mocked live lifecycle consumes one receipt and reconciles observed usage", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-live-lifecycle-"));
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.DEEPSEEK_API_KEY;
  const originalPublicKey = process.env.DEEPSEEK_HARNESS_APPROVAL_PUBLIC_KEY;
  try {
    process.env.DEEPSEEK_API_KEY = "fixture-api-key-never-sent";
    process.env.DEEPSEEK_HARNESS_APPROVAL_PUBLIC_KEY = publicKeyPem;
    globalThis.fetch = async () => new Response(JSON.stringify({
      model: "deepseek-v4-flash",
      choices: [{ message: { content: "READY" } }],
      usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 }
    }), { status: 200 });
    const manifest = authorisedManifest({ run_id: "live-mocked" });
    const context = { stateDir: path.join(root, ".state"), artifactRoot: path.join(root, "artifacts") };
    const result = await submitManifest(manifest, context, { start: true, allowLive: true });
    assert.equal(result.status, "completed");
    const status = getStatus("live-mocked", context) as {
      summary: { budget: { status: string; charged_usd: number; reserved_usd: number } };
    };
    assert.equal(status.summary.budget.status, "reconciled");
    assert.ok(status.summary.budget.charged_usd < status.summary.budget.reserved_usd);

    await assert.rejects(
      () => processRun("live-mocked", context, { allowLive: true }),
      (error: unknown) => error instanceof HarnessError && error.code === "blocked_by_safety_policy"
    );
    const persisted = JSON.parse(fs.readFileSync(path.join(root, "artifacts", "live-mocked", "manifest.json"), "utf8"));
    assert.equal(persisted.approval_receipt.signature_base64, "[signed-receipt-redacted]");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalApiKey;
    if (originalPublicKey === undefined) delete process.env.DEEPSEEK_HARNESS_APPROVAL_PUBLIC_KEY;
    else process.env.DEEPSEEK_HARNESS_APPROVAL_PUBLIC_KEY = originalPublicKey;
  }
});
