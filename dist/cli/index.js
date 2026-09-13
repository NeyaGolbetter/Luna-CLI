import { Command } from 'commander';
import { pathToFileURL } from 'node:url';
import { LunaError, describeError } from '../utils/errors.js';
import { log, v } from '../utils/logger.js';
import { VERSION } from '../utils/formatter.js';
import { chatCommand } from './chat.js';
import { configCommand } from './config.js';
import { modelsCommand } from './models.js';
import { mcpCommand } from './mcp.js';
import { tunnelCommand } from './tunnel.js';
import { bridgeCommand } from './bridge.js';
/** Wrap an async action so CLI errors never produce raw stack traces. */
function guard(fn) {
    return async (...args) => {
        try {
            await fn(...args);
        }
        catch (e) {
            if (e instanceof LunaError) {
                log.error(e.message);
                process.exit(e.exitCode);
            }
            const msg = e instanceof Error ? e.message : String(e);
            log.error(msg);
            if (process.env.LUNA_VERBOSE === '1' || process.env.LUNA_DEBUG === '1') {
                process.stderr.write((e.stack ?? '') + '\n');
            }
            else {
                log.info(v.dim('(re-run with LUNA_DEBUG=1 for a stack trace)'));
            }
            process.exit(1);
        }
    };
}
export async function main() {
    const program = new Command();
    program
        .name('luna')
        .description('Luna — modular, Termux-optimized terminal AI assistant\n' +
        'BYOAK · MCP tool execution · Roblox executor bridge over Cloudflare Tunnels')
        .version(VERSION)
        .option('-v, --verbose', 'verbose output (stack traces on errors)')
        .option('--no-color', 'disable colored output');
    program.hook('preAction', (_this, action) => {
        if (program.opts().color === false)
            process.env.NO_COLOR = '1';
        if (program.opts().verbose)
            process.env.LUNA_VERBOSE = '1';
    });
    program
        .command('chat')
        .description('start an interactive REPL chat session')
        .option('-m, --model <model>', 'override the active model for this session')
        .action(guard(chatCommand));
    program.addCommand(configCommand());
    program
        .command('models')
        .description('query the active provider for available models')
        .option('-s, --select', 'interactively pick a model and make it active')
        .action(guard(modelsCommand));
    program.addCommand(mcpCommand());
    program.addCommand(tunnelCommand());
    program.addCommand(bridgeCommand());
    program.action(() => {
        // Bare `luna` → jump straight into chat (Termux-friendly).
        void chatCommand({}).catch((e) => {
            log.error(describeError(e));
            process.exit(1);
        });
    });
    await program.parseAsync(process.argv);
}
// Executable entrypoint: `node dist/cli/index.js …`
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
    main().catch((e) => {
        log.error(e instanceof Error ? e.message : String(e));
        if (process.env.LUNA_DEBUG === '1')
            process.stderr.write((e.stack ?? '') + '\n');
        process.exit(1);
    });
}
