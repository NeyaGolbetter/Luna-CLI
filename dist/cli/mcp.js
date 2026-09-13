import { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { McpManager } from '../mcp/manager.js';
import { addMcpServer, loadMcpConfig, mcpConfigFile, removeMcpServer, serverEndpoint, serverTransport, sanitizeServerName, } from '../utils/mcp-config.js';
import { log } from '../utils/logger.js';
export function mcpCommand() {
    const cmd = new Command('mcp').description('manage MCP servers (stdio / SSE / streamable-HTTP)');
    cmd
        .command('list')
        .description('show configured MCP servers, connection status and registered tools')
        .option('--no-connect', 'only print the configuration without connecting')
        .action(async (opts) => {
        const cfg = loadMcpConfig();
        const names = Object.keys(cfg.mcpServers);
        if (names.length === 0) {
            log.info(`no MCP servers configured yet (${mcpConfigFile()}).`);
            log.info(chalk.dim('  add stdio:  luna mcp add <name> <command> [args…]'));
            log.info(chalk.dim('  add remote: luna mcp add <name> https://host/sse [--transport sse|http]'));
            return;
        }
        for (const name of names) {
            const entry = cfg.mcpServers[name];
            log.info(`  ${chalk.bold(name)}  ${chalk.dim(serverTransport(entry))}  ${chalk.dim(serverEndpoint(entry))}`);
        }
        if (!opts.connect)
            return;
        const mcp = new McpManager();
        const spinner = ora({ text: 'connecting…' }).start();
        await mcp.connectAll(cfg).catch(() => undefined);
        spinner.stop();
        for (const st of mcp.statuses()) {
            if (st.ok) {
                log.success(`  ${st.name}: connected, ${st.toolCount} tool(s)`);
            }
            else {
                log.error(`  ${st.name}: ${st.error}`);
            }
        }
        for (const h of mcp.servers) {
            for (const t of h.tools) {
                const params = Object.keys((t.inputSchema?.properties ?? {})).join(', ');
                log.info(`      • ${chalk.cyan(t.name)}${params ? chalk.dim(`(${params})`) : ''}  ${chalk.dim(t.description ?? '')}`);
            }
        }
        await mcp.disconnectAll();
    });
    cmd
        .command('add <name> <commandOrUrl> [args...]')
        .description('register a stdio or remote MCP server')
        .option('--transport <transport>', 'sse | http (remote servers; sse by default)')
        .option('--env <KV...>', 'environment variables for stdio servers (K=V, repeatable)')
        .option('--header <KV...>', 'HTTP headers for remote servers (K: V, repeatable)')
        .action(async (name, commandOrUrl, args, opts) => {
        const isUrl = /^https?:\/\//i.test(commandOrUrl);
        if (isUrl) {
            const transport = (opts.transport ?? 'sse');
            if (transport !== 'sse' && transport !== 'http') {
                return log.die('--transport must be "sse" or "http" for remote servers.');
            }
            const headers = {};
            for (const h of opts.header ?? []) {
                const i = h.indexOf(':');
                if (i <= 0)
                    return log.die(`invalid --header "${h}" (use "Name: value")`);
                headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
            }
            addMcpServer(sanitizeServerName(name), {
                url: commandOrUrl,
                transport,
                ...(Object.keys(headers).length ? { headers } : {}),
            });
            log.success(`added remote MCP server "${name}" → ${commandOrUrl} (${transport})`);
        }
        else {
            if (opts.transport && opts.transport !== 'stdio') {
                return log.die('stdio servers do not take --transport.');
            }
            const env = {};
            for (const e of opts.env ?? []) {
                const i = e.indexOf('=');
                if (i <= 0)
                    return log.die(`invalid --env "${e}" (use K=V)`);
                env[e.slice(0, i)] = e.slice(i + 1);
            }
            addMcpServer(sanitizeServerName(name), {
                command: commandOrUrl,
                ...(args.length ? { args } : {}),
                ...(Object.keys(env).length ? { env } : {}),
            });
            log.success(`added stdio MCP server "${name}" → ${[commandOrUrl, ...args].join(' ')}`);
        }
        log.info(chalk.dim(`saved to ${mcpConfigFile()} — verify with \`luna mcp list\``));
    });
    cmd
        .command('remove <name>')
        .description('remove a configured MCP server')
        .action((name) => {
        removeMcpServer(sanitizeServerName(name));
        log.success(`removed MCP server "${name}"`);
    });
    return cmd;
}
