#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const packageManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const declaredFiles = packageManifest.files;
const policyError = (message, details = {}) => {
  throw new Error(JSON.stringify({ message, ...details }, null, 2));
};

if (!Array.isArray(declaredFiles) || declaredFiles.length === 0) {
  policyError("Package content policy failed: package.json must declare a non-empty files allowlist");
}

const invalidDeclarations = declaredFiles.filter(
  (entry) =>
    typeof entry !== "string" ||
    entry.length === 0 ||
    entry.startsWith("/") ||
    entry.endsWith("/") ||
    entry.split("/").includes("..") ||
    /[*?\[\]{}!]/.test(entry)
);

if (invalidDeclarations.length > 0) {
  policyError("Package content policy failed: files allowlist must contain explicit relative paths", {
    invalid_allowlist_entries: invalidDeclarations
  });
}

const output = execFileSync(npmCommand, ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});
const packages = JSON.parse(output);
const files = packages[0]?.files?.map((entry) => entry.path).sort() ?? [];
const required = ["LICENSE", "README.md", "package.json", "dist/src/cli.js", "dist/src/mcp.js", "scripts/install-local.sh"];
const npmAlwaysIncluded = ["LICENSE", "README.md", "package.json"];
const allowed = new Set([...declaredFiles, ...npmAlwaysIncluded]);

const missing = required.filter((path) => !files.includes(path));
const missingDeclared = declaredFiles.filter((path) => !files.includes(path));
const unexpected = files.filter((path) => !allowed.has(path));

if (missing.length > 0 || missingDeclared.length > 0 || unexpected.length > 0) {
  policyError("Package content policy failed", {
    missing_required_files: missing,
    missing_declared_files: missingDeclared,
    unexpected_files: unexpected
  });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      package_name: packages[0]?.name,
      package_version: packages[0]?.version,
      allowlist_mode: "explicit-files-only",
      file_count: files.length,
      files
    },
    null,
    2
  )
);
