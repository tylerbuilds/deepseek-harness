import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  parseTranslationReviewReceipt,
  translationReviewReceiptDigest,
  translationReviewReceiptSigningPayload,
  validateTranslationReviewReceipt,
  type TranslationReviewReceipt
} from "../src/corpus_translation_review.js";

const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

function unsignedReceipt(overrides: Partial<TranslationReviewReceipt> = {}): TranslationReviewReceipt {
  const now = Date.parse("2026-07-18T09:00:00.000Z");
  return {
    schema_version: "deepseek-harness.translation-review-receipt.v1",
    receipt_id: "translation-review-20260718-001",
    status: "approved",
    issuer: "owner",
    reviewer: "owner-reviewer",
    issued_at: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + 10 * 60_000).toISOString(),
    nonce: "nonce-translation-review-123",
    job_id: "tm-job-001",
    project: "translation-memory",
    review_payload_sha256: "a".repeat(64),
    signature_base64: "pending-signature",
    ...overrides
  };
}

function signedReceipt(overrides: Partial<TranslationReviewReceipt> = {}): TranslationReviewReceipt {
  const unsigned = unsignedReceipt(overrides);
  return {
    ...unsigned,
    signature_base64: sign(
      null,
      Buffer.from(translationReviewReceiptSigningPayload(unsigned), "utf8"),
      keys.privateKey
    ).toString("base64")
  };
}

const expected = {
  expectedJobId: "tm-job-001",
  expectedProject: "translation-memory",
  expectedReviewPayloadSha256: "a".repeat(64),
  publicKeyPem,
  now: new Date("2026-07-18T09:00:00.000Z")
};

test("valid owner-signed review receipt parses and validates", () => {
  const receipt = parseTranslationReviewReceipt(signedReceipt());
  const validation = validateTranslationReviewReceipt(receipt, expected);
  assert.equal(validation.ok, true, validation.blockers.join(","));
  assert.deepEqual(validation.blockers, []);
  assert.match(validation.receipt_sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(validation.receipt_sha256, translationReviewReceiptDigest(receipt));
});

test("payload, job, and project tampering each fail closed", () => {
  const receipt = signedReceipt();
  const payloadChanged = { ...receipt, review_payload_sha256: "b".repeat(64) };
  const payloadResult = validateTranslationReviewReceipt(payloadChanged, expected);
  assert.ok(payloadResult.blockers.includes("translation_review_receipt_payload_digest_mismatch"));
  assert.ok(payloadResult.blockers.includes("translation_review_receipt_signature_invalid"));

  const jobChanged = { ...receipt, job_id: "tm-job-002" };
  const jobResult = validateTranslationReviewReceipt(jobChanged, expected);
  assert.ok(jobResult.blockers.includes("translation_review_receipt_job_mismatch"));
  assert.ok(jobResult.blockers.includes("translation_review_receipt_signature_invalid"));

  const projectChanged = { ...receipt, project: "other-project" };
  const projectResult = validateTranslationReviewReceipt(projectChanged, expected);
  assert.ok(projectResult.blockers.includes("translation_review_receipt_project_mismatch"));
  assert.ok(projectResult.blockers.includes("translation_review_receipt_signature_invalid"));
});

test("expiry and a future issue time are explicit blockers", () => {
  const expired = signedReceipt({
    issued_at: "2026-07-18T08:00:00.000Z",
    expires_at: "2026-07-18T08:59:00.000Z"
  });
  const expiredResult = validateTranslationReviewReceipt(expired, expected);
  assert.ok(expiredResult.blockers.includes("translation_review_receipt_expired"));

  const future = signedReceipt({
    issued_at: "2026-07-18T10:00:00.000Z",
    expires_at: "2026-07-18T11:00:00.000Z"
  });
  const futureResult = validateTranslationReviewReceipt(future, expected);
  assert.ok(futureResult.blockers.includes("translation_review_receipt_not_yet_valid"));
});

test("bad signature and missing public key fail closed", () => {
  const receipt = { ...signedReceipt(), signature_base64: Buffer.alloc(64, 7).toString("base64") };
  const badSignature = validateTranslationReviewReceipt(receipt, expected);
  assert.equal(badSignature.ok, false);
  assert.ok(badSignature.blockers.includes("translation_review_receipt_signature_invalid"));

  const missingKey = validateTranslationReviewReceipt(receipt, { ...expected, publicKeyPem: undefined });
  assert.ok(missingKey.blockers.includes("translation_review_receipt_public_key_not_configured"));
  assert.ok(!missingKey.blockers.some((blocker) => blocker.includes("BEGIN PUBLIC KEY")));
});

test("owner/status mismatch is reported without exposing signed content", () => {
  const receipt = signedReceipt({ status: "approved", issuer: "owner" });
  const tampered = { ...receipt, status: "pending", issuer: "reviewer" } as unknown;
  const result = validateTranslationReviewReceipt(tampered, expected);
  assert.ok(result.blockers.includes("translation_review_receipt_not_owner_approved"));
  assert.ok(!JSON.stringify(result).includes("translation-memory"));
});
