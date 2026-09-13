import { Command } from 'commander';
import chalk from 'chalk';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isPidAlive, killPid } from '../utils/process.js';
import { bridgeScriptPath, statePath } from '../utils/paths.js';
import { LunaError } from '../utils/errors.js';
import { log } from '../utils/logger.js';
import { config } from '../utils/config.js';
export function bridgeStateFile() {
    return statePath('bridge');
}
export function readBridgeState() {
    try {
        const raw = JSON.parse(fs.readFileSync(bridgeStateFile(), 'utf8'));
        return typeof raw.pid === 'number' ? raw : null;
    }
    catch {
        return null;
    }
}
export function writeBridgeState(st) {
    fs.mkdirSync(path.dirname(bridgeStateFile()), { recursive: true });
    fs.writeFileSync(bridgeStateFile(), JSON.stringify(st, null, 2) + '\n', { mode: 0o600 });
}
export function clearBridgeState() {
    try {
        fs.unlinkSync(bridgeStateFile());
    }
    catch {
        /* ignore */
    }
}
export function bridgeCommand() {
    const cmd = new Command('bridge').description('manage the local Roblox executor bridge (HTTP/WS/MCP-SSE)');
    cmd
        .command('start')
        .description('run the bridge in the foreground (Ctrl+C stops it)')
        .option('-p, --port <port>', 'listen port', '8172')
        .option('--host <host>', 'bind host', '127.0.0.1')
        .option('--executor-url <url>', 'forward scripts to this executor HTTP listener (or set LUNA_EXECUTOR_URL)')
        .action(async (opts) => {
        const port = Number(opts.port);
        if (!Number.isInteger(port) || port <= 0 || port > 65535)
            return log.die(`invalid port "${opts.port}"`);
        const args = ['--port', String(port), '--host', opts.host];
        if (opts.executorUrl)
            args.push('--executor-url', opts.executorUrl);
        // Foreground: child stays attached, Ctrl+C propagates as SIGINT.
        const child = spawn(process.execPath, [bridgeScriptPath(), ...args], { stdio: 'inherit' });
        await new Promise((resolve) => {
            child.on('exit', (code) => {
                resolve();
                if (code !== null && code !== 0)
                    process.exitCode = code;
            });
        });
    });
    cmd
        .command('stop')
        .description('stop a detached bridge started by `luna tunnel start`')
        .action(async () => {
        const st = readBridgeState();
        if (!st) {
            throw new LunaError('no detached bridge state found (is a tunnel running? try `luna tunnel stop`).');
        }
        const killed = await killPid(st.pid);
        if (killed)
            log.success(`bridge pid ${st.pid} stopped`);
        else
            log.warn(`bridge pid ${st.pid} was not running`);
        clearBridgeState();
        const tunnel = config.get('tunnel');
        if (tunnel?.bridgePid === st.pid)
            config.save({ tunnel: { ...tunnel, bridgePid: null } });
    });
    cmd
        .command('status')
        .description('show bridge state')
        .action(() => {
        const st = readBridgeState();
        if (!st) {
            log.info('no detached bridge state (start one with `luna tunnel start` or run `luna bridge start`).');
            const t = config.get('tunnel');
            if (t?.url)
                log.info(chalk.dim(`active tunnel: ${t.url}`));
            return;
        }
        const alive = isPidAlive(st.pid);
        log.info([
            `  pid       ${st.pid} ${alive ? chalk.green('alive') : chalk.red('dead')}`,
            `  listening http://${st.host}:${st.port}`,
            `  executor  ${st.executorUrl ?? chalk.dim('none (waiting for companion / polling script)')}`,
            `  started   ${st.startedAt}`,
            `  log       ${st.logFile}`,
        ].join('\n'));
    });
    return cmd;
}
