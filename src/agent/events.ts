export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export type AgentEvent =
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | {
      type: "tool_start";
      toolCallId: string;
      name: string;
      params: Record<string, unknown>;
    }
  | {
      type: "tool_end";
      toolCallId: string;
      name: string;
      summary: string;
      error?: string;
    }
  | { type: "usage"; usage: TokenUsage }
  | {
      type: "turn_complete";
      text: string;
      reasoningContent: string;
      toolCalls: number;
      toolRounds: number;
      tokens: number;
    };

export type AgentEventSink = (event: AgentEvent) => void;

export interface AgentCallbacks {
  onText: (text: string) => void;
  onReasoning?: (reasoning: string) => void;
  onToolStart: (name: string, params: Record<string, unknown>) => void;
  onToolEnd: (name: string, summary: string, error?: string) => void;
  onUsage?: (usage: TokenUsage) => void;
  onTurnEnd: (text: string, toolCalls: number, tokens: number) => void;
}

export function callbacksToEventSink(callbacks: AgentCallbacks): AgentEventSink {
  return (event) => {
    switch (event.type) {
      case "text_delta":
        callbacks.onText(event.delta);
        break;
      case "reasoning_delta":
        callbacks.onReasoning?.(event.delta);
        break;
      case "tool_start":
        callbacks.onToolStart(event.name, event.params);
        break;
      case "tool_end":
        callbacks.onToolEnd(event.name, event.summary, event.error);
        break;
      case "usage":
        callbacks.onUsage?.(event.usage);
        break;
      case "turn_complete":
        callbacks.onTurnEnd(event.text, event.toolCalls, event.tokens);
        break;
    }
  };
}

export function toAgentEventSink(sinkOrCallbacks: AgentEventSink | AgentCallbacks): AgentEventSink {
  return typeof sinkOrCallbacks === "function"
    ? sinkOrCallbacks
    : callbacksToEventSink(sinkOrCallbacks);
}
