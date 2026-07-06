use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use clap::Parser;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;

#[derive(Debug, Parser)]
#[command(about = "Rust worker core for DeepSeek Harness fake batch execution")]
struct Args {
    #[arg(long)]
    manifest: PathBuf,

    #[arg(long, default_value = "fake")]
    transport: Transport,

    #[arg(long)]
    concurrency: Option<usize>,

    #[arg(long)]
    output: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, clap::ValueEnum)]
#[serde(rename_all = "kebab-case")]
enum Transport {
    Fake,
}

#[derive(Clone, Debug, Deserialize)]
struct Manifest {
    schema_version: String,
    project: String,
    #[serde(default)]
    description: Option<String>,
    egress_class: String,
    transport: String,
    model: String,
    #[serde(default = "default_response_format")]
    response_format: String,
    concurrency: usize,
    cost_cap_usd: f64,
    canonical_writes: bool,
    external_side_effects: bool,
    items: Vec<RunItem>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct RunItem {
    id: String,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    messages: Option<Vec<Message>>,
    #[serde(default)]
    metadata: Option<BTreeMap<String, serde_json::Value>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Message {
    role: String,
    content: String,
}

#[derive(Debug, Serialize)]
struct WorkerReport {
    schema_version: &'static str,
    generated_at_unix_ms: u128,
    authority: Authority,
    input: ReportInput,
    result: ReportResult,
    items: Vec<ItemReport>,
}

#[derive(Debug, Serialize)]
struct Authority {
    canonical_state_write: bool,
    command_centre_state_write: bool,
    local_workspace_apply: bool,
    external_side_effects: bool,
    live_deepseek_calls: bool,
}

#[derive(Debug, Serialize)]
struct ReportInput {
    project: String,
    manifest_transport: String,
    worker_transport: Transport,
    model: String,
    requested_concurrency: usize,
    item_count: usize,
}

#[derive(Debug, Serialize)]
struct ReportResult {
    status: &'static str,
    completed: usize,
    failed: usize,
    elapsed_ms: u128,
    items_per_second: f64,
}

#[derive(Clone, Debug, Serialize)]
struct ItemReport {
    id: String,
    status: &'static str,
    content: String,
    raw: serde_json::Value,
    usage: serde_json::Value,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let manifest = load_manifest(&args.manifest)?;
    validate_manifest(&manifest, args.transport)?;

    let concurrency = args.concurrency.unwrap_or(manifest.concurrency);
    if concurrency == 0 {
        bail!("concurrency must be positive");
    }

    let report = run_fake_batch(manifest, args.transport, concurrency).await?;
    let report_json = serde_json::to_string_pretty(&report)?;

    if let Some(output) = args.output {
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent).with_context(|| {
                format!("failed to create output directory {}", parent.display())
            })?;
        }
        std::fs::write(&output, report_json)
            .with_context(|| format!("failed to write worker report {}", output.display()))?;
    } else {
        println!("{report_json}");
    }

    Ok(())
}

fn load_manifest(path: &PathBuf) -> Result<Manifest> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read manifest {}", path.display()))?;
    serde_json::from_str(&raw)
        .with_context(|| format!("failed to parse manifest {}", path.display()))
}

fn validate_manifest(manifest: &Manifest, transport: Transport) -> Result<()> {
    if manifest.schema_version != "deepseek-harness.run.v1" {
        bail!("unsupported schema_version {}", manifest.schema_version);
    }
    if manifest.egress_class != "non_sensitive_bulk" {
        bail!("rust worker currently accepts only non_sensitive_bulk egress");
    }
    if manifest.transport != "fake" {
        bail!("rust worker currently accepts only fake manifests");
    }
    if transport != Transport::Fake {
        bail!("rust worker currently supports only fake transport");
    }
    if manifest.canonical_writes {
        bail!("canonical_writes must be false");
    }
    if manifest.external_side_effects {
        bail!("external_side_effects must be false");
    }
    if manifest.items.is_empty() {
        bail!("manifest must include at least one item");
    }
    if manifest.cost_cap_usd <= 0.0 {
        bail!("cost_cap_usd must be positive");
    }
    for item in &manifest.items {
        if item.id.trim().is_empty() {
            bail!("item id must not be empty");
        }
        if item.prompt.is_none() && item.messages.as_ref().map_or(true, Vec::is_empty) {
            bail!("item {} must include prompt or messages", item.id);
        }
    }
    Ok(())
}

async fn run_fake_batch(
    manifest: Manifest,
    transport: Transport,
    concurrency: usize,
) -> Result<WorkerReport> {
    let started = Instant::now();
    let semaphore = Arc::new(Semaphore::new(concurrency));
    let manifest = Arc::new(manifest);
    let mut handles = Vec::with_capacity(manifest.items.len());

    for item in manifest.items.clone() {
        let permit = semaphore.clone().acquire_owned().await?;
        let manifest = Arc::clone(&manifest);
        handles.push(tokio::spawn(async move {
            let _permit = permit;
            fake_complete(&manifest, item).await
        }));
    }

    let mut items = Vec::with_capacity(handles.len());
    for handle in handles {
        items.push(handle.await??);
    }
    items.sort_by(|a, b| a.id.cmp(&b.id));

    let elapsed_ms = started.elapsed().as_millis();
    let completed = items
        .iter()
        .filter(|item| item.status == "completed")
        .count();
    let failed = items.len().saturating_sub(completed);
    let items_per_second = if elapsed_ms == 0 {
        completed as f64
    } else {
        completed as f64 / (elapsed_ms as f64 / 1000.0)
    };

    Ok(WorkerReport {
        schema_version: "deepseek-harness.worker-report.v1",
        generated_at_unix_ms: now_unix_ms(),
        authority: Authority {
            canonical_state_write: false,
            command_centre_state_write: false,
            local_workspace_apply: false,
            external_side_effects: false,
            live_deepseek_calls: false,
        },
        input: ReportInput {
            project: manifest.project.clone(),
            manifest_transport: manifest.transport.clone(),
            worker_transport: transport,
            model: manifest.model.clone(),
            requested_concurrency: concurrency,
            item_count: manifest.items.len(),
        },
        result: ReportResult {
            status: if failed == 0 { "completed" } else { "partial" },
            completed,
            failed,
            elapsed_ms,
            items_per_second: round_two(items_per_second),
        },
        items,
    })
}

async fn fake_complete(manifest: &Manifest, item: RunItem) -> Result<ItemReport> {
    tokio::time::sleep(Duration::from_millis(1)).await;
    let payload = serde_json::json!({
        "project": manifest.project,
        "description": manifest.description,
        "response_format": manifest.response_format,
        "item": item,
    });
    let digest = Sha256::digest(serde_json::to_vec(&payload)?);
    let digest_hex = hex::encode(digest);
    let short = &digest_hex[..12];
    let content = if manifest.response_format == "json_object" {
        serde_json::json!({ "item_id": payload["item"]["id"], "fake": true, "digest": short })
            .to_string()
    } else {
        format!(
            "fake:{}:{short}",
            payload["item"]["id"].as_str().unwrap_or("unknown")
        )
    };

    Ok(ItemReport {
        id: payload["item"]["id"]
            .as_str()
            .unwrap_or("unknown")
            .to_string(),
        status: "completed",
        content,
        raw: serde_json::json!({ "fake": true, "item_id": payload["item"]["id"], "digest": digest_hex }),
        usage: serde_json::json!({
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "estimated_cost_usd": 0
        }),
    })
}

fn default_response_format() -> String {
    "text".to_string()
}

fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis()
}

fn round_two(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> Manifest {
        Manifest {
            schema_version: "deepseek-harness.run.v1".to_string(),
            project: "worker-test".to_string(),
            description: None,
            egress_class: "non_sensitive_bulk".to_string(),
            transport: "fake".to_string(),
            model: "deepseek-v4-flash".to_string(),
            response_format: "text".to_string(),
            concurrency: 2,
            cost_cap_usd: 0.05,
            canonical_writes: false,
            external_side_effects: false,
            items: vec![
                RunItem {
                    id: "item-001".to_string(),
                    prompt: Some("Return a fake result.".to_string()),
                    messages: None,
                    metadata: None,
                },
                RunItem {
                    id: "item-002".to_string(),
                    prompt: Some("Return another fake result.".to_string()),
                    messages: None,
                    metadata: None,
                },
            ],
        }
    }

    #[test]
    fn validates_fake_manifest() {
        assert!(validate_manifest(&manifest(), Transport::Fake).is_ok());
    }

    #[test]
    fn rejects_live_manifest() {
        let mut manifest = manifest();
        manifest.transport = "deepseek".to_string();
        let error = validate_manifest(&manifest, Transport::Fake).unwrap_err();
        assert!(error.to_string().contains("only fake manifests"));
    }

    #[tokio::test]
    async fn runs_fake_batch_with_report() {
        let report = run_fake_batch(manifest(), Transport::Fake, 2)
            .await
            .unwrap();
        assert_eq!(report.schema_version, "deepseek-harness.worker-report.v1");
        assert_eq!(report.result.status, "completed");
        assert_eq!(report.result.completed, 2);
        assert_eq!(report.result.failed, 0);
        assert_eq!(report.input.worker_transport, Transport::Fake);
        assert!(
            report
                .items
                .iter()
                .all(|item| item.content.starts_with("fake:"))
        );
    }
}
