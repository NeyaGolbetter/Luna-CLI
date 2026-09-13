import readline from 'node:readline';
import ora from 'ora';
import chalk from 'chalk';
import { fetchModels } from '../providers/discovery.js';
import { McpManager } from '../mcp/manager.js';
import { emptyConversation, runTurn } from '../mcp/orchestrator.js';
import { config } from '../utils/config.js';
import { log } from '../utils/logger.js';
import { loadMcpConfig } from '../utils/mcp-config.js';
import { banner, renderAssistantText, terminalWidth } from '../utils/formatter.js';
import { clientFor, ensureConfigured } from './wizard.js';
const PROMPT = chalk.magenta.bold('you › ');
export async function chatCommand(opts = {}) {
    const cfg = await ensureConfigured();
    const model = opts.model ?? cfg.activeModel;
    if (opts.model && opts.model !== cfg.activeModel) {
        log.info(chalk.dim(`session model override: ${opts.model} (active stays ${cfg.activeModel})`));
    }
    const mcp = new McpManager();
    const mcpCfg = loadMcpConfig();
    let spinner;
    if (Object.keys(mcpCfg.mcpServers).length > 0) {
        spinner = ora({ text: 'connecting MCP servers…' }).start();
    }
    const handles = await mcp.connectAll(mcpCfg).catch((e) => {
        log.warn(`MCP connection problem: ${e instanceof Error ? e.message : String(e)}`);
        return [];
    });
    spinner?.stop();
    process.stdout.write(banner(model, cfg.provider, handles.length, mcp.toolCount()));
    if (handles.length > 0) {
        log.info(chalk.dim('the model can call the tools above automatically'));
    }
    else if (Object.keys(mcpCfg.mcpServers).length > 0) {
        log.warn('MCP servers configured but none connected — run `luna mcp list` to debug.');
    }
    const client = clientFor(cfg);
    const width = terminalWidth();
    let messages = emptyConversation(cfg.systemPrompt);
    let shuttingDown = false;
    let busy = false;
    let interruptArmed = false;
    let abort = null;
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: process.stdin.isTTY === true,
    });
    // Queue-based line reader: works identically for TTY and piped stdin.
    // (rl.question would drop buffered lines when a pipe delivers several at
    // once — e.g. `printf 'q1\nq2\n' | luna chat`.)
    const EOF = '__LUNA_EOF__';
    const lineQueue = [];
    let resolveLine = null;
    let inputClosed = false;
    rl.on('line', (s) => {
        if (resolveLine) {
            const r = resolveLine;
            resolveLine = null;
            r(s);
        }
        else {
            lineQueue.push(s);
        }
    });
    rl.on('close', () => {
        inputClosed = true;
        if (resolveLine) {
            const r = resolveLine;
            resolveLine = null;
            r(EOF);
        }
        else {
            lineQueue.push(EOF);
        }
    });
    const askLine = () => new Promise((resolve) => {
        if (lineQueue.length > 0)
            return resolve(lineQueue.shift());
        if (inputClosed)
            return resolve(EOF);
        resolveLine = resolve;
        rl.setPrompt(PROMPT);
        rl.prompt();
    });
    const shutdown = async (code = 0) => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        rl.close();
        process.stdout.write('\n' + chalk.dim('goodbye, moonlight ✦\n'));
        try {
            await mcp.disconnectAll();
        }
        catch {
            /* ignore */
        }
        process.exit(code);
    };
    const handleSlash = async (line) => {
        const [cmd, ...rest] = line.trim().split(/\s+/);
        const arg = rest.join(' ');
        switch (cmd) {
            case '/exit':
            case '/quit':
                await shutdown(0);
                return;
            case '/help':
                log.info([
                    chalk.bold('slash commands'),
                    '  /help            this list',
                    '  /clear           reset the conversation context',
                    '  /model [id]      list models & switch (or set directly with id)',
                    '  /models          list models from the provider',
                    '  /tools           list MCP servers & tools',
                    '  /status          provider, model, tunnel status',
                    '  /exit            quit Luna',
                ].join('\n'));
                return;
            case '/clear':
                messages = emptyConversation(cfg.systemPrompt);
                log.success('context cleared');
                return;
            case '/status': {
                const t = cfg.tunnel;
                log.info([
                    `  provider  ${cfg.provider}${cfg.baseUrl ? chalk.dim(` (${cfg.baseUrl})`) : ''}`,
                    `  model     ${model}`,
                    `  key       ${config.maskKey(cfg.apiKey)}`,
                    `  mcp       ${mcp.servers.length} server(s), ${mcp.toolCount()} tool(s)`,
                    `  tunnel    ${t?.url ?? chalk.dim('none')}`,
                ].join('\n'));
                return;
            }
            case '/tools': {
                if (mcp.toolCount() === 0) {
                    log.info('  no MCP tools connected. Add one: `luna mcp add <name> <command|url>`');
                    return;
                }
                for (const h of mcp.servers) {
                    log.info(`  ${chalk.bold(h.name)} ${chalk.dim(`[${h.transport}] ${h.endpoint}`)}`);
                    for (const t of h.tools) {
                        log.info(`    • ${t.name} ${chalk.dim(t.description ?? '')}`);
                    }
                }
                return;
            }
            case '/models': {
                const s = ora({ text: 'querying provider…' }).start();
                try {
                    const models = await fetchModels(client);
                    s.succeed(`found ${models.length} models`);
                    for (const m of models.slice(0, 100)) {
                        process.stdout.write(`  ${m.id === model ? chalk.cyan('● ') : '  '}${m.id}\n`);
                    }
                    if (models.length > 100)
                        log.info(chalk.dim(`  …and ${models.length - 100} more`));
                }
                catch (e) {
                    s.stop();
                    log.error(`could not list models: ${e instanceof Error ? e.message : String(e)}`);
                }
                return;
            }
            case '/model': {
                if (arg) {
                    config.save({ activeModel: arg });
                    log.success(`active model → ${chalk.cyan(arg)}`);
                    return;
                }
                const s = ora({ text: 'querying provider…' }).start();
                const models = await fetchModels(client).catch(() => []);
                s.stop();
                if (models.length === 0) {
                    log.warn('provider returned no models — set one with /model <id>');
                    return;
                }
                models.slice(0, 100).forEach((m, i) => {
                    process.stdout.write(`  ${String(i + 1).padStart(3)}  ${m.id === model ? chalk.cyan('● ') : '   '}${m.id}\n`);
                });
                if (models.length > 100)
                    log.info(chalk.dim(`  …and ${models.length - 100} more`));
                const pick = (await askLine()).trim();
                if (!pick)
                    return log.warn('no change');
                let chosen;
                if (/^\d+$/.test(pick))
                    chosen = models[Number(pick) - 1]?.id;
                else if (models.some((m) => m.id === pick))
                    chosen = pick;
                else if (pick.length <= 64 && !pick.includes(' '))
                    chosen = pick; // allow arbitrary id
                if (chosen) {
                    config.save({ activeModel: chosen });
                    log.success(`active model → ${chalk.cyan(chosen)}`);
                }
                else {
                    log.warn('no change');
                }
                return;
            }
            default:
                log.warn(`unknown command ${cmd} — try /help`);
        }
    };
    const turn = async (text) => {
        busy = true;
        interruptArmed = false;
        const ac = new AbortController();
        abort = ac;
        messages.push({ role: 'user', content: text });
        let gotDelta = false;
        try {
            const out = await runTurn(messages, config.load(), client, mcp, {
                signal: ac.signal,
                onDelta: (d) => {
                    gotDelta = true;
                    process.stdout.write(d);
                },
                onToolStart: (name) => process.stdout.write('\n' + chalk.yellow(`⚙ ${name} …`)),
                onToolEnd: (name, ok, ms) => process.stdout.write(chalk.dim(` ${ok ? 'ok' : 'error'} (${ms}ms)`)),
            });
            process.stdout.write('\n\n');
            // Non-streaming mode: render the final answer once.
            if (!gotDelta && out) {
                process.stdout.write(chalk.cyan.bold('luna › ') + '\n');
                process.stdout.write(renderAssistantText(out, width) + '\n\n');
            }
        }
        catch (e) {
            process.stdout.write('\n');
            log.error(`request failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        finally {
            busy = false;
            abort = null;
        }
    };
    // Ctrl+C: while generating → cancel; at the prompt → clear the line,
    // second press within 2s → exit. All state is torn down in shutdown().
    rl.on('SIGINT', () => {
        if (busy) {
            log.warn('interrupting current generation…');
            abort?.abort();
            return;
        }
        if (interruptArmed) {
            void shutdown(0);
            return;
        }
        interruptArmed = true;
        setTimeout(() => {
            interruptArmed = false;
        }, 2000);
        process.stdout.write(chalk.dim('\n(interrupted — Ctrl+C again or /exit to quit)\n'));
        rl.prompt();
    });
    // Non-TTY (piped) input has no readline key handling — Ctrl+C arrives as a
    // plain SIGINT: cancel the in-flight request, or exit at the prompt.
    process.on('SIGINT', () => {
        if (process.stdin.isTTY)
            return; // readline handles TTY ^C itself
        if (shuttingDown)
            return;
        if (busy) {
            log.warn('interrupting current generation…');
            abort?.abort();
        }
        else {
            void shutdown(0);
        }
    });
    // Main REPL pump.
    for (;;) {
        if (shuttingDown)
            break;
        const line = await askLine();
        if (line === EOF || shuttingDown)
            break;
        const q = line.trim();
        if (q === '')
            continue;
        if (q.startsWith('/')) {
            await handleSlash(q);
            continue;
        }
        await turn(q);
    }
    // Clean exit when the pipe reached EOF without /exit.
    if (!shuttingDown) {
        shuttingDown = true;
        rl.close();
        process.stdout.write('\n' + chalk.dim('goodbye, moonlight ✦\n'));
        try {
            await mcp.disconnectAll();
        }
        catch {
            /* ignore */
        }
    }
}
