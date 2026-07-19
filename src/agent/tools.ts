// src/agent/tools.ts

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { exec } from "node:child_process";
import { HarnessError } from "../errors.js";

// ── Path safety ──

function resolveSafePath(filePath: string, workspaceRoot: string): string {
  if (!path.isAbsolute(filePath)) {
    throw new HarnessError("invalid_path", `File path must be absolute: ${filePath}`);
  }
  const resolved = path.resolve(filePath);
  const normalizedRoot = path.resolve(workspaceRoot);
  if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
    throw new HarnessError(
      "path_traversal_blocked",
      `Path traversal detected: "${filePath}" resolves outside the workspace root. ` +
      `All file operations must stay within the workspace.`
    );
  }
  return resolved;
}

export interface ToolParam {
  name: string;
  type: "string" | "number" | "boolean";
  description: string;
  required: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParam[];
}

export interface ToolResult {
  content: string;
  summary: string;
  error?: string;
}

export interface ToolApprovalRequest {
  toolName: string;
  params: Record<string, unknown>;
}

export type ToolApprovalScope = "once" | "session";

export interface Tier2Decision {
  allowed: boolean;
  reason?: string;
  scope?: ToolApprovalScope;
}

export interface ToolExecutionOptions {
  signal?: AbortSignal;
}

function executionSignal(options: AbortSignal | ToolExecutionOptions | undefined): AbortSignal | undefined {
  if (!options) return undefined;
  if (isToolExecutionOptions(options)) return options.signal;
  return options;
}

function isToolExecutionOptions(value: AbortSignal | ToolExecutionOptions): value is ToolExecutionOptions {
  return "signal" in value;
}

export interface Tool {
  definition: ToolDefinition;
  tier: 1 | 2;
  execute(params: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<ToolResult>;
}

export interface Tier2Gate {
  check(toolName: string, params: Record<string, unknown>): Promise<Tier2Decision>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private tier2Gate: Tier2Gate | null = null;

  setTier2Gate(gate: Tier2Gate): void {
    this.tier2Gate = gate;
  }

  register(tool: Tool): void {
    this.tools.set(tool.definition.name, tool);
  }

  describe(): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    return Array.from(this.tools.values()).map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.definition.name,
        description: tool.definition.description,
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            tool.definition.parameters.map((p) => [p.name, { type: p.type, description: p.description }])
          ),
          required: tool.definition.parameters.filter((p) => p.required).map((p) => p.name),
        },
      },
    }));
  }

  toolDescriptions(): string {
    return Array.from(this.tools.values())
      .map((t) => `- **${t.definition.name}**: ${t.definition.description}`)
      .join("\n");
  }

  async execute(
    name: string,
    params: Record<string, unknown>,
    cwd: string,
    options?: AbortSignal | ToolExecutionOptions,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { content: "", summary: `Unknown tool: ${name}`, error: `Tool ${name} not found` };
    }

    const signal = executionSignal(options);
    if (signal?.aborted) {
      return {
        content: `Tool "${name}" was cancelled before execution.`,
        summary: `CANCELLED: ${name}`,
        error: "aborted",
      };
    }

    if (tool.tier === 2) {
      if (!this.tier2Gate) {
        return {
          content: `Tool "${name}" requires authorisation. No authorisation gate has been configured.`,
          summary: `BLOCKED: ${name}`,
          error: "approval_required",
        };
      }
      let gate: Tier2Decision;
      try {
        gate = await this.tier2Gate.check(name, params);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
          content: `Tool "${name}" requires authorisation. The authorisation gate failed: ${reason}`,
          summary: `BLOCKED: ${name}`,
          error: "approval_required",
        };
      }
      if (!gate.allowed) {
        return {
          content: `Tool "${name}" requires authorisation. ${gate.reason ?? "Live operations have not been authorised for this session."}`,
          summary: `BLOCKED: ${name}`,
          error: gate.reason ?? "approval_required",
        };
      }
    }

    if (signal?.aborted) {
      return {
        content: `Tool "${name}" was cancelled before execution.`,
        summary: `CANCELLED: ${name}`,
        error: "aborted",
      };
    }

    try {
      return await tool.execute(params, cwd, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: `Error executing ${name}: ${message}`, summary: `Error: ${name}`, error: message };
    }
  }
}

// ── Tier 1 Tools ──

function makeReadFileTool(): Tool {
  return {
    definition: {
      name: "read_file",
      description: "Read a file from the local filesystem. Returns content with line numbers (cat -n format).",
      parameters: [
        { name: "file_path", type: "string", description: "Absolute path to the file to read", required: true },
        { name: "offset", type: "number", description: "Line number to start reading from", required: false },
        { name: "limit", type: "number", description: "Number of lines to read", required: false },
      ],
    },
    tier: 1,
    async execute(params, cwd): Promise<ToolResult> {
      const resolved = resolveSafePath(String(params.file_path), cwd);
      const content = fs.readFileSync(resolved, "utf8");
      const lines = content.split("\n");

      let offset = 1;
      if (params.offset !== undefined && params.offset !== null) {
        const n = Number(params.offset);
        if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
          throw new HarnessError("invalid_param", `offset must be a positive integer, got: ${params.offset}`);
        }
        offset = n;
      }

      let limit = lines.length;
      if (params.limit !== undefined && params.limit !== null) {
        const n = Number(params.limit);
        if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
          throw new HarnessError("invalid_param", `limit must be a positive integer, got: ${params.limit}`);
        }
        limit = n;
      }

      const start = Math.max(0, offset - 1);
      const end = Math.min(lines.length, start + limit);
      const slice = lines.slice(start, end);
      const numbered = slice.map((line, i) => `${String(offset + i).padStart(6)}\t${line}`).join("\n");
      return {
        content: numbered,
        summary: `Read ${slice.length} lines from ${path.basename(resolved)}`,
      };
    },
  };
}

function makeWriteFileTool(): Tool {
  return {
    definition: {
      name: "write_file",
      description: "Write or overwrite a file. Creates parent directories if needed.",
      parameters: [
        { name: "file_path", type: "string", description: "Absolute path to the file to write", required: true },
        { name: "content", type: "string", description: "Content to write", required: true },
      ],
    },
    tier: 2,
    async execute(params, cwd): Promise<ToolResult> {
      const filePath = String(params.file_path);
      const resolved = resolveSafePath(filePath, cwd);
      const content = String(params.content);
      const dir = path.dirname(resolved);
      fs.mkdirSync(dir, { recursive: true });
      const existed = fs.existsSync(resolved);
      fs.writeFileSync(resolved, content, "utf8");
      return {
        content: existed ? `Overwrote ${resolved}` : `Created ${resolved}`,
        summary: existed ? `Overwrote ${path.basename(resolved)}` : `Created ${path.basename(resolved)}`,
      };
    },
  };
}

function makeEditFileTool(): Tool {
  return {
    definition: {
      name: "edit_file",
      description: "Perform exact string replacement in a file. old_string must match exactly and be unique in the file.",
      parameters: [
        { name: "file_path", type: "string", description: "Absolute path to the file to edit", required: true },
        { name: "old_string", type: "string", description: "Exact text to replace", required: true },
        { name: "new_string", type: "string", description: "Text to replace with (must differ from old_string)", required: true },
      ],
    },
    tier: 2,
    async execute(params, cwd): Promise<ToolResult> {
      const filePath = String(params.file_path);
      const oldStr = String(params.old_string);
      const newStr = String(params.new_string);
      const resolved = resolveSafePath(filePath, cwd);
      if (oldStr === newStr) {
        throw new HarnessError("invalid_edit", "old_string and new_string must be different");
      }
      const content = fs.readFileSync(resolved, "utf8");
      const firstIndex = content.indexOf(oldStr);
      if (firstIndex === -1) {
        throw new HarnessError("edit_string_not_found", "old_string was not found in the file");
      }
      if (content.indexOf(oldStr, firstIndex + 1) !== -1) {
        throw new HarnessError("edit_string_not_unique", "old_string matches multiple locations in the file");
      }
      const newContent = content.slice(0, firstIndex) + newStr + content.slice(firstIndex + oldStr.length);
      fs.writeFileSync(resolved, newContent, "utf8");
      return {
        content: `Edited ${resolved}: replaced ${oldStr.length} chars with ${newStr.length} chars`,
        summary: `Edited ${path.basename(resolved)}`,
      };
    },
  };
}

function makeSearchContentTool(): Tool {
  return {
    definition: {
      name: "search_content",
      description: "Search file contents using ripgrep or grep. Returns matching lines with file paths and line numbers.",
      parameters: [
        { name: "pattern", type: "string", description: "Pattern to search for (regex supported)", required: true },
        { name: "directory", type: "string", description: "Directory to search in (defaults to cwd)", required: false },
        { name: "file_pattern", type: "string", description: "Glob pattern to filter files (e.g. '*.ts')", required: false },
      ],
    },
    tier: 1,
    async execute(params, cwd): Promise<ToolResult> {
      const pattern = String(params.pattern);
      const directory = typeof params.directory === "string" ? String(params.directory) : cwd;

      let stdout: string;
      try {
        const args = ["-n", "--no-heading", "-e", pattern];
        if (typeof params.file_pattern === "string") {
          args.push("--glob", String(params.file_pattern));
        }
        args.push(directory);
        stdout = execFileSync("rg", args, {
          encoding: "utf8",
          timeout: 30000,
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch {
        try {
          const grepArgs = ["-rn", "-E", pattern];
          if (typeof params.file_pattern === "string") {
            grepArgs.push("--include", String(params.file_pattern));
          }
          grepArgs.push(directory);
          stdout = execFileSync("grep", grepArgs, {
            encoding: "utf8",
            timeout: 30000,
            maxBuffer: 10 * 1024 * 1024,
          });
        } catch (grepErr: any) {
          // Both rg and grep failed — return empty results
          if (grepErr?.stderr) {
            return {
              content: `Search error: ${grepErr.stderr.toString().trim()}`,
              summary: `0 matches for "${pattern}"`,
            };
          }
          return {
            content: "No matches found.",
            summary: `0 matches for "${pattern}"`,
          };
        }
      }

      const lines = stdout.trim().split("\n").filter(Boolean);
      return {
        content: lines.length > 0 ? lines.slice(0, 50).join("\n") + (lines.length > 50 ? `\n...and ${lines.length - 50} more matches` : "") : "No matches found.",
        summary: `${lines.length} matches for "${pattern}"`,
      };
    },
  };
}

function makeSearchFilesTool(): Tool {
  return {
    definition: {
      name: "search_files",
      description: "Search for files by name pattern using find.",
      parameters: [
        { name: "pattern", type: "string", description: "Filename pattern (glob, e.g. '*.ts')", required: true },
        { name: "directory", type: "string", description: "Directory to search in (defaults to cwd)", required: false },
      ],
    },
    tier: 1,
    async execute(params, cwd): Promise<ToolResult> {
      const pattern = String(params.pattern);
      const directory = typeof params.directory === "string" ? String(params.directory) : cwd;
      const stdout = execFileSync("find", [
        directory,
        "-name", pattern,
        "-not", "-path", "*/node_modules/*",
        "-not", "-path", "*/.git/*",
      ], {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 5 * 1024 * 1024,
      });
      const files = stdout.trim().split("\n").filter(Boolean);
      return {
        content: files.length > 0 ? files.join("\n") : "No files found.",
        summary: `Found ${files.length} files matching "${pattern}"`,
      };
    },
  };
}

function makeRunCommandTool(): Tool {
  return {
    definition: {
      name: "run_command",
      description: "Execute a shell command after explicit user authorisation. Has a timeout (default 120s, max 600s). Returns stdout and stderr.",
      parameters: [
        { name: "command", type: "string", description: "The command to execute", required: true },
        { name: "timeout_ms", type: "number", description: "Timeout in milliseconds (default 120000, max 600000)", required: false },
      ],
    },
    tier: 2,
    async execute(params, cwd, signal): Promise<ToolResult> {
      const command = String(params.command);

      let timeoutMs = 120_000;
      if (params.timeout_ms !== undefined && params.timeout_ms !== null) {
        const n = Number(params.timeout_ms);
        if (!Number.isFinite(n) || n <= 0) {
          throw new HarnessError("invalid_param", `timeout_ms must be a positive number, got: ${params.timeout_ms}`);
        }
        timeoutMs = Math.min(n, 600_000);
      }

      if (signal?.aborted) {
        return {
          content: "Command cancelled before it started.",
          summary: "Command cancelled",
          error: "aborted",
        };
      }

      return new Promise((resolve) => {
        exec(command, {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 20 * 1024 * 1024,
          encoding: "utf8",
          signal,
        }, (error: any, stdout: string, stderr: string) => {
          const output = [stdout, stderr ? `\nSTDERR:\n${stderr}` : ""].filter(Boolean).join("\n").trim();
          if (signal?.aborted || error?.name === "AbortError" || error?.code === "ABORT_ERR") {
            resolve({
              content: output || "Command cancelled.",
              summary: "Command cancelled",
              error: "aborted",
            });
            return;
          }
          resolve({
            content: output || "(no output)",
            summary: error ? `Command failed with exit code ${error.code}` : "Command completed",
            error: error?.message,
          });
        });
      });
    },
  };
}

function makeListDirectoryTool(): Tool {
  return {
    definition: {
      name: "list_directory",
      description: "List the contents of a directory.",
      parameters: [
        { name: "directory", type: "string", description: "Absolute path to the directory", required: true },
      ],
    },
    tier: 1,
    async execute(params, cwd): Promise<ToolResult> {
      const dirPath = String(params.directory);
      const resolved = resolveSafePath(dirPath, cwd);
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const listing = entries.map((e) => {
        const suffix = e.isDirectory() ? "/" : e.isSymbolicLink() ? "@" : "";
        return `${e.name}${suffix}`;
      }).join("\n");
      return {
        content: listing || "(empty directory)",
        summary: `${entries.length} items in ${path.basename(resolved)}`,
      };
    },
  };
}

// ── Tier 2 Tool ──

function makeDeleteFileTool(): Tool {
  return {
    definition: {
      name: "delete_file",
      description: "Delete a file permanently. REQUIRES explicit user authorisation.",
      parameters: [
        { name: "file_path", type: "string", description: "Absolute path to the file to delete", required: true },
      ],
    },
    tier: 2,
    async execute(params, cwd): Promise<ToolResult> {
      const filePath = String(params.file_path);
      const resolved = resolveSafePath(filePath, cwd);
      fs.unlinkSync(resolved);
      return {
        content: `Deleted ${resolved}`,
        summary: `Deleted ${path.basename(resolved)}`,
      };
    },
  };
}

// ── Factory ──

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(makeReadFileTool());
  registry.register(makeWriteFileTool());
  registry.register(makeEditFileTool());
  registry.register(makeSearchContentTool());
  registry.register(makeSearchFilesTool());
  registry.register(makeRunCommandTool());
  registry.register(makeListDirectoryTool());
  registry.register(makeDeleteFileTool());
  return registry;
}
