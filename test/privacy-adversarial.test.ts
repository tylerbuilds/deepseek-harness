import test from "node:test";
import assert from "node:assert/strict";
import { classifyManifestPrivacy, classifyOutboundPayload } from "../src/privacy.js";

const digest = "0123456789abcdef".repeat(4);

test("trusted provenance SHA-256 metadata does not masquerade as a credential", () => {
  const report = classifyManifestPrivacy({
    items: [{ id: "sha", prompt: "Translate this public sentence.", metadata: { input_sha256: digest } }]
  });

  assert.equal(report.external_deepseek_allowed, true);
  assert.equal(report.findings.some((finding) => finding.signal === "high_entropy_credential_candidate"), false);
});

test("the same high-entropy value remains blocked outside the provenance allow-list", () => {
  const report = classifyManifestPrivacy({
    items: [{ id: "arbitrary", prompt: "Translate this public sentence.", metadata: { note: digest } }]
  });

  assert.equal(report.external_deepseek_allowed, false);
  assert.equal(report.findings.some((finding) => finding.signal === "high_entropy_credential_candidate"), true);
});

test("a provenance field only suppresses an exact hex digest, not credential-shaped content", () => {
  const report = classifyManifestPrivacy({
    items: [{
      id: "wrong-shape",
      prompt: "Translate this public sentence.",
      metadata: { input_sha256: ["api", "_key", " = ", "abcDEF0123456789", "abcDEF0123456789"].join("") }
    }]
  });

  assert.equal(report.external_deepseek_allowed, false);
  assert.equal(report.findings.some((finding) => finding.signal === "credential_assignment"), true);
});

test("nested secrets remain visible beside trusted provenance digests", () => {
  const report = classifyManifestPrivacy({
    items: [{
      id: "nested",
      prompt: "Translate this public sentence.",
      metadata: {
        provenance: { source_sha256: digest },
        connection: { password: ["abcDEF0123456789", "abcDEF0123456789"].join("") }
      }
    }]
  });

  assert.equal(report.external_deepseek_allowed, false);
  assert.equal(report.findings.some((finding) => finding.signal === "credential_assignment"), true);
});

test("cyclic metadata fails closed instead of crashing the privacy gate", () => {
  const metadata: Record<string, unknown> = {};
  metadata.self = metadata;
  const report = classifyManifestPrivacy({
    items: [{ id: "cycle", prompt: "Translate this public sentence.", metadata }]
  });

  assert.equal(report.external_deepseek_allowed, false);
  assert.equal(report.findings.some((finding) => finding.signal === "unscannable_metadata"), true);
});

test("textual SHA-256 labels cannot disguise high-entropy content", () => {
  const prompt = `Transform this row: {"sha256":"${digest}","title":"public"}`;
  const manifestReport = classifyManifestPrivacy({ items: [{ id: "hash-row", prompt }] });
  const outboundReport = classifyOutboundPayload("hash-row", {
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: prompt }]
  });

  assert.equal(manifestReport.external_deepseek_allowed, false);
  assert.equal(outboundReport.external_deepseek_allowed, false);
  assert.equal(manifestReport.findings.some((finding) => finding.signal === "high_entropy_credential_candidate"), true);
  assert.equal(outboundReport.findings.some((finding) => finding.signal === "high_entropy_credential_candidate"), true);
});

test("plain-language input_sha256 labels remain untrusted user content", () => {
  const report = classifyOutboundPayload("label-escape", {
    messages: [{ role: "user", content: `Please analyse input_sha256: ${digest}` }]
  });

  assert.equal(report.external_deepseek_allowed, false);
  assert.equal(report.findings.some((finding) => finding.signal === "high_entropy_credential_candidate"), true);
});

test("an unlabelled 64-hex value in outbound content remains blocked", () => {
  const report = classifyOutboundPayload("unlabelled", {
    messages: [{ role: "user", content: `opaque value: ${digest}` }]
  });

  assert.equal(report.external_deepseek_allowed, false);
  assert.equal(report.findings.some((finding) => finding.signal === "high_entropy_credential_candidate"), true);
});

test("explicit short credential assignments fail closed", () => {
  for (const content of [
    "password=abc",
    "PASSWORD=letmein",
    "db_password=secret",
    "token=abc123",
    "client_secret=foo"
  ]) {
    const report = classifyOutboundPayload("short-secret", { messages: [{ role: "user", content }] });
    assert.equal(report.external_deepseek_allowed, false, content);
    assert.equal(report.findings.some((finding) => finding.signal === "credential_assignment"), true, content);
  }
});

test("private-workspace origins are blocked on macOS, Linux and Windows paths", () => {
  for (const origin of [
    "/Users/operator/Documents/Obsidian/private.md",
    "/home/operator/Documents/Obsidian/private.md",
    "C:\\Users\\operator\\Documents\\Obsidian\\private.md"
  ]) {
    const report = classifyOutboundPayload("private-origin", { source_path: origin });
    assert.equal(report.external_deepseek_allowed, false, origin);
    assert.equal(report.findings.some((finding) => finding.signal === "private_workspace_origin"), true, origin);
  }
});
