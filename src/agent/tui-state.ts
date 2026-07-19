import { HarnessError } from "../errors.js";
import type { AgentEvent } from "./events.js";

type EntryKind = "user" | "assistant" | "reasoning" | "tool" | "tool_ok" | "tool_error" | "system" | "error";
type TranscriptEntry = { readonly kind: EntryKind; readonly text: string };

export type TuiState = { readonly entries: readonly TranscriptEntry[]; readonly currentText: string; readonly currentReasoning: string; readonly status: "idle" | "running"; readonly tokens: number };

export type TuiAction = { readonly type: "submit"; readonly input: string } | { readonly type: "event"; readonly event: AgentEvent }
  | { readonly type: "message"; readonly message: string } | { readonly type: "error"; readonly message: string } | { readonly type: "clear" };

export function initialTuiState(): TuiState { return { entries: [], currentText: "", currentReasoning: "", status: "idle", tokens: 0 }; }

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "submit":
      return { ...state, entries: append(state.entries, { kind: "user", text: action.input }), currentText: "", currentReasoning: "", status: "running" };
    case "message":
      return { ...state, entries: append(state.entries, { kind: "system", text: action.message }) };
    case "error":
      return { ...state, entries: append(state.entries, { kind: "error", text: action.message }), currentText: "", currentReasoning: "", status: "idle" };
    case "clear":
      return { ...state, entries: [], currentText: "", currentReasoning: "" };
    case "event":
      return reduceAgentEvent(state, action.event);
    default:
      return assertNever(action);
  }
}

export function transcriptLines(state: TuiState, maxRows: number): readonly string[] {
  const pending = [
    ...state.entries,
    ...(state.currentReasoning ? [{ kind: "reasoning", text: state.currentReasoning } satisfies TranscriptEntry] : []),
    ...(state.currentText ? [{ kind: "assistant", text: state.currentText } satisfies TranscriptEntry] : []),
  ];
  return pending.flatMap((entry) => entry.text.split("\n").map((line, index) => `${index === 0 ? prefix(entry.kind) : "  "}${line}`))
    .slice(-Math.max(0, maxRows));
}

export function composerSegments(draft: string, position: number): { readonly before: string; readonly cursor: string; readonly after: string } {
  const cursor = Math.max(0, Math.min(position, draft.length));
  return { before: draft.slice(0, cursor), cursor: draft[cursor] ?? " ", after: draft.slice(cursor + (cursor < draft.length ? 1 : 0)) };
}

export function shouldExitOnCtrlD(draft: string): boolean { return draft.length === 0; }

function reduceAgentEvent(state: TuiState, event: AgentEvent): TuiState {
  switch (event.type) {
    case "text_delta": return { ...state, currentText: state.currentText + event.delta };
    case "reasoning_delta": return { ...state, currentReasoning: state.currentReasoning + event.delta };
    case "tool_start": {
      const reasoning = state.currentReasoning ? [{ kind: "reasoning", text: state.currentReasoning } satisfies TranscriptEntry] : [];
      const response = state.currentText ? [{ kind: "assistant", text: state.currentText } satisfies TranscriptEntry] : [];
      return { ...state, entries: append(state.entries, ...reasoning, ...response, { kind: "tool", text: `${event.name} ${JSON.stringify(event.params)}` }), currentText: "", currentReasoning: "" };
    }
    case "tool_end": return { ...state, entries: append(state.entries, { kind: event.error ? "tool_error" : "tool_ok", text: `${event.name} — ${event.summary}` }) };
    case "usage": return { ...state, tokens: event.usage.total_tokens };
    case "turn_complete": {
      const pending = state.currentReasoning ? [{ kind: "reasoning", text: state.currentReasoning } satisfies TranscriptEntry] : [];
      const response = state.currentText ? [{ kind: "assistant", text: state.currentText } satisfies TranscriptEntry] : [];
      return { ...state, entries: append(state.entries, ...pending, ...response), currentText: "", currentReasoning: "", status: "idle", tokens: event.tokens };
    }
    default: return assertNever(event);
  }
}

function append(entries: readonly TranscriptEntry[], ...next: readonly TranscriptEntry[]): readonly TranscriptEntry[] {
  return [...entries, ...next].slice(-200);
}

function prefix(kind: EntryKind): string {
  switch (kind) {
    case "user": return "you › ";
    case "assistant": return "deepseek › ";
    case "reasoning": return "reasoning › ";
    case "tool": return "tool › ";
    case "tool_ok": return "tool ✓ ";
    case "tool_error": return "tool ✗ ";
    case "system": return "system › ";
    case "error": return "error › ";
    default: return assertNever(kind);
  }
}

function assertNever(value: never): never {
  throw new HarnessError("unexpected_tui_state_variant", `Unexpected TUI state variant: ${String(value)}.`);
}
