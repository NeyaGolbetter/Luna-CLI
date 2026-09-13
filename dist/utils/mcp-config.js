import { mcpConfigPath, readJsonFile, writeJsonAtomic } from './paths.js';
import { LunaError } from './errors.js';
export function sanitizeServerName(name) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
        throw new LunaError(`Invalid server name "${name}" — use 1-64 chars of [a-zA-Z0-9_-].`);
    }
    return name;
}
/** Infer the transport from an entry: command → stdio, url → sse (default) or http. */
export function serverTransport(entry) {
    if (entry && typeof entry.command === 'string')
        return 'stdio';
    if (entry && typeof entry.url === 'string')
        return entry.transport === 'http' ? 'http' : 'sse';
    throw new LunaError('MCP server entry must define either "command" (stdio) or "url" (sse/http).');
}
export function serverEndpoint(entry) {
    if (entry && typeof entry.url === 'string')
        return entry.url;
    if (entry && typeof entry.command === 'string') {
        const args = entry.args ?? [];
        return [entry.command, ...args].join(' ');
    }
    return '?';
}
export function loadMcpConfig() {
    const raw = readJsonFile(mcpConfigPath());
    if (!raw || typeof raw !== 'object')
        return { mcpServers: {} };
    const servers = raw.mcpServers;
    if (!servers || typeof servers !== 'object') {
        throw new LunaError(`Invalid ${mcpConfigPath()}: missing "mcpServers" object.`);
    }
    const out = {};
    for (const [name, entry] of Object.entries(servers)) {
        if (!entry || typeof entry !== 'object') {
            throw new LunaError(`Invalid MCP server "${name}" in ${mcpConfigPath()}.`);
        }
        out[name] = entry;
    }
    return { mcpServers: out };
}
export function saveMcpConfig(cfg) {
    writeJsonAtomic(mcpConfigPath(), cfg);
}
export function addMcpServer(name, entry) {
    sanitizeServerName(name);
    const cfg = loadMcpConfig();
    cfg.mcpServers[name] = entry;
    saveMcpConfig(cfg);
    return cfg;
}
export function removeMcpServer(name) {
    const cfg = loadMcpConfig();
    if (!(name in cfg.mcpServers)) {
        throw new LunaError(`No MCP server named "${name}" (see \`luna mcp list\`).`);
    }
    delete cfg.mcpServers[name];
    saveMcpConfig(cfg);
    return cfg;
}
export function mcpConfigFile() {
    return mcpConfigPath();
}
