import fs from 'node:fs';
import { configPath, ensureLunaHome, readJsonFile, writeJsonAtomic } from './paths.js';
import { LunaError } from './errors.js';
export const PROVIDERS = {
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
export const PROVIDER_NAMES = ['openai', 'openrouter', 'gemini', 'custom'];
export const DEFAULT_SYSTEM_PROMPT = 'You are Luna, a concise terminal AI assistant. Keep answers short and ' +
    'scannable in a narrow terminal. Use Markdown when it helps, prefer bullets ' +
    'and code blocks, avoid tables wider than ~60 columns. When MCP tools are ' +
    'available, use them to fetch or change real state instead of guessing.';
const EMPTY_TUNNEL = {
    url: null,
    port: null,
    targetUrl: null,
    cfPid: null,
    bridgePid: null,
    startedAt: null,
    logFile: null,
};
function defaults() {
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
function normalize(raw) {
    const base = defaults();
    if (!raw || typeof raw !== 'object')
        return base;
    const r = raw;
    if (typeof r.provider === 'string' && r.provider in PROVIDERS)
        base.provider = r.provider;
    if (typeof r.apiKey === 'string')
        base.apiKey = r.apiKey;
    if (typeof r.baseUrl === 'string')
        base.baseUrl = r.baseUrl;
    if (typeof r.activeModel === 'string')
        base.activeModel = r.activeModel;
    if (typeof r.temperature === 'number' && Number.isFinite(r.temperature))
        base.temperature = r.temperature;
    if (typeof r.maxTokens === 'number' && Number.isFinite(r.maxTokens))
        base.maxTokens = Math.max(1, r.maxTokens | 0);
    if (typeof r.systemPrompt === 'string' && r.systemPrompt.length > 0)
        base.systemPrompt = r.systemPrompt;
    if (typeof r.stream === 'boolean')
        base.stream = r.stream;
    if (r.tunnel && typeof r.tunnel === 'object')
        base.tunnel = { ...EMPTY_TUNNEL, ...r.tunnel };
    return base;
}
class ConfigManager {
    cache = null;
    /** Load (and cache) ~/.luna/config.json. Never throws; falls back to defaults. */
    load() {
        if (this.cache)
            return this.cache;
        ensureLunaHome();
        const raw = readJsonFile(configPath());
        this.cache = normalize(raw);
        return this.cache;
    }
    /** Merge a patch into the cached config and persist atomically (0600). */
    save(patch) {
        const cur = this.load();
        const next = { ...cur, ...patch };
        if (patch.tunnel)
            next.tunnel = { ...EMPTY_TUNNEL, ...patch.tunnel };
        writeJsonAtomic(configPath(), next);
        this.cache = next;
        return next;
    }
    get(key) {
        return this.load()[key];
    }
    set(key, value) {
        return this.save({ [key]: value });
    }
    /** Force a re-read from disk (after external edits or LUNA_HOME changes). */
    invalidate() {
        this.cache = null;
    }
    /** The effective base URL: explicit override wins, else provider default. */
    baseUrlOf(cfg) {
        const c = cfg ?? this.load();
        const url = (c.baseUrl || PROVIDERS[c.provider].defaultBaseUrl || '').trim();
        if (!url) {
            throw new LunaError('No base URL configured. Run `luna config` (or set provider "custom" with a URL).');
        }
        return url.replace(/\/+$/, '');
    }
    /** Mask an API key for display: keep first 4 and last 4 chars. */
    maskKey(key) {
        if (!key)
            return '(not set)';
        if (key.length <= 8)
            return '*'.repeat(key.length);
        return `${key.slice(0, 4)}…${key.slice(-4)}`;
    }
    file() {
        return configPath();
    }
    exists() {
        return fs.existsSync(configPath());
    }
}
export const config = new ConfigManager();
