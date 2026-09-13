/** Base error type for all Luna failures. */
export class LunaError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'LunaError';
    this.exitCode = exitCode;
  }
}

/** Failure inside a provider (API) call. */
export class ProviderError extends LunaError {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

/** No executor is currently attached to the bridge. */
export class ExecutorNotAttachedError extends LunaError {
  constructor(detail?: string) {
    super(detail || 'No executor attached to the bridge yet.');
    this.name = 'ExecutorNotAttachedError';
  }
}

export function isLunaError(e: unknown): e is LunaError {
  return e instanceof LunaError;
}

/** Friendly one-line description of an unknown error. */
export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
