import { createHash, verify } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./approval.js";
import { HarnessError } from "./errors.js";

export const TRANSLATION_REVIEW_RECEIPT_SCHEMA_VERSION =
  "deepseek-harness.translation-review-receipt.v1" as const;

const SAFE_ID = /^[A-Za-z0-9_.:-]+$/;
const SAFE_NONCE = /^[A-Za-z0-9_-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ID_LENGTH = 200;
const MAX_REVIEWER_LENGTH = 200;
const MAX_SIGNATURE_LENGTH = 1000;
const CLOCK_SKEW_MS = 5 * 60_000;

export const translationReviewReceiptSchema = z
  .object({
    schema_version: z.literal(TRANSLATION_REVIEW_RECEIPT_SCHEMA_VERSION),
    receipt_id: z.string().min(8).max(MAX_ID_LENGTH).regex(SAFE_ID),
    status: z.literal("approved"),
    issuer: z.literal("owner"),
    reviewer: z.string().min(1).max(MAX_REVIEWER_LENGTH).refine((value) => value.trim().length > 0),
    issued_at: z.string().datetime({ offset: true }),
    expires_at: z.string().datetime({ offset: true }),
    nonce: z.string().min(16).max(MAX_ID_LENGTH).regex(SAFE_NONCE),
    job_id: z.string().min(1).max(MAX_ID_LENGTH).refine((value) => value.trim().length > 0),
    project: z.string().min(1).max(MAX_ID_LENGTH).refine((value) => value.trim().length > 0),
    review_payload_sha256: z.string().regex(SHA256),
    signature_base64: z.string().min(1).max(MAX_SIGNATURE_LENGTH)
  })
  .strict();

export type TranslationReviewReceipt = z.infer<typeof translationReviewReceiptSchema>;

export interface TranslationReviewValidation {
  ok: boolean;
  blockers: string[];
  receipt_sha256: string | null;
}

export interface TranslationReviewValidationOptions {
  expectedJobId: string;
  expectedProject: string;
  expectedReviewPayloadSha256: string;
  publicKeyPem?: string;
  now?: Date;
}

export function parseTranslationReviewReceipt(input: unknown): TranslationReviewReceipt {
  const parsed = translationReviewReceiptSchema.safeParse(input);
  if (!parsed.success) {
    throw new HarnessError(
      "invalid_translation_review_receipt",
      "Translation review receipt failed validation",
      parsed.error.flatten()
    );
  }
  return parsed.data;
}

export function translationReviewReceiptSigningPayload(receipt: TranslationReviewReceipt): string {
  const { signature_base64: _signature, ...unsigned } = receipt;
  return canonicalJson(unsigned);
}

export function translationReviewReceiptDigest(receipt: TranslationReviewReceipt): string {
  return createHash("sha256").update(canonicalJson(receipt), "utf8").digest("hex");
}

export function validateTranslationReviewReceipt(
  input: unknown,
  options: TranslationReviewValidationOptions
): TranslationReviewValidation {
  const blockers: string[] = [];

  if (!options.publicKeyPem?.trim()) {
    blockers.push("translation_review_receipt_public_key_not_configured");
  }

  const raw = isRecord(input) ? input : null;
  if (raw && (raw.status !== "approved" || raw.issuer !== "owner")) {
    blockers.push("translation_review_receipt_not_owner_approved");
  }

  if (raw && raw.job_id !== options.expectedJobId) {
    blockers.push("translation_review_receipt_job_mismatch");
  }
  if (raw && raw.project !== options.expectedProject) {
    blockers.push("translation_review_receipt_project_mismatch");
  }
  if (raw && raw.review_payload_sha256 !== options.expectedReviewPayloadSha256) {
    blockers.push("translation_review_receipt_payload_digest_mismatch");
  }

  const parsed = translationReviewReceiptSchema.safeParse(input);
  if (!parsed.success) {
    if (!blockers.includes("translation_review_receipt_not_owner_approved")) {
      blockers.push("translation_review_receipt_invalid");
    }
    return result(blockers, null);
  }

  const receipt = parsed.data;
  if (receipt.job_id !== options.expectedJobId && !blockers.includes("translation_review_receipt_job_mismatch")) {
    blockers.push("translation_review_receipt_job_mismatch");
  }
  if (receipt.project !== options.expectedProject && !blockers.includes("translation_review_receipt_project_mismatch")) {
    blockers.push("translation_review_receipt_project_mismatch");
  }
  if (
    receipt.review_payload_sha256 !== options.expectedReviewPayloadSha256 &&
    !blockers.includes("translation_review_receipt_payload_digest_mismatch")
  ) {
    blockers.push("translation_review_receipt_payload_digest_mismatch");
  }

  const issuedAt = Date.parse(receipt.issued_at);
  const expiresAt = Date.parse(receipt.expires_at);
  const nowMs = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || !Number.isFinite(nowMs) || expiresAt <= issuedAt) {
    blockers.push("translation_review_receipt_time_window_invalid");
  } else {
    if (issuedAt > nowMs + CLOCK_SKEW_MS) {
      blockers.push("translation_review_receipt_not_yet_valid");
    }
    if (expiresAt <= nowMs) {
      blockers.push("translation_review_receipt_expired");
    }
  }

  if (options.publicKeyPem?.trim()) {
    try {
      const signature = Buffer.from(receipt.signature_base64, "base64");
      const valid =
        signature.length === 64 &&
        verify(
          null,
          Buffer.from(translationReviewReceiptSigningPayload(receipt), "utf8"),
          options.publicKeyPem,
          signature
        );
      if (!valid) {
        blockers.push("translation_review_receipt_signature_invalid");
      }
    } catch {
      blockers.push("translation_review_receipt_signature_invalid");
    }
  }

  return result(blockers, translationReviewReceiptDigest(receipt));
}

function result(blockers: string[], digest: string | null): TranslationReviewValidation {
  return { ok: blockers.length === 0, blockers, receipt_sha256: digest };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
