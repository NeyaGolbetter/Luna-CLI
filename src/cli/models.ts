import ora from 'ora';
import chalk from 'chalk';
import { fetchModels } from '../providers/discovery.js';
import { pickModel } from '../providers/discovery.js';
import { config } from '../utils/config.js';
import { log } from '../utils/logger.js';
import { clientFor, ensureConfigured } from './wizard.js';

interface ModelsOptions {
  select?: boolean;
}

export async function modelsCommand(opts: ModelsOptions): Promise<void> {
  // Listing models only needs provider + key, not an active model.
  const cfg = await ensureConfigured(false);
  const client = clientFor(cfg);
  const s = ora({ text: `querying ${cfg.provider} (${config.baseUrlOf(cfg)})…` }).start();
  let models: Awaited<ReturnType<typeof fetchModels>>;
  try {
    models = await fetchModels(client);
  } finally {
    s.stop();
  }

  if (models.length === 0) {
    log.warn('the provider did not return any models (some local servers omit /models).');
    if (opts.select) {
      if (process.stdin.isTTY !== true) {
        log.die('interactive selection needs a terminal (or use `luna config set-model <id>`).');
      }
      await pickModel(cfg, client, (m) => {
        config.save({ activeModel: m });
        log.success(`active model → ${chalk.cyan(m)}`);
      });
    }
    return;
  }

  const active = cfg.activeModel;
  const padId = Math.min(Math.max(...models.map((m) => m.id.length), 24), 48);
  log.info(chalk.bold(`  ${'MODEL'.padEnd(padId)}  ${'CREATED'.padEnd(10)}  OWNER`));
  log.info(chalk.dim('  ' + '─'.repeat(padId + 16)));
  for (const m of models) {
    const id = m.id.length > padId ? m.id.slice(0, padId - 1) + '…' : m.id;
    const created = m.created ? new Date(m.created * 1000).toISOString().slice(0, 10) : '';
    const mark = m.id === active ? chalk.cyan('● ') : '  ';
    process.stdout.write(`  ${mark}${chalk.reset(id.padEnd(padId))}  ${created.padEnd(10)}  ${m.owned_by ?? ''}\n`);
  }
  log.info(chalk.dim(`\n  ${models.length} models`));

  if (opts.select) {
    if (process.stdin.isTTY !== true) {
      log.die('interactive selection needs a terminal (or use `luna config set-model <id>`).');
    }
    const picked = await pickModel(cfg, client, (m) => {
      config.save({ activeModel: m });
      log.success(`active model → ${chalk.cyan(m)}`);
    });
    void picked;
  }
}
