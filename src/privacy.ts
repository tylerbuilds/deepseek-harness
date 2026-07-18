export type EgressClass =
  | "non_sensitive_bulk"
  | "local_private"
  | "personal_sensitive"
  | "client_sensitive"
  | "health_genetics"
  | "secrets_or_credentials";

export interface PrivacyFinding {
  item_id: string;
  category: EgressClass;
  signal: string;
  severity: "warning" | "blocker";
}

export interface PrivacyReport {
  schema_version: "deepseek-harness.privacy-report.v1";
  recommended_egress_class: EgressClass;
  external_deepseek_allowed: boolean;
  findings: PrivacyFinding[];
}

interface ManifestLike {
  items: Array<{
    id: string;
    prompt?: string;
    messages?: Array<{ content: string }>;
    metadata?: Record<string, unknown>;
  }>;
}

const CLASS_RANK: Record<EgressClass, number> = {
  non_sensitive_bulk: 0,
  local_private: 1,
  personal_sensitive: 2,
  client_sensitive: 3,
  health_genetics: 4,
  secrets_or_credentials: 5
};

const SECRET_SIGNALS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i, "bearer_token"],
  [/\b(?:sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}/i, "token_prefix"],
  [/\bAKIA[A-Z0-9]{16}\b/, "aws_access_key"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, "jwt_token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/i, "private_key_block"],
  [/\b(?:api[\s_-]?key|client[\s_-]?secret|db[\s_-]?password|secret|password|passwd|token|access[\s_-]?token|refresh[\s_-]?token)["']?\s*[:=]\s*["']?[^\s,"'}]{1,}/i, "credential_assignment"]
];

const DISCUSSION_SIGNALS: Array<[RegExp, string]> = [
  [/\b(api[\s_-]?keys?|secrets?|passwords?|private[\s_-]?keys?|access[\s_-]?tokens?)\b/i, "credential_discussion"],
  [/\b(genetic|genome|dna|biopsy|diagnosis|prescription|medical cannabis)\b/i, "health_topic_discussion"]
];

const HEALTH_SIGNALS: Array<[RegExp, string]> = [
  [/\bnhs\s*(?:number|no\.?|id)\s*[:=]?\s*\d[\d ]{8,12}\b/i, "nhs_identifier"],
  [/\b(?:patient|medical)\s*(?:id|record|number|file)\s*[:=]\s*[A-Za-z0-9-]{5,}\b/i, "medical_identifier"],
  [/\b(?:date of birth|dob)\s*[:=]\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/i, "date_of_birth"]
];

const PERSONAL_SIGNALS: Array<[RegExp, string]> = [
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, "email_address"],
  [/\b(\+44|0)7\d{9}\b/i, "uk_mobile_number"],
  [/\b(?:home address|passport|driving licence|national insurance)\s*[:=]\s*[^\n]{5,}/i, "personal_identifier"],
  [/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i, "uk_postcode"]
];

const CLIENT_SIGNALS: Array<[RegExp, string]> = [
  [/\b(client confidential|customer data|nda|commercially sensitive)\b/i, "client_confidentiality_marker"],
  [/\b(stripe customer|hubspot contact|salesforce account)\b/i, "customer_system_record"]
];

const PRIVATE_ORIGIN_SIGNALS: Array<[RegExp, string]> = [
  [/(?:^|[/\\])\.env(?:\.|$)/i, "private_env_origin"],
  [/(?:\/Users\/[^/]+\/Documents\/Obsidian|\/home\/[^/]+\/Documents\/Obsidian|[A-Za-z]:[\\/]+Users[\\/]+[^\\/]+[\\/]+Documents[\\/]+Obsidian|\/private-workspace-state(?:\/|$))/i, "private_workspace_origin"],
  [/(?:client|customer)[-_ ]?(?:private|confidential)/i, "private_client_origin"]
];

export function classifyManifestPrivacy(manifest: ManifestLike): PrivacyReport {
  const findings = manifest.items.flatMap((item) => {
    const scan = itemText(item);
    const itemFindings = classifyText(item.id, scan.text);
    if (scan.unscannableMetadata) {
      itemFindings.push({
        item_id: item.id,
        category: "secrets_or_credentials",
        signal: "unscannable_metadata",
        severity: "blocker"
      });
    }
    return itemFindings;
  });
  const blockers = findings.filter((finding) => finding.severity === "blocker");
  const recommended = blockers.reduce<EgressClass>((current, finding) => {
    return CLASS_RANK[finding.category] > CLASS_RANK[current] ? finding.category : current;
  }, "non_sensitive_bulk");

  return {
    schema_version: "deepseek-harness.privacy-report.v1",
    recommended_egress_class: recommended,
    external_deepseek_allowed: blockers.length === 0,
    findings
  };
}

export function classifyOutboundPayload(itemId: string, payload: unknown): PrivacyReport {
  const findings = classifyText(itemId, JSON.stringify(payload));
  const blockers = findings.filter((finding) => finding.severity === "blocker");
  const recommended = blockers.reduce<EgressClass>((current, finding) => {
    return CLASS_RANK[finding.category] > CLASS_RANK[current] ? finding.category : current;
  }, "non_sensitive_bulk");
  return {
    schema_version: "deepseek-harness.privacy-report.v1",
    recommended_egress_class: recommended,
    external_deepseek_allowed: blockers.length === 0,
    findings
  };
}

function classifyText(itemId: string, text: string): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  pushMatches(findings, itemId, text, SECRET_SIGNALS, "secrets_or_credentials", "blocker");
  pushMatches(findings, itemId, text, HEALTH_SIGNALS, "health_genetics", "blocker");
  pushMatches(findings, itemId, text, CLIENT_SIGNALS, "client_sensitive", "blocker");
  pushMatches(findings, itemId, text, PERSONAL_SIGNALS, "personal_sensitive", "blocker");
  pushMatches(findings, itemId, text, PRIVATE_ORIGIN_SIGNALS, "local_private", "blocker");
  pushMatches(findings, itemId, text, DISCUSSION_SIGNALS, "non_sensitive_bulk", "warning");
  if (hasHighEntropyCredentialCandidate(text)) {
    findings.push({ item_id: itemId, category: "secrets_or_credentials", signal: "high_entropy_credential_candidate", severity: "blocker" });
  }
  return findings.filter(
    (finding, index, rows) => rows.findIndex((candidate) => candidate.signal === finding.signal) === index
  );
}

function hasHighEntropyCredentialCandidate(text: string): boolean {
  const candidates = text.match(/[A-Za-z0-9_+/=-]{24,200}/g) ?? [];
  return candidates.some((candidate) => {
    if (!/[A-Za-z]/.test(candidate) || !/\d/.test(candidate) || new Set(candidate).size < 10) {
      return false;
    }
    const frequencies = new Map<string, number>();
    for (const character of candidate) {
      frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
    }
    const entropy = [...frequencies.values()].reduce((total, count) => {
      const probability = count / candidate.length;
      return total - probability * Math.log2(probability);
    }, 0);
    return entropy >= 3.5;
  });
}

function pushMatches(
  findings: PrivacyFinding[],
  itemId: string,
  text: string,
  signals: Array<[RegExp, string]>,
  category: EgressClass,
  severity: PrivacyFinding["severity"]
): void {
  for (const [pattern, signal] of signals) {
    if (pattern.test(text)) {
      findings.push({ item_id: itemId, category, signal, severity });
    }
  }
}

const PROVENANCE_SHA256_KEYS = new Set([
  "glossary_sha256",
  "input_sha256",
  "network_payload_sha256",
  "output_sha256",
  "payload_sha256",
  "shard_sha256",
  "source_sha256",
  "target_sha256"
]);

function itemText(item: ManifestLike["items"][number]): { text: string; unscannableMetadata: boolean } {
  const prompt = item.prompt ?? "";
  const messages = item.messages?.map((message) => message.content).join("\n") ?? "";
  let metadata = "";
  try {
    metadata = item.metadata
      ? JSON.stringify(item.metadata, (key, value: unknown) => {
          if (
            PROVENANCE_SHA256_KEYS.has(key.toLowerCase()) &&
            typeof value === "string" &&
            /^[a-f0-9]{64}$/i.test(value)
          ) {
            return "[digest]";
          }
          return value;
        })
      : "";
  } catch {
    return { text: [prompt, messages].filter(Boolean).join("\n"), unscannableMetadata: true };
  }
  return { text: [prompt, messages, metadata].filter(Boolean).join("\n"), unscannableMetadata: false };
}
