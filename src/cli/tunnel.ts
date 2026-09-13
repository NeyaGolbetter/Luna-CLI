import { Command } from 'commander';
import chalk from 'chalk';
import { startTunnel, stopTunnel, tunnelStatus } from '../bridge/tunnel-manager.js';
import { logPath } from '../utils/paths.js';
import { readLogTail } from '../utils/process.js';
import { log } from '../utils/logger.js';

export function tunnelCommand(): Command {
  const cmd = new Command('tunnel').description('manage cloudflared tunnels for the Roblox bridge / external webhooks');

  cmd
    .command('start')
    .description(
      'expose the local Roblox bridge over a Cloudflare Tunnel and inject the URL into Luna',
    )
    .option('-p, --port <port>', 'local bridge port to tunnel', '8172')
    .option('--url <url>', 'cloudflared target URL (default http://localhost:<port>)')
    .option('--bridge', 'start a local Roblox bridge first (default on)', true)
    .option('--no-bridge', 'tunnel an already-running service')
    .option('--executor-url <url>', 'forward scripts directly to this executor HTTP listener')
    .option('--token <token>', 'use a named cloudflared tunnel token instead of an ephemeral one')
    .option('--no-mcp', 'do not auto-register the tunnel as the "remote-tunnel" MCP server')
    .option('--mcp-name <name>', 'MCP server name to register', 'remote-tunnel')
    .option('--timeout <seconds>', 'seconds to wait for the tunnel URL', '90')
    .action(
      async (opts: {
        port: string;
        url?: string;
        bridge: boolean;
        executorUrl?: string;
        token?: string;
        mcp: boolean;
        mcpName: string;
        timeout: string;
      }) => {
        const port = Number(opts.port);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) return log.die(`invalid port "${opts.port}"`);
        const extraArgs = opts.token ? ['--token', opts.token] : [];
        const state = await startTunnel({
          port,
          targetUrl: opts.url,
          bridge: opts.bridge,
          executorUrl: opts.executorUrl,
          extraArgs,
          urlTimeoutMs: Number(opts.timeout) * 1000,
          registerMcp: opts.mcp,
          mcpName: opts.mcpName,
        });

        process.stdout.write('\n');
        log.info(chalk.bold('🌙 tunnel is live:'));
        process.stdout.write(chalk.cyan.bold(`  ${state.url}\n`));
        log.info(chalk.dim(`  target   ${state.targetUrl}`));
        log.info(chalk.dim(`  cloudflared pid ${state.cfPid}${state.bridgePid ? `, bridge pid ${state.bridgePid}` : ''}`));
        log.info(chalk.dim(`  log      ${state.logFile}`));
        if (opts.mcp) {
          log.success(`registered as MCP server "${opts.mcpName}" (SSE) — \`luna chat\` can now use it remotely`);
        }
        log.info(
          [
            chalk.dim('useful next steps:'),
            `  ${chalk.cyan('luna mcp list')}          # verify the remote-tunnel server + tools`,
            `  ${chalk.cyan('luna chat')}                # ask "run a hello-world luau script"`,
            `  ${chalk.cyan('luna tunnel stop')}         # tear everything down`,
          ].join('\n'),
        );
      },
    );

  cmd
    .command('stop')
    .description('stop the running tunnel (cloudflared + owned bridge)')
    .action(async () => {
      const res = await stopTunnel();
      log.success(
        `tunnel stopped (cloudflared: ${res.stoppedCloudflared ? 'killed' : 'not running'}${res.stoppedBridge ? ', bridge killed' : ''})`,
      );
    });

  cmd
    .command('status')
    .description('show tunnel state')
    .action(() => {
      const st = tunnelStatus();
      if (!st.state) {
        log.info('no tunnel running.');
        log.info(chalk.dim('start one: luna tunnel start --port 8172'));
        return;
      }
      const s = st.state;
      log.info(
        [
          `  url       ${st.cfAlive ? chalk.cyan(s.url) : chalk.dim(s.url)}`,
          `  target    ${s.targetUrl}`,
          `  port      ${s.port}`,
          `  cf pid    ${s.cfPid} ${st.cfAlive ? chalk.green('alive') : chalk.red('dead')}`,
          `  bridge    ${s.bridgePid ? `${s.bridgePid} ${st.bridgeAlive ? chalk.green('alive') : chalk.red('dead')}` : chalk.dim('external/not started')}`,
          `  started   ${s.startedAt}`,
          `  log       ${s.logFile}`,
          `  hint      ${st.hint}`,
        ].join('\n'),
      );
    });

  cmd
    .command('logs')
    .description('print the tail of the tunnel log')
    .action(() => {
      const tail = readLogTail(logPath('tunnel'), 30);
      if (!tail) return log.warn('no tunnel log yet (run `luna tunnel start`).');
      process.stdout.write(tail + '\n');
    });

  return cmd;
}
