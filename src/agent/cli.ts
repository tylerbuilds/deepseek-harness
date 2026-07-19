import * as readline from "node:readline";
import { HarnessError, usageError } from "../errors.js";
import { defaultArtifactRoot } from "../paths.js";
import { HarnessStore } from "../store.js";
import { agentTurn } from "./loop.js";
import type { AgentCallbacks } from "./events.js";
import { formatCorpusJob, loadCorpusJobs } from "./jobs.js";
import {
  createSession,
  listSessions,
  resumeSession,
  updateSessionSummary,
  type AgentSession,
} from "./session.js";
import { getApiKey } from "./stream.js";
import {
  createToolRegistry,
  type Tier2Gate,
  type ToolApprovalRequest,
  type ToolRegistry,
} from "./tools.js";

const STATE_DIR = process.env.DEEPSEEK_HARNESS_STATE_DIR ?? ".state";

export type ChatOptions = {
  readonly sessionId?: string;
  readonly model?: string;
  readonly list?: boolean;
  readonly prompt?: string;
  readonly plain?: boolean;
  readonly tui?: boolean;
};

export type ChatIo = {
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
};

export type ChatMode = "list" | "prompt" | "plain" | "tui";
export type ApprovalChoice = "once" | "session" | "decline";
export type ApprovalRequester = (request: ToolApprovalRequest) => Promise<ApprovalChoice>;

export function selectChatMode(options: ChatOptions, io: ChatIo): ChatMode {
  if (options.plain && options.tui) {
    throw usageError(
      "invalid_chat_mode",
      "--plain and --tui are mutually exclusive.",
      "deepseek-harness chat --plain",
    );
  }
  if (options.tui && (options.list || options.prompt !== undefined)) {
    throw usageError(
      "invalid_chat_mode",
      "--tui requires an interactive chat without --list or a prompt.",
      "deepseek-harness chat --tui",
    );
  }
  const interactiveTerminal = io.stdinIsTTY && io.stdoutIsTTY;
  if (options.tui && !interactiveTerminal) {
    throw usageError(
      "tui_requires_tty",
      "--tui requires a TTY on both stdin and stdout.",
      "deepseek-harness chat --plain",
    );
  }
  if (options.list) return "list";
  if (options.prompt !== undefined) return "prompt";
  if (options.plain || !interactiveTerminal) return "plain";
  return "tui";
}

export function createSessionApprovalGate(requestApproval: ApprovalRequester): Tier2Gate {
  const approvedTools = new Set<string>();
  return {
    async check(toolName, params) {
      if (approvedTools.has(toolName)) {
        return { allowed: true, scope: "session" };
      }
      const choice = await requestApproval({ toolName, params });
      switch (choice) {
        case "once":
          return { allowed: true, scope: "once" };
        case "session":
          approvedTools.add(toolName);
          return { allowed: true, scope: "session" };
        case "decline":
          return { allowed: false, reason: "Declined by the operator." };
        default:
          throw usageError("invalid_approval_choice", `Unknown approval choice: ${String(choice)}.`, "Choose y, s, or n.");
      }
    },
  };
}

export function createPlainApprovalGate(interactiveTerminal: boolean, requestApproval: ApprovalRequester): Tier2Gate {
  return createSessionApprovalGate(interactiveTerminal ? requestApproval : async () => "decline");
}

export function formatApprovalRequest(request: ToolApprovalRequest): string {
  return `Tool: ${request.toolName}\nParameters:\n${JSON.stringify(request.params, null, 2)}`;
}

export async function chatCommand(
  options: ChatOptions,
  io: ChatIo = {
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
  },
): Promise<void> {
  const mode = selectChatMode(options, io);
  const store = new HarnessStore(STATE_DIR);
  try {
    if (mode === "list") {
      writeSessions(store, 20);
      return;
    }
    const session = options.sessionId
      ? resumeSession(store, options.sessionId)
      : createSession(store, process.cwd(), options.model ?? "deepseek-v4-flash");
    if (mode === "tui") {
      const { runTui } = await import("./tui.js");
      await runTui(session, getApiKey());
      return;
    }
    writePlainHeader(session, options.sessionId !== undefined);
    if (mode === "prompt") {
      const registry = createToolRegistry();
      registry.setTier2Gate(createPlainApprovalGate(false, async () => "decline"));
      await executePlainTurn(session, options.prompt ?? "", registry);
      return;
    }
    await runPlainRepl(session, store, io);
  } finally {
    store.close();
  }
}

async function runPlainRepl(session: AgentSession, store: HarnessStore, io: ChatIo): Promise<void> {
  const terminal = io.stdinIsTTY && io.stdoutIsTTY;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal });
  const registry = createToolRegistry();
  registry.setTier2Gate(createPlainApprovalGate(terminal, (request) => askPlainApproval(rl, request)));
  if (terminal) process.stdout.write("\n> ");
  try {
    for await (const line of rl) {
      const input = line.trim();
      if (!input) {
        if (terminal) process.stdout.write("> ");
        continue;
      }
      if (input.startsWith("/")) {
        const keepRunning = handlePlainSlashCommand(input, session, store);
        if (!keepRunning) break;
      } else {
        if (terminal) {
          await runInteractivePlainTurn(session, input, registry);
        } else {
          await executePlainTurn(session, input, registry);
        }
      }
      if (terminal) process.stdout.write("\n> ");
    }
  } finally {
    rl.close();
  }
}

async function executePlainTurn(session: AgentSession, input: string, registry: ToolRegistry): Promise<void> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new HarnessError("deepseek_api_key_not_present", "DEEPSEEK_API_KEY is not set. Chat requires a DeepSeek API key.");
  }
  const callbacks: AgentCallbacks = {
    onText: (text) => process.stdout.write(text),
    onToolStart: (name) => process.stdout.write(`\n  ${name}...`),
    onToolEnd: (_name, summary, error) => process.stdout.write(` ${error ? "failed" : "done"}: ${summary}\n`),
    onTurnEnd: () => {
      if (session.record.message_count <= 5) {
        updateSessionSummary(session, `${input.slice(0, 80)}${input.length > 80 ? "..." : ""}`);
      }
    },
  };
  await agentTurn(session, apiKey, input, callbacks, registry, {
    baseUrl: process.env.DEEPSEEK_API_BASE_URL,
  });
  process.stdout.write("\n");
}

async function runInteractivePlainTurn(session: AgentSession, input: string, registry: ToolRegistry): Promise<void> {
  try {
    await executePlainTurn(session, input, registry);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\nError: ${message}\n`);
  }
}

function handlePlainSlashCommand(input: string, session: AgentSession, store: HarnessStore): boolean {
  const command = input.slice(1).split(/\s+/, 1)[0] ?? "";
  switch (command) {
    case "exit":
    case "quit":
      process.stdout.write("Goodbye.\n");
      return false;
    case "help":
      process.stdout.write("\n/help /clear /cost /sessions /jobs /exit\n");
      return true;
    case "clear":
      if (process.stdout.isTTY) process.stdout.write("\u001B[2J\u001B[H");
      return true;
    case "cost":
      process.stdout.write(`Session cost: $${session.record.total_cost_usd.toFixed(6)} (${session.record.total_tokens} tokens)\n`);
      return true;
    case "list":
    case "sessions":
      writeSessions(store, 10, session.id);
      return true;
    case "jobs": {
      const jobs = loadCorpusJobs(defaultArtifactRoot());
      process.stdout.write(jobs.length === 0 ? "No corpus jobs found.\n" : `${jobs.map(formatCorpusJob).join("\n")}\n`);
      return true;
    }
    default:
      process.stdout.write(`Unknown command: /${command}. Type /help for available commands.\n`);
      return true;
  }
}

function askPlainApproval(rl: readline.Interface, request: ToolApprovalRequest): Promise<ApprovalChoice> {
  process.stdout.write(`\nApproval required\n${formatApprovalRequest(request)}\n`);
  return new Promise((resolve) => {
    rl.question("Approve [y] once, [s] session, [n] decline: ", (answer) => {
      const choice = answer.trim().toLowerCase();
      resolve(choice === "y" ? "once" : choice === "s" ? "session" : "decline");
    });
  });
}

function writePlainHeader(session: AgentSession, resumed: boolean): void {
  process.stdout.write(resumed ? `Resumed session: ${session.id}\n` : "DeepSeek Harness Chat v0.1.0\n");
  process.stdout.write(`Session: ${session.id}\nModel: ${session.model}  CWD: ${session.cwd}\n`);
  process.stdout.write("Type /help for commands, /exit to quit.\n");
}

function writeSessions(store: HarnessStore, limit: number, currentId?: string): void {
  const sessions = listSessions(store, limit);
  if (sessions.length === 0) {
    process.stdout.write("No sessions found.\n");
    return;
  }
  for (const session of sessions) {
    const marker = session.id === currentId ? "*" : " ";
    process.stdout.write(`${marker} ${session.id}  ${session.updated_at.slice(0, 19)}  ${session.model}  $${session.total_cost_usd.toFixed(4)}  ${session.summary || "-"}\n`);
  }
}
