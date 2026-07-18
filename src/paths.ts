import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { HarnessError } from "./errors.js";

export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function defaultStateDir(): string {
  return process.env.DEEPSEEK_HARNESS_STATE_DIR
    ? path.resolve(process.env.DEEPSEEK_HARNESS_STATE_DIR)
    : path.resolve(process.cwd(), ".state");
}

export function defaultArtifactRoot(): string {
  return process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR
    ? path.resolve(process.env.DEEPSEEK_HARNESS_ARTIFACT_DIR)
    : path.resolve(process.cwd(), "artifacts");
}

export function defaultCorpusInputRoot(): string {
  return process.env.DEEPSEEK_HARNESS_INPUT_ROOT
    ? path.resolve(process.env.DEEPSEEK_HARNESS_INPUT_ROOT)
    : path.resolve(process.cwd());
}

export function assertSafeCorpusSourcePath(
  candidate: string,
  inputRoot: string = defaultCorpusInputRoot()
): string {
  if (typeof candidate !== "string" || candidate.trim().length === 0 || candidate.includes("\0")) {
    throw new HarnessError("corpus_input_path_blocked", "Corpus input path must be a non-empty local path");
  }

  const root = path.resolve(inputRoot);
  const filesystemRoot = path.parse(root).root;
  if (root === filesystemRoot) {
    throw new HarnessError("corpus_input_root_invalid", "Corpus input root must be narrower than the filesystem root");
  }

  let realRoot: string;
  try {
    if (!fs.statSync(root).isDirectory()) {
      throw new Error("not a directory");
    }
    realRoot = fs.realpathSync(root);
  } catch {
    throw new HarnessError("corpus_input_root_invalid", "Configured corpus input root must be an existing directory");
  }
  if (realRoot === path.parse(realRoot).root) {
    throw new HarnessError("corpus_input_root_invalid", "Corpus input root must be narrower than the filesystem root");
  }

  const resolved = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(root, candidate);
  assertSafeSourcePath(resolved);
  const lexicalRoot = isWithin(resolved, root) ? root : realRoot;
  if (!isWithin(resolved, root) && !isWithin(resolved, realRoot)) {
    throw new HarnessError(
      "corpus_input_path_blocked",
      "Corpus input must remain within DEEPSEEK_HARNESS_INPUT_ROOT"
    );
  }

  const realPath = inspectExistingPath(resolved, lexicalRoot, realRoot, {
    danglingCode: "corpus_input_path_blocked",
    danglingMessage: "Corpus input path contains a dangling symlink",
    escapeCode: "corpus_input_path_blocked",
    escapeMessage: "Corpus input resolves outside DEEPSEEK_HARNESS_INPUT_ROOT",
    rejectSymlinks: true,
    symlinkMessage: "Corpus input path must not contain symlinks"
  });
  const safePath = realPath ?? resolved;
  if (realPath !== undefined) {
    assertSafeSourcePath(realPath);
    const sourceStats = fs.statSync(safePath);
    if (sourceStats.isFile() && sourceStats.nlink > 1) {
      throw new HarnessError(
        "corpus_input_path_blocked",
        "Corpus input must not be a hard-linked regular file"
      );
    }
  }
  return safePath;
}

/** Resolve an untrusted output argument beneath a trusted artefact root. */
export function resolveArtifactOutputPath(artifactRoot: string, candidate: string): string {
  const root = path.resolve(artifactRoot);
  const output = resolveArtifactCandidate(root, candidate);
  if (!isWithin(output, root)) {
    throw new HarnessError("artifact_output_path_blocked", "Harness output must remain within the configured artifact root");
  }
  let realRoot: string;
  try {
    fs.mkdirSync(root, { recursive: true });
    realRoot = fs.realpathSync(root);
  } catch {
    throw new HarnessError("artifact_output_path_blocked", "Configured artifact root is not a writable directory");
  }
  inspectExistingPath(output, root, realRoot, {
    danglingCode: "artifact_output_path_blocked",
    danglingMessage: "Harness output path contains a dangling symlink",
    escapeCode: "artifact_output_path_blocked",
    escapeMessage: "Harness output resolves outside the configured artifact root"
  });
  return output;
}

export function writeArtifactOutput(
  artifactRoot: string,
  candidate: string,
  body: string | NodeJS.ArrayBufferView
): string {
  const output = resolveArtifactOutputPath(artifactRoot, candidate);
  const root = path.resolve(artifactRoot);
  const parent = path.dirname(output);
  let realRoot: string;
  let realParent: string;
  try {
    fs.mkdirSync(parent, { recursive: true });
    realRoot = fs.realpathSync(root);
    realParent = fs.realpathSync(parent);
  } catch {
    throw new HarnessError("artifact_output_path_blocked", "Configured artifact output directory is not writable");
  }
  if (!isWithin(realParent, realRoot)) {
    throw new HarnessError("artifact_output_path_blocked", "Harness output resolves outside the configured artifact root");
  }

  const finalPath = path.join(realParent, path.basename(output));
  const temporaryPath = path.join(realParent, `.${path.basename(output)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600
    );
    if (!fs.fstatSync(fd).isFile()) {
      throw new HarnessError("artifact_output_path_blocked", "Harness output must be a regular file");
    }
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    const currentParent = fs.realpathSync(parent);
    if (currentParent !== realParent || !isWithin(currentParent, realRoot)) {
      throw new HarnessError("artifact_output_path_blocked", "Harness output directory changed during write");
    }
    fs.renameSync(temporaryPath, finalPath);
    fsyncDirectory(realParent);
    return output;
  } catch (error) {
    if (error instanceof HarnessError) {
      throw error;
    }
    throw new HarnessError("artifact_output_path_blocked", "Harness output path could not be opened safely");
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

export function writeArtifactOutputNoClobber(artifactRoot: string, candidate: string, body: string): string {
  const output = resolveArtifactOutputPath(artifactRoot, candidate);
  const root = path.resolve(artifactRoot);
  const parent = path.dirname(output);
  let realRoot: string;
  let realParent: string;
  try {
    fs.mkdirSync(parent, { recursive: true });
    realRoot = fs.realpathSync(root);
    realParent = fs.realpathSync(parent);
  } catch {
    throw new HarnessError("artifact_output_path_blocked", "Configured artifact output directory is not writable");
  }
  if (!isWithin(realParent, realRoot)) {
    throw new HarnessError("artifact_output_path_blocked", "Harness output resolves outside the configured artifact root");
  }

  const finalPath = path.join(realParent, path.basename(output));
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      finalPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600
    );
    if (!fs.fstatSync(fd).isFile()) {
      throw new HarnessError("artifact_output_path_blocked", "Harness output must be a regular file");
    }
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
    return output;
  } catch (error) {
    if (error instanceof HarnessError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new HarnessError("artifact_output_path_blocked", "Harness output path could not be opened safely");
    }
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }

  let existingFd: number | undefined;
  try {
    existingFd = fs.openSync(finalPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(existingFd).isFile()) {
      throw new HarnessError("artifact_output_path_blocked", "Harness output must be a regular file");
    }
    if (fs.readFileSync(existingFd, "utf8") !== body) {
      throw new HarnessError("artifact_output_exists", `Refusing to overwrite existing harness output: ${output}`);
    }
    return output;
  } catch (error) {
    if (error instanceof HarnessError) {
      throw error;
    }
    throw new HarnessError("artifact_output_path_blocked", "Harness output path could not be opened safely");
  } finally {
    if (existingFd !== undefined) {
      fs.closeSync(existingFd);
    }
  }
}

function assertSafeSourcePath(filePath: string): void {
  const segments = path.resolve(filePath).split(path.sep).filter(Boolean).map((segment) => segment.toLowerCase());
  const normalised = `/${segments.join("/")}/`;
  const forbidden = ["/.ssh/", "/.gnupg/", "/library/keychains/", "/.config/opencode/auth", "/.codex/auth"];
  if (/\/users\/[^/]+\/documents\/obsidian(?:\/|$)/i.test(normalised) || forbidden.some((part) => normalised.includes(part))) {
    throw new HarnessError("corpus_path_forbidden", "Corpus path is forbidden or protected and cannot be ingested");
  }
  const sensitiveSegments = new Set([
    ".aws", ".git", ".kube", ".netrc", ".npmrc", ".pypirc", "certs", "certificates",
    "credential", "credentials", "keychain", "keychains", "passwords", "private-keys", "private_keys",
    "private-workspace-state", "secret", "secrets", "token", "tokens"
  ]);
  const basename = segments.at(-1) ?? "";
  const sensitiveName = basename === ".env"
    || basename.startsWith(".env.")
    || /^(?:authorized_keys|id_(?:dsa|ecdsa|ed25519|rsa)|known_hosts)$/i.test(basename)
    || /\.(?:jks|key|keystore|p12|pem|pfx)$/i.test(basename)
    || /(?:^|[._-])(?:auth|credential|password|private[-_]?key|secret|token)(?:[._-]|$)/i.test(basename);
  if (segments.some((segment) => sensitiveSegments.has(segment)) || sensitiveName || segments[0] === "etc" || segments[0] === "system") {
    throw new HarnessError("corpus_sensitive_source_path_blocked", "Corpus source path is sensitive and cannot be ingested");
  }
}

function resolveArtifactCandidate(root: string, candidate: string): string {
  if (typeof candidate !== "string" || candidate.trim().length === 0 || candidate.includes("\0")) {
    throw new HarnessError("artifact_output_path_blocked", "Harness output path must be a non-empty local path");
  }
  if (path.isAbsolute(candidate)) {
    return path.resolve(candidate);
  }
  const segments = candidate.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== ".");
  const relativeSegments = segments[0]?.toLowerCase() === "artifacts" ? segments.slice(1) : segments;
  return path.resolve(root, ...relativeSegments);
}

interface ExistingPathErrors {
  danglingCode: string;
  danglingMessage: string;
  escapeCode: string;
  escapeMessage: string;
  rejectSymlinks?: boolean;
  symlinkMessage?: string;
}

function inspectExistingPath(
  candidate: string,
  root: string,
  realRoot: string,
  errors: ExistingPathErrors
): string | undefined {
  const relative = path.relative(root, candidate);
  const segments = relative === "" ? [] : relative.split(path.sep).filter(Boolean);
  let current = root;
  let currentReal = realRoot;

  for (const segment of segments) {
    current = path.join(current, segment);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw new HarnessError(errors.escapeCode, errors.escapeMessage);
    }

    if (stats.isSymbolicLink() && errors.rejectSymlinks) {
      throw new HarnessError(errors.escapeCode, errors.symlinkMessage ?? errors.escapeMessage);
    }

    try {
      currentReal = fs.realpathSync(current);
    } catch {
      if (stats.isSymbolicLink()) {
        throw new HarnessError(errors.danglingCode, errors.danglingMessage);
      }
      throw new HarnessError(errors.escapeCode, errors.escapeMessage);
    }
    if (!isWithin(currentReal, realRoot)) {
      throw new HarnessError(errors.escapeCode, errors.escapeMessage);
    }
  }

  return segments.length === 0 || fs.existsSync(candidate) ? currentReal : undefined;
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
