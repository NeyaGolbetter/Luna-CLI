import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Luna state lives in ~/.luna by default.
 * LUNA_HOME overrides the whole directory (used by tests and portable installs).
 */
export function lunaHome(): string {
  return process.env.LUNA_HOME || path.join(os.homedir(), '.luna');
}

export function ensureLunaHome(): string {
  const dir = lunaHome();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function configPath(): string {
  return path.join(lunaHome(), 'config.json');
}

export function mcpConfigPath(): string {
  return path.join(lunaHome(), 'mcp_servers.json');
}

export function statePath(name: string): string {
  return path.join(lunaHome(), `${name}.json`);
}

export function logPath(name: string): string {
  return path.join(lunaHome(), `${name}.log`);
}

/** Absolute path to the compiled bridge entrypoint (dist/bridge/roblox-bridge.js). */
export function bridgeScriptPath(): string {
  return fileURLToPath(new URL('../bridge/roblox-bridge.js', import.meta.url));
}

export function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Atomic JSON write: tmp file + rename, then chmod 0600 (config holds API keys). */
export function writeJsonAtomic(file: string, data: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, mode);
  } catch {
    /* best effort */
  }
}
