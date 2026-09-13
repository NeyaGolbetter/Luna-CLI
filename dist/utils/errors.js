/** Base error type for all Luna failures. */
export class LunaError extends Error {
    exitCode;
    constructor(message, exitCode = 1) {
        super(message);
        this.name = 'LunaError';
        this.exitCode = exitCode;
    }
}
/** Failure inside a provider (API) call. */
export class ProviderError extends LunaError {
    status;
    constructor(message, status) {
        super(message);
        this.name = 'ProviderError';
        this.status = status;
    }
}
/** No executor is currently attached to the bridge. */
export class ExecutorNotAttachedError extends LunaError {
    constructor(detail) {
        super(detail || 'No executor attached to the bridge yet.');
        this.name = 'ExecutorNotAttachedError';
    }
}
export function isLunaError(e) {
    return e instanceof LunaError;
}
/** Friendly one-line description of an unknown error. */
export function describeError(e) {
    if (e instanceof Error)
        return e.message;
    return String(e);
}
