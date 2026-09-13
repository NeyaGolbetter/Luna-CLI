import { ProviderError } from '../utils/errors.js';
import { log } from '../utils/logger.js';
import type { ChatParams, ChatResult, ModelInfo } from './types.js';

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

interface ClientOptions {
  /** Per-request timeout in ms. Default 120s. */
  timeoutMs?: number;
  /** Retries for 429/5xx/network errors. Default 2. */
  maxRetries?: number;
  extraHeaders?: Record<string, string>;
}

/**
 * Minimal OpenAI-compatible REST client (chat completions + model discovery)
 * built on global fetch — no SDK dependency, tiny CPU footprint on Termux.
 * Works with OpenAI, OpenRouter, Gemini (OpenAI-compat), Ollama, LiteLLM, vLLM.
 */
export class OpenAICompatibleClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(baseUrl: string, apiKey: string, opts: ClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey || '';
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.extraHeaders = opts.extraHeaders ?? {};
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...this.extraHeaders };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private friendlyError(status: number, body: string): string {
    let detail = '';
    try {
      const j = JSON.parse(body) as { error?: { message?: string } | string };
      detail = typeof j.error === 'string' ? j.error : j.error?.message ?? '';
    } catch {
      detail = body.slice(0, 200);
    }
    switch (status) {
      case 401:
        return `Authentication failed (401) — check your API key. ${detail}`;
      case 403:
        return `Access denied (403). ${detail}`;
      case 404:
        return `Not found (404) — the model or endpoint may not exist at this base URL. ${detail}`;
      case 429:
        return `Rate limited (429). ${detail}`;
      default:
        return `Provider error (HTTP ${status}). ${detail}`;
    }
  }

  private async request<T>(path: string, init: RequestInit, attemptsLeft = this.maxRetries): Promise<T> {
    const url = this.baseUrl + path;
    for (let attempt = 0; ; attempt++) {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, { ...init, signal: timeout.signal, headers: this.headers() });
        clearTimeout(timer);
        if (res.ok) return (await res.json()) as T;
        const body = await res.text().catch(() => '');
        if (RETRYABLE_STATUS.has(res.status) && attemptsLeft > 0) {
          log.debug(`retrying ${path} after ${res.status} (${attemptsLeft} left)`);
          const retryAfter = Number(res.headers.get('retry-after')) * 1000;
          const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 5000) : 700 * 2 ** attempt;
          await new Promise((r) => setTimeout(r, delay));
          return this.request<T>(path, init, attemptsLeft - 1);
        }
        throw new ProviderError(this.friendlyError(res.status, body), res.status);
      } catch (e) {
        clearTimeout(timer);
        if (e instanceof ProviderError) throw e;
        if (init.signal?.aborted || (timeout.signal.aborted && !init.signal?.aborted)) {
          throw new ProviderError(`Request timed out after ${Math.round(this.timeoutMs / 1000)}s.`);
        }
        if (attemptsLeft > 0 && isNetworkError(e)) {
          log.debug(`retrying ${path} after network error (${attemptsLeft} left)`);
          await new Promise((r) => setTimeout(r, 700 * 2 ** attempt));
          return this.request<T>(path, init, attemptsLeft - 1);
        }
        throw new ProviderError(`Network error contacting ${url}: ${(e as Error).message}`);
      }
    }
  }

  /** GET /models — dynamic model discovery. */
  async listModels(): Promise<ModelInfo[]> {
    const res = await this.request<{ data?: ModelInfo[]; models?: ModelInfo[] }>('/models', {
      method: 'GET',
    });
    const list = res.data ?? res.models ?? [];
    return list.map((m) => ({
      id: m.id,
      created: m.created,
      owned_by: m.owned_by,
      object: m.object,
    }));
  }

  /** Non-streaming chat completion. */
  async chat(params: ChatParams): Promise<ChatResult> {
    const res = await this.request<unknown>('/chat/completions', {
      method: 'POST',
      body: JSON.stringify(this.buildBody(params, false)),
    });
    return parseCompletion(res);
  }

  /**
   * Streaming chat completion (SSE). onDelta receives content deltas as they
   * arrive. Resolves with the fully assembled result (including tool calls).
   */
  async chatStream(params: ChatParams, onDelta: (text: string) => void): Promise<ChatResult> {
    const body = this.buildBody(params, true);
    const url = this.baseUrl + '/chat/completions';
    for (let attempt = 0; ; attempt++) {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: params.signal ?? timeout.signal,
        });
        if (!res.ok) {
          clearTimeout(timer);
          const text = await res.text().catch(() => '');
          if (RETRYABLE_STATUS.has(res.status) && attempt < this.maxRetries) {
            await new Promise((r) => setTimeout(r, 700 * 2 ** attempt));
            continue;
          }
          throw new ProviderError(this.friendlyError(res.status, text), res.status);
        }
        if (!res.body) {
          clearTimeout(timer);
          throw new ProviderError('Provider returned an empty response body.');
        }
        return await consumeSSE(res.body, params.signal, (chunk) => onDelta(chunk));
      } catch (e) {
        clearTimeout(timer);
        if (e instanceof ProviderError) throw e;
        if (params.signal?.aborted) throw new ProviderError('Generation cancelled.');
        if (attempt < this.maxRetries && isNetworkError(e)) {
          await new Promise((r) => setTimeout(r, 700 * 2 ** attempt));
          continue;
        }
        throw new ProviderError(`Network error contacting ${url}: ${(e as Error).message}`);
      }
    }
  }

  private buildBody(params: ChatParams, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: params.messages,
      stream,
    };
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.max_tokens !== undefined) body.max_tokens = params.max_tokens;
    if (params.tools && params.tools.length > 0) body.tools = params.tools;
    return body;
  }
}

function isNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const name = e.name;
  if (name === 'AbortError') return false; // handled separately
  return (
    name === 'TypeError' || // fetch network failure
    name === 'UND_ERR_SOCKET' ||
    name === 'UND_ERR_CONNECT_TIMEOUT' ||
    name === 'ECONNRESET' ||
    name === 'ENOTFOUND' ||
    name === 'EAI_AGAIN'
  );
}

/* ---------------- response parsing ---------------- */

interface RawToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export function parseCompletion(raw: unknown): ChatResult {
  const r = raw as {
    model?: string;
    usage?: ChatResult['usage'];
    choices?: Array<{
      message?: {
        role?: string;
        content?: string | null;
        tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
      };
    }>;
  };
  const choice = r.choices?.[0];
  const msg = choice?.message;
  return {
    content: msg?.content ?? null,
    toolCalls: msg?.tool_calls
      ? msg.tool_calls.map((tc) => ({ id: tc.id, type: 'function', function: tc.function }))
      : [],
    model: r.model ?? '',
    usage: r.usage,
  };
}

interface AccToolCall {
  id: string;
  name: string;
  args: string;
}

/**
 * Consume an OpenAI SSE stream. Calls onDelta for content fragments.
 * Resolves with the assembled ChatResult.
 */
async function consumeSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  onContent: (text: string) => void,
): Promise<ChatResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolCalls = new Map<number, AccToolCall>();
  let model = '';
  let usage: ChatResult['usage'];
  let aborted = false;

  const onAbort = () => {
    aborted = true;
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      if (aborted) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const result = processEvent(rawEvent);
        if (!result) continue;
        if (result.model) model = result.model;
        if (result.usage) usage = result.usage;
        if (result.content) {
          content += result.content;
          onContent(result.content);
        }
        if (result.toolDeltas) applyToolDeltas(toolCalls, result.toolDeltas);
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  if (aborted) throw new ProviderError('Generation cancelled.');

  return {
    content: content || null,
    toolCalls: [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, tc]) => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.args } })),
    model,
    usage,
  };
}

function processEvent(rawEvent: string): {
  model?: string;
  usage?: ChatResult['usage'];
  content?: string;
  toolDeltas?: RawToolCallDelta[];
} | null {
  let data = '';
  for (const line of rawEvent.split('\n')) {
    if (line.startsWith('data:')) data += line.slice(5).trimStart();
  }
  if (!data || data === '[DONE]') return null;
  let json: {
    model?: string;
    usage?: ChatResult['usage'];
    choices?: Array<{
      delta?: { content?: string; tool_calls?: RawToolCallDelta[] };
    }>;
  };
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const delta = json.choices?.[0]?.delta;
  return {
    model: json.model,
    usage: json.usage,
    content: delta?.content ?? undefined,
    toolDeltas: delta?.tool_calls,
  };
}

function applyToolDeltas(map: Map<number, AccToolCall>, deltas: RawToolCallDelta[]): void {
  for (const d of deltas) {
    const idx = d.index ?? 0;
    let acc = map.get(idx);
    if (!acc) {
      acc = { id: '', name: '', args: '' };
      map.set(idx, acc);
    }
    if (d.id) acc.id = d.id;
    if (d.function?.name) acc.name += d.function.name;
    if (d.function?.arguments) acc.args += d.function.arguments;
  }
}
