export class HarnessError extends Error {
  readonly code: string;
  readonly details: unknown;
  readonly exitCode: number;

  constructor(code: string, message: string, details?: unknown, exitCode = 1) {
    super(message);
    this.name = "HarnessError";
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

export function usageError(
  code: string,
  message: string,
  suggestion: string,
  nextActions: string[] = [suggestion]
): HarnessError {
  const uniqueNextActions = [...new Set(nextActions)];
  return new HarnessError(
    code,
    message,
    {
      recoverable: true,
      suggestion,
      next_actions: uniqueNextActions
    },
    2
  );
}

export function errorExitCode(error: unknown): number {
  if (!(error instanceof HarnessError)) {
    return 1;
  }
  if (error.exitCode !== 1) {
    return error.exitCode;
  }
  if (
    error.code.includes("blocked") ||
    error.code.includes("authority") ||
    error.code.includes("approval_receipt") ||
    error.code.includes("budget_exhausted") ||
    error.code === "deepseek_api_key_not_present" ||
    error.code === "approval_receipt_replayed"
  ) {
    return 3;
  }
  if (
    error.code.startsWith("invalid_") ||
    error.code.startsWith("missing_") ||
    error.code.endsWith("_not_found") ||
    error.code.endsWith("_required")
  ) {
    return 2;
  }
  return 1;
}

export function toErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof HarnessError) {
    return {
      ok: false,
      code: error.code,
      message: error.message,
      details: error.details ?? null
    };
  }

  if (error instanceof Error) {
    return {
      ok: false,
      code: "unexpected_error",
      message: error.message
    };
  }

  return {
    ok: false,
    code: "unexpected_error",
    message: String(error)
  };
}
