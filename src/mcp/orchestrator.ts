import type { LunaConfig } from '../utils/config.js';
import { log } from '../utils/logger.js';
import { describeError } from '../utils/errors.js';
import type { ChatMessage, ToolCall } from '../providers/types.js';
import type { OpenAICompatibleClient } from '../providers/openai.js';
import type { McpManager } from './manager.js';

export interface TurnHooks {
  onDelta?: (text: string) => void;
  onToolStart?: (name: string, args: Record<string, unknown>) => void;
  onToolEnd?: (name: string, ok: boolean, ms: number, detail?: string) => void;
  signal?: AbortSignal;
}

/** Default cap on the model → tool → model round-trips per user turn. */
const MAX_ITERATIONS = 8;
const MAX_TOOL_RESULT_CHARS = 12_000;

export function emptyConversation(systemPrompt: string): ChatMessage[] {
  return [{ role: 'system', content: systemPrompt }];
}

/**
 * One user turn of the conversation loop with MCP interception (Module B.2):
 *
 *   user message → LLM (with tool schemas) → [tool_calls → MCP execute →
 *   tool results appended → LLM again] → final assistant text
 */
export async function runTurn(messages: ChatMessage[], cfg: LunaConfig, client: OpenAICompatibleClient, mcp: McpManager, hooks: TurnHooks = {}): Promise<string> {
  const toolDefs = mcp.toolDefs();
  const useStream = cfg.stream && typeof hooks.onDelta === 'function';

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const params = {
      messages,
      model: cfg.activeModel,
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      signal: hooks.signal,
    };
    const res = useStream
      ? await client.chatStream(params, (d) => hooks.onDelta?.(d))
      : await client.chat(params);

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: res.content,
    };
    if (res.toolCalls.length > 0) assistantMsg.tool_calls = res.toolCalls;
    messages.push(assistantMsg);

    if (res.toolCalls.length === 0) {
      return res.content ?? '';
    }

    // Execute every requested tool call against the MCP servers.
    for (const tc of res.toolCalls) {
      const args = parseArgs(tc);
      hooks.onToolStart?.(tc.function.name, args);
      const t0 = Date.now();
      let ok = true;
      let text: string;
      try {
        text = await mcp.callTool(tc.function.name, args, hooks.signal);
      } catch (e) {
        ok = false;
        text = `[tool error] ${describeError(e)}`;
      }
      const ms = Date.now() - t0;
      hooks.onToolEnd?.(tc.function.name, ok, ms);
      log.debug(`tool ${tc.function.name} ${ok ? 'ok' : 'error'} in ${ms}ms`);
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.function.name,
        content: truncate(text, MAX_TOOL_RESULT_CHARS),
      });
    }
  }
  return '(stopped: reached the maximum number of tool round-trips for one turn)';
}

function parseArgs(tc: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(tc.function.arguments || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return { value: parsed };
  } catch {
    return {};
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}
