import fs from 'node:fs';
import { configPath, ensureLunaHome, readJsonFile, writeJsonAtomic } from './paths.js';
import { LunaError } from './errors.js';

export type ProviderName = 'openai' | 'openrouter' | 'gemini' | 'custom';

export interface ProviderMeta {
  label: string;
  defaultBaseUrl: string;
  hint: string;
}

export const PROVIDERS: Record<ProviderName, ProviderMeta> = {
  openai: {
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    hint: 'api.openai.com — key from platform.openai.com',
  },
  openrouter: {
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    hint: 'openrouter.ai — one key for hundreds of models',
  },
  gemini: {
    label: 'Google Gemini (OpenAI-compatible)',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    hint: 'aistudio.google.com — uses the OpenAI-compatible endpoint',
  },
  custom: {
    label: 'Custom base URL (Ollama / LiteLLM / vLLM / ...)',
    defaultBaseUrl: '',
    hint: 'any OpenAI-compatible server, e.g. http://127.0.0.1:11434/v1',
  },
};

export const PROVIDER_NAMES: ProviderName[] = ['openai', 'openrouter', 'gemini', 'custom'];

export interface TunnelState {
  url: string | null;
  port: number | null;
  targetUrl: string | null;
  cfPid: number | null;
  bridgePid: number | null;
  startedAt: string | null;
  logFile: string | null;
}

export interface LunaConfig {
  version: 1;
  provider: ProviderName;
  apiKey: string;
  baseUrl: string;
  activeModel: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  stream: boolean;
  tunnel: TunnelState | null;
}

export const DEFAULT_SYSTEM_PROMPT =
  'You are Luna, a concise terminal AI assistant. Keep answers short and ' +
  'scannable in a narrow terminal. Use Markdown when it helps, prefer bullets ' +
  'and code blocks, avoid tables wider than ~60 columns. When MCP tools are ' +
  'available, use them to fetch or change real state instead of guessing.';

const EMPTY_TUNNEL: TunnelState = {
  url: null,
  port: null,
  targetUrl: null,
  cfPid: null,
  bridgePid: null,
  startedAt: null,
  logFile: null,
};

function defaults(): LunaConfig {
  return {
    version: 1,
    provider: 'openai',
    apiKey: '',
    baseUrl: '',
    activeModel: '',
    temperature: 0.7,
    maxTokens: 4096,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    stream: true,
    tunnel: { ...EMPTY_TUNNEL },
  };
}

/** Merge unknown/older files over defaults so new fields never break old installs. */
function normalize(raw: unknown): LunaConfig {
  const base = defaults();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  if (typeof r.provider === 'string' && r.provider in PROVIDERS) base.provider = r.provider as ProviderName;
  if (typeof r.apiKey === 'string') base.apiKey = r.apiKey;
  if (typeof r.baseUrl === 'string') base.baseUrl = r.baseUrl;
  if (typeof r.activeModel === 'string') base.activeModel = r.activeModel;
  if (typeof r.temperature === 'number' && Number.isFinite(r.temperature)) base.temperature = r.temperature;
  if (typeof r.maxTokens === 'number' && Number.isFinite(r.maxTokens)) base.maxTokens = Math.max(1, r.maxTokens | 0);
  if (typeof r.systemPrompt === 'string' && r.systemPrompt.length > 0) base.systemPrompt = r.systemPrompt;
  if (typeof r.stream === 'boolean') base.stream = r.stream;
  if (r.tunnel && typeof r.tunnel === 'object') base.tunnel = { ...EMPTY_TUNNEL, ...(r.tunnel as Partial<TunnelState>) };
  return base;
}

class ConfigManager {
  private cache: LunaConfig | null = null;

  /** Load (and cache) ~/.luna/config.json. Never throws; falls back to defaults. */
  load(): LunaConfig {
    if (this.cache) return this.cache;
    ensureLunaHome();
    const raw = readJsonFile<unknown>(configPath());
    this.cache = normalize(raw);
    return this.cache;
  }

  /** Merge a patch into the cached config and persist atomically (0600). */
  save(patch: Partial<LunaConfig>): LunaConfig {
    const cur = this.load();
    const next: LunaConfig = { ...cur, ...patch };
    if (patch.tunnel) next.tunnel = { ...EMPTY_TUNNEL, ...patch.tunnel };
    writeJsonAtomic(configPath(), next);
    this.cache = next;
    return next;
  }

  get<K extends keyof LunaConfig>(key: K): LunaConfig[K] {
    return this.load()[key];
  }

  set<K extends keyof LunaConfig>(key: K, value: LunaConfig[K]): LunaConfig {
    return this.save({ [key]: value } as Partial<LunaConfig>);
  }

  /** Force a re-read from disk (after external edits or LUNA_HOME changes). */
  invalidate(): void {
    this.cache = null;
  }

  /** The effective base URL: explicit override wins, else provider default. */
  baseUrlOf(cfg?: LunaConfig): string {
    const c = cfg ?? this.load();
    const url = (c.baseUrl || PROVIDERS[c.provider].defaultBaseUrl || '').trim();
    if (!url) {
      throw new LunaError(
        'No base URL configured. Run `luna config` (or set provider "custom" with a URL).',
      );
    }
    return url.replace(/\/+$/, '');
  }

  /** Mask an API key for display: keep first 4 and last 4 chars. */
  maskKey(key: string): string {
    if (!key) return '(not set)';
    if (key.length <= 8) return '*'.repeat(key.length);
    return `${key.slice(0, 4)}…${key.slice(-4)}`;
  }

  file(): string {
    return configPath();
  }

  exists(): boolean {
    return fs.existsSync(configPath());
  }
}

export const config = new ConfigManager();
