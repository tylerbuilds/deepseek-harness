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

type SlashCommand = { readonly kind: "exit" } | { readonly kind: "clear" } | { readonly kind: "message"; readonly message: string } | { readonly kind: "jobs"; readonly jobs: readonly CorpusJob[] };

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
      const command = slashCommand(input, session);
      switch (command.kind) {
        case "exit": exit(); break;
        case "clear": dispatch({ type: "clear" }); break;
        case "message": dispatch({ type: "message", message: command.message }); break;
        case "jobs":
          setJobs(command.jobs);
          dispatch({ type: "message", message: command.jobs.map(formatCorpusJob).join("\n") || "No corpus jobs found." });
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
      .catch((error: unknown) => dispatch({ type: "error", message: controller.signal.aborted ? "Turn interrupted." : error instanceof Error ? error.message : String(error) }))
      .finally(() => { turnController.current = null; if (exitAfterTurn.current) exit(); });
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (turnController.current) {
        resolveApproval("decline");
        turnController.current.abort();
      } else {
        setDraft("");
        setCursor(0);
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
    <Box borderStyle="single" borderColor="cyan" paddingX={1} justifyContent="space-between">
      <Text bold>DeepSeek Harness</Text><Text>{state.status === "running" ? "working" : "ready"} · {session.model}</Text>
    </Box>
    <Box flexGrow={1} overflow="hidden">
      <Box flexDirection="column" flexGrow={1} borderStyle="single" paddingX={1} overflow="hidden">
        {lines.length === 0 ? <Text dimColor>Type /help for commands.</Text> : lines.map((line, index) => <Text key={`${index}-${line}`} wrap="truncate-end">{line}</Text>)}
      </Box>
      {showPanel ? <Box width={32} flexDirection="column" borderStyle="single" paddingX={1}>
        <Text bold color="cyan">Session</Text><Text wrap="truncate-end">{session.id}</Text>
        <Text>model {session.model}</Text><Text>cost ${session.record.total_cost_usd.toFixed(6)}</Text><Text>tokens {session.record.total_tokens}</Text>
        <Text bold color="cyan">Recent corpus jobs</Text>
        {jobs.length === 0 ? <Text dimColor>none</Text> : jobs.map((job) => <Text key={job.jobId} wrap="truncate-end">{formatCorpusJob(job)}</Text>)}
      </Box> : null}
    </Box>
    {approval ? <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1}>
      <Text bold>Approve exact tool call?</Text><Text>{formatApprovalRequest(approval)}</Text><Text>[y] once  [s] this tool for session  [n] decline</Text>
    </Box> : null}
    <Box borderStyle="single" borderColor={state.status === "running" ? "yellow" : "green"} paddingX={1}>
      <Text>› {segments.before}<Text inverse>{segments.cursor}</Text>{segments.after}</Text>
    </Box>
  </Box>;
}

function slashCommand(input: string, session: AgentSession): SlashCommand {
  const command = input.slice(1).split(/\s+/, 1)[0] ?? "";
  switch (command) {
    case "help": return { kind: "message", message: "/help /clear /cost /sessions /jobs /exit" };
    case "clear": return { kind: "clear" };
    case "cost": return { kind: "message", message: `Session cost: $${session.record.total_cost_usd.toFixed(6)} (${session.record.total_tokens} tokens)` };
    case "sessions": return { kind: "message", message: listSessions(session.store, 10).map((item) => `${item.id === session.id ? "*" : " "} ${item.id} ${item.model} $${item.total_cost_usd.toFixed(4)}`).join("\n") || "No sessions found." };
    case "jobs": return { kind: "jobs", jobs: loadCorpusJobs(defaultArtifactRoot()) };
    case "exit": case "quit": return { kind: "exit" };
    default: return { kind: "message", message: `Unknown command: /${command}. Type /help.` };
  }
}

function assertNever(value: never): never {
  throw new HarnessError("unexpected_tui_variant", `Unexpected TUI variant: ${String(value)}.`);
}
