#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import packageMetadata from "../package.json" with { type: "json" };

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-package-smoke-"));
const packDirectory = path.join(temporaryRoot, "pack");
const prefix = path.join(temporaryRoot, "prefix");
const consumerDirectory = path.join(temporaryRoot, "consumer");
const stateDirectory = path.join(temporaryRoot, "state");
const artifactDirectory = path.join(temporaryRoot, "artifacts");

fs.mkdirSync(packDirectory, { recursive: true });
fs.mkdirSync(consumerDirectory, { recursive: true });

const cleanEnv = { ...process.env };
delete cleanEnv.DEEPSEEK_API_KEY;
delete cleanEnv.DEEPSEEK_HARNESS_APPROVAL_PUBLIC_KEY;
Object.assign(cleanEnv, {
  DEEPSEEK_HARNESS_STATE_DIR: stateDirectory,
  DEEPSEEK_HARNESS_ARTIFACT_DIR: artifactDirectory,
  DEEPSEEK_HARNESS_INPUT_ROOT: consumerDirectory
});

try {
  const packed = JSON.parse(execFileSync(npmCommand, ["pack", "--json", "--pack-destination", packDirectory], {
    cwd: process.cwd(),
    env: cleanEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }));
  const filename = packed[0]?.filename;
  if (typeof filename !== "string") {
    throw new Error("npm pack did not report an archive filename");
  }
  const archive = path.join(packDirectory, filename);

  execFileSync(npmCommand, ["install", "--global", "--prefix", prefix, archive], {
    cwd: consumerDirectory,
    env: cleanEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  const executableSuffix = process.platform === "win32" ? ".cmd" : "";
  const binDirectory = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  const cli = path.join(binDirectory, `deepseek-harness${executableSuffix}`);
  const mcp = path.join(binDirectory, `deepseek-harness-mcp${executableSuffix}`);

  const version = execFileSync(cli, ["--version"], {
    cwd: consumerDirectory,
    env: cleanEnv,
    encoding: "utf8"
  }).trim();
  if (version !== packageMetadata.version) {
    throw new Error(`Installed version mismatch: expected ${packageMetadata.version}, got ${version}`);
  }

  const help = execFileSync(cli, ["--help"], {
    cwd: consumerDirectory,
    env: cleanEnv,
    encoding: "utf8"
  });
  if (!help.includes("deepseek-harness quickstart")) {
    throw new Error("Installed help did not include the quickstart journey");
  }

  const doctor = JSON.parse(execFileSync(cli, ["doctor"], {
    cwd: consumerDirectory,
    env: cleanEnv,
    encoding: "utf8"
  }));
  if (
    !doctor.ok ||
    doctor.version !== packageMetadata.version ||
    !fs.existsSync(doctor.cli?.source_entrypoint) ||
    !fs.existsSync(doctor.cli?.mcp_entrypoint)
  ) {
    throw new Error(`Installed doctor reported invalid entrypoints: ${JSON.stringify(doctor.cli)}`);
  }

  const quickstartOutput = path.join(artifactDirectory, "package-quickstart.json");
  const quickstart = JSON.parse(execFileSync(cli, ["quickstart", "--output", quickstartOutput], {
    cwd: consumerDirectory,
    env: cleanEnv,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  }));
  if (!quickstart.ok || quickstart.network_calls !== 0 || !fs.existsSync(quickstartOutput)) {
    throw new Error("Installed quickstart did not produce zero-network proof artefacts");
  }

  const packageRoot = process.platform === "win32"
    ? path.join(prefix, "node_modules", packageMetadata.name)
    : path.join(prefix, "lib", "node_modules", packageMetadata.name);
  const chatHelp = execFileSync(cli, ["chat", "--help"], {
    cwd: consumerDirectory,
    env: cleanEnv,
    encoding: "utf8"
  });
  if (!chatHelp.includes("--tui") || !chatHelp.includes("--plain")) {
    throw new Error("Installed chat help did not expose terminal mode selection");
  }
  execFileSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `await import(${JSON.stringify(pathToFileURL(path.join(packageRoot, "dist", "src", "agent", "tui.js")).href)})`
  ], {
    cwd: consumerDirectory,
    env: cleanEnv,
    encoding: "utf8"
  });
  const visionAdapter = path.join(packageRoot, "scripts", "ocr-vision.swift");
  if (!fs.existsSync(visionAdapter)) {
    throw new Error(`Installed package is missing the macOS Vision adapter: ${visionAdapter}`);
  }

  execFileSync(process.execPath, ["scripts/smoke-mcp.mjs", "--command", mcp, "--profile", "core"], {
    cwd: process.cwd(),
    env: cleanEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    package_name: packageMetadata.name,
    package_version: packageMetadata.version,
    installed_cli: cli,
    installed_mcp: mcp,
    doctor_entrypoints_exist: true,
    quickstart_network_calls: 0,
    chat_tui_importable: true,
    vision_adapter_present: true,
    mcp_profile: "core"
  }, null, 2)}\n`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
