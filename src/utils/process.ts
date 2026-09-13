import { spawn, execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll `fn` until truthy, `timeoutMs` total, `intervalMs` between tries. Resolves with the truthy value or null. */
export async function waitFor<T>(
  fn: () => T | Promise<T> | null | undefined | false,
  timeoutMs: number,
  intervalMs = 250,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const val = await fn();
      if (val) return val as T;
    } catch {
      /* keep polling */
    }
    if (Date.now() > deadline) return null;
    await sleep(intervalMs);
  }
}

export function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we can't signal it.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Best-effort kill: SIGTERM, wait, then SIGKILL. Windows uses taskkill /t. */
export async function killPid(pid: number | null | undefined, graceMs = 3000): Promise<boolean> {
  if (!pid || !isPidAlive(pid)) return false;
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${pid} /t /f`, { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
    return true;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  const alive = await waitFor(() => !isPidAlive(pid), graceMs, 200);
  if (alive) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  return true;
}

/**
 * Spawn a long-lived process fully detached (its own process group),
 * with stdout+stderr appended to `logFile`. Returns the child pid.
 */
export function spawnDetached(command: string, args: string[], logFile: string): number {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(command, args, {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: process.env,
  });
  // A spawn failure (ENOENT etc.) arrives async — surface it in the log so
  // callers polling the log get a useful error instead of an uncaught throw.
  child.on('error', (e) => {
    try {
      fs.appendFileSync(logFile, `luna: failed to spawn ${command}: ${e.message}\n`);
    } catch {
      /* ignore */
    }
  });
  child.unref();
  fs.closeSync(fd);
  return child.pid ?? -1;
}

/** Locate an executable on PATH (cross-platform). */
export function findExecutable(name: string): string | null {
  const cmd = process.platform === 'win32' ? `where ${name}` : `command -v ${name}`;
  const res = spawnSync(cmd, { shell: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const out = res.stdout?.toString().trim();
  if (!out) return null;
  // `where` on Windows can return multiple lines; take the first.
  return out.split(/\r?\n/)[0] || null;
}

export function readLogTail(logFile: string, lines = 12): string {
  try {
    const text = fs.readFileSync(logFile, 'utf8');
    const all = text.split('\n').filter((l) => l.trim().length > 0);
    return all.slice(-lines).join('\n');
  } catch {
    return '';
  }
}
