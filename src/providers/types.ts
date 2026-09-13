export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCallFunction {
  name: string;
  /** JSON-encoded argument object, as returned by the API. */
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: ToolCallFunction;
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
  model: string;
  usage?: ChatUsage;
}

export interface ChatParams {
  messages: ChatMessage[];
  model: string;
  temperature?: number;
  max_tokens?: number;
  tools?: ToolDefinition[];
  stream?: boolean;
  signal?: AbortSignal;
}

export interface ModelInfo {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}
