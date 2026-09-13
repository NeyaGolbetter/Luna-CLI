import { input, password, select } from '@inquirer/prompts';
import chalk from 'chalk';
import { fetchModels, pickModel } from '../providers/discovery.js';
import { OpenAICompatibleClient } from '../providers/openai.js';
import { PROVIDERS, PROVIDER_NAMES, config } from '../utils/config.js';
import { LunaError } from '../utils/errors.js';
import { log } from '../utils/logger.js';
export function isInteractive() {
    return process.stdin.isTTY === true;
}
export function clientFor(cfg) {
    return new OpenAICompatibleClient(config.baseUrlOf(cfg), cfg.apiKey, {
        extraHeaders: cfg.provider === 'openrouter' ? { 'X-Title': 'Luna CLI' } : undefined,
    });
}
/**
 * First-boot BYOAK wizard (Module A.1): provider → API key → base URL →
 * dynamic model discovery → active model. Persists everything to ~/.luna.
 */
export async function firstRunWizard() {
    log.info(chalk.bold('\nWelcome to Luna — let\'s connect your AI provider (BYOAK).\n'));
    const provider = await select({
        message: 'Choose a provider:',
        choices: PROVIDER_NAMES.map((p) => ({
            name: `${PROVIDERS[p].label}  ${chalk.dim('— ' + PROVIDERS[p].hint)}`,
            value: p,
        })),
    });
    const apiKey = await password({
        message: `API key (${PROVIDERS[provider].label}; leave empty for local servers):`,
        mask: '*',
    });
    let baseUrl = '';
    const def = PROVIDERS[provider].defaultBaseUrl;
    if (provider === 'custom' || def === '') {
        baseUrl = await input({
            message: 'Base URL (OpenAI-compatible):',
            default: 'http://127.0.0.1:11434/v1',
            validate: (v) => (v.trim() ? true : 'Base URL is required for custom providers.'),
        });
    }
    else {
        baseUrl = await input({
            message: `Base URL (Enter to use default ${def}):`,
            default: def,
        });
    }
    config.save({ provider, apiKey: apiKey.trim(), baseUrl: baseUrl.trim() });
    const cfg = config.load();
    const client = clientFor(cfg);
    let modelsOk = false;
    try {
        const models = await fetchModels(client);
        modelsOk = models.length > 0;
        if (models.length > 0)
            log.success(`discovered ${models.length} models`);
    }
    catch {
        /* fall through to manual entry */
    }
    const model = await pickModel(cfg, client, (m) => {
        config.save({ activeModel: m });
    });
    log.success(`active model: ${chalk.cyan(model)}`);
    if (!modelsOk) {
        log.warn('could not list models automatically — if the id above is wrong, re-run `luna models --select`.');
    }
    return config.load();
}
export async function ensureConfigured(requireModel = true) {
    const cfg = config.load();
    if (!cfg.apiKey && cfg.provider !== 'custom') {
        if (!isInteractive()) {
            throw new LunaError('No API key configured. Run `luna config set-key <key>` (or `luna config` in a terminal first).');
        }
        await firstRunWizard();
        return config.load();
    }
    if (!requireModel)
        return cfg;
    if (!cfg.activeModel) {
        const envModel = process.env.LUNA_MODEL;
        if (envModel) {
            config.save({ activeModel: envModel });
            log.success(`active model from LUNA_MODEL: ${chalk.cyan(envModel)}`);
            return config.load();
        }
        if (!isInteractive()) {
            throw new LunaError('No active model set. Use `luna config set-model <id>`, set LUNA_MODEL, or run `luna models --select` in a terminal.');
        }
        log.info('No active model set — pick one now.');
        const client = clientFor(config.load());
        await pickModel(config.load(), client, (m) => config.save({ activeModel: m }));
    }
    return config.load();
}
