import { useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";
import { HarnessError } from "../errors.js";
import { defaultArtifactRoot } from "../paths.js";
import { agentTurn } from "./loop.js";
import { formatCorpusJob, loadCorpusJobs, type CorpusJob } from "./jobs.js";
import { listSessions, updateSessionSummary, type AgentSession } from "./session.js";
import { createToolRegistry, type ToolApprovalRequest } from "./tools.js";
import { createSessionApprovalGate, formatApprovalRequest, type ApprovalChoice } from "./cli.js";
import { composerSegments, initialTuiState, shouldExitOnCtrlD, transcriptLines, tuiReducer } from "./tui-state.js";
import { bold, dim, grey, gold } from "./theme.js";

const MOTD = [
  `⚡ ${bold("MorpheOS Code")} — ${dim("Captain Zeus at the helm")}`,
  "",
  `${grey("Type /help for orders. /exit to leave the bridge.")}`,
  `${grey("Powered by DeepSeek V4 · British English · Ship metaphors encouraged")}`,
];

function zeusError(raw: string): string {
  if (raw.includes("401") || raw.includes("unauthorized")) return "The DeepSeek harbour master refused our credentials, Captain. Check your API key.";
  if (raw.includes("402")) return "Insufficient credits — the coffer's run dry. Top up at platform.deepseek.com.";
  if (raw.includes("429")) return "Rate limit hit — we're knocking too loudly at the harbour gate. Give it a moment.";
  if (raw.includes("timeout") || raw.includes("timed out")) return "DeepSeek hasn't answered our hail, Captain. The line may be down.";
  if (raw.includes("aborted")) return "Course aborted, Captain.";
  if (raw.includes("DEEPSEEK_API_KEY")) return "No API key in the chart room, Captain. Set DEEPSEEK_API_KEY in your environment.";
  return raw;
}

type SlashCommand = { readonly kind: "exit" } | { readonly kind: "clear" } | { readonly kind: "message"; readonly message: string } | { readonly kind: "jobs"; readonly jobs: readonly CorpusJob[] } | { readonly kind: "thinking" };

export async function runTui(session: AgentSession, apiKey: string): Promise<void> {
  const instance = render(<ChatTui session={session} apiKey={apiKey} />, { alternateScreen: true, exitOnCtrlC: false, patchConsole: false });
  await instance.waitUntilExit();
}

function ChatTui({ session, apiKey }: { readonly session: AgentSession; readonly apiKey: string }) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [state, dispatch] = useReducer(tuiReducer, undefined, initialTuiState);
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<readonly string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [jobs, setJobs] = useState<readonly CorpusJob[]>(() => loadCorpusJobs(defaultArtifactRoot()));
  const [approval, setApproval] = useState<ToolApprovalRequest | null>(null);
  const approvalResolver = useRef<((choice: ApprovalChoice) => void) | null>(null);
  const turnController = useRef<AbortController | null>(null);
  const exitAfterTurn = useRef(false);
  const registry = useMemo(() => {
    const next = createToolRegistry();
    next.setTier2Gate(createSessionApprovalGate((request) => new Promise((resolve) => {
      approvalResolver.current = resolve;
      setApproval(request);
    })));
    return next;
  }, []);

  const resolveApproval = (choice: ApprovalChoice): void => {
    const resolve = approvalResolver.current;
    approvalResolver.current = null;
    setApproval(null);
    resolve?.(choice);
  };

  const submit = (raw: string): void => {
    const input = raw.trim();
    if (!input || state.status === "running") return;
    setDraft("");
    setCursor(0);
    setHistory((current) => [...current, input].slice(-100));
    setHistoryIndex(null);
    if (input.startsWith("/")) {
      const command = slashCommand(input, session, state.showThinking);
      switch (command.kind) {
        case "exit": exit(); break;
        case "clear": dispatch({ type: "clear" }); break;
        case "message": dispatch({ type: "message", message: command.message }); break;
        case "jobs":
          setJobs(command.jobs);
          dispatch({ type: "message", message: command.jobs.map(formatCorpusJob).join("\n") || "No corpus jobs found." });
          break;
        case "thinking":
          dispatch({ type: "toggleThinking" });
          dispatch({ type: "message", message: state.showThinking ? "Thinking hidden." : "Thinking visible." });
          break;
        default: assertNever(command);
      }
      return;
    }
    dispatch({ type: "submit", input });
    if (!apiKey) {
      dispatch({ type: "error", message: "DEEPSEEK_API_KEY is not set." });
      return;
    }
    const controller = new AbortController();
    turnController.current = controller;
    void agentTurn(session, apiKey, input, (event) => dispatch({ type: "event", event }), registry, {
      signal: controller.signal,
      baseUrl: process.env.DEEPSEEK_API_BASE_URL,
    })
      .then(() => {
        if (session.record.message_count <= 5) updateSessionSummary(session, `${input.slice(0, 80)}${input.length > 80 ? "..." : ""}`);
        setJobs(loadCorpusJobs(defaultArtifactRoot()));
      })
      .catch((error: unknown) => dispatch({ type: "error", message: zeusError(controller.signal.aborted ? "aborted" : error instanceof Error ? error.message : String(error)) }))
      .finally(() => { turnController.current = null; if (exitAfterTurn.current) exit(); });
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (turnController.current) {
        resolveApproval("decline");
        turnController.current.abort();
      } else {
        exit();
      }
      return;
    }
    if (key.ctrl && input === "d") {
      if (!shouldExitOnCtrlD(draft)) return;
      resolveApproval("decline");
      if (turnController.current) {
        exitAfterTurn.current = true;
        turnController.current.abort();
      } else {
        exit();
      }
      return;
    }
    if (approval) {
      if (input === "y") resolveApproval("once");
      if (input === "s") resolveApproval("session");
      if (input === "n") resolveApproval("decline");
      return;
    }
    if (key.return) return submit(draft);
    if (key.leftArrow) return setCursor((value) => Math.max(0, value - 1));
    if (key.rightArrow) return setCursor((value) => Math.min(draft.length, value + 1));
    if (key.home) return setCursor(0);
    if (key.end) return setCursor(draft.length);
    if (key.backspace && cursor > 0) {
      setDraft(`${draft.slice(0, cursor - 1)}${draft.slice(cursor)}`);
      setCursor(cursor - 1);
      return;
    }
    if (key.delete && cursor < draft.length) {
      setDraft(`${draft.slice(0, cursor)}${draft.slice(cursor + 1)}`);
      return;
    }
    if (key.upArrow && history.length > 0) {
      const next = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      const value = history[next] ?? "";
      setHistoryIndex(next); setDraft(value); setCursor(value.length); return;
    }
    if (key.downArrow && historyIndex !== null) {
      const next = historyIndex + 1;
      const value = next < history.length ? history[next] ?? "" : "";
      setHistoryIndex(next < history.length ? next : null); setDraft(value); setCursor(value.length); return;
    }
    if (input && !key.ctrl && !key.meta) {
      setDraft(`${draft.slice(0, cursor)}${input}${draft.slice(cursor)}`);
      setCursor(cursor + input.length);
    }
  });

  const transcriptRows = Math.max(3, rows - (approval ? 15 : 9));
  const lines = transcriptLines(state, transcriptRows);
  const segments = composerSegments(draft, cursor);
  const showPanel = columns >= 76;
  return <Box width={columns} height={rows} flexDirection="column">
    <Box borderStyle="single" borderColor="yellow" paddingX={1} justifyContent="space-between">
      <Text bold color="yellow">⚡ MorpheOS Code</Text><Text dimColor>{state.status === "running" ? "under way" : "standing by"} · {session.model === "deepseek-v4-pro" ? "Pro" : "Flash"}</Text>
    </Box>
    <Box flexGrow={1} overflow="hidden">
      <Box flexDirection="column" flexGrow={1} borderStyle="single" paddingX={1} overflow="hidden">
        {lines.length === 0 ? MOTD.map((line, i) => <Text key={`motd-${i}`} dimColor={i > 0}>{line}</Text>) : lines.map((line, index) => <Text key={`${index}-${line}`} wrap="truncate-end">{line}</Text>)}
      </Box>
      {showPanel ? <Box width={32} flexDirection="column" borderStyle="single" paddingX={1}>
        <Text bold color="yellow">Captain's Log</Text>
        <Text dimColor wrap="truncate-end">{session.id}</Text>
        <Text>{session.model === "deepseek-v4-pro" ? "Pro" : "Flash"} engines</Text>
        <Text>£{session.record.total_cost_usd.toFixed(6)}</Text>
        <Text>{session.record.total_tokens} tokens</Text>
        <Text bold color="yellow">Cargo Bay</Text>
        {jobs.length === 0 ? <Text dimColor>empty</Text> : jobs.map((job) => <Text key={job.jobId} wrap="truncate-end">{formatCorpusJob(job)}</Text>)}
      </Box> : null}
    </Box>
    {approval ? <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">Captain's authorisation required</Text><Text>{formatApprovalRequest(approval)}</Text><Text dimColor>[y] once  [s] session  [n] decline</Text>
    </Box> : null}
    <Box borderStyle="single" borderColor={state.status === "running" ? "yellow" : "green"} paddingX={1} justifyContent="space-between">
      <Text>❯ {segments.before}<Text inverse>{segments.cursor}</Text>{segments.after}</Text>
      <Text dimColor>Ctrl+C exit · /help</Text>
    </Box>
  </Box>;
}

function slashCommand(input: string, session: AgentSession, showThinking: boolean): SlashCommand {
  const command = input.slice(1).split(/\s+/, 1)[0] ?? "";
  switch (command) {
    case "help": return { kind: "message", message: `/help  /clear  /cost  /sessions  /jobs  /thinking  /exit
${grey("Captain's bridge commands. All ship-shape and Bristol fashion.")}` };
    case "clear": return { kind: "clear" };
    case "cost": return { kind: "message", message: `Fuel consumed: £${session.record.total_cost_usd.toFixed(6)} (${session.record.total_tokens} tokens across ${session.record.message_count} messages)` };
    case "sessions": return { kind: "message", message: listSessions(session.store, 10).map((item) => `${item.id === session.id ? "*" : " "} ${item.id} ${item.model} £${item.total_cost_usd.toFixed(4)} ${item.summary || "-"}`).join("\n") || "No previous voyages found." };
    case "jobs": return { kind: "jobs", jobs: loadCorpusJobs(defaultArtifactRoot()) };
    case "thinking": return { kind: "thinking" as const };
    case "exit": case "quit": return { kind: "exit" };
    default: return { kind: "message", message: `Unknown order: /${command}. Type /help for available commands, Captain.` };
  }
}

function assertNever(value: never): never {
  throw new HarnessError("unexpected_tui_variant", `Unexpected TUI variant: ${String(value)}.`);
}
