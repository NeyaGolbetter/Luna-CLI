import { Command } from 'commander';
import { confirm, input, number, password, select } from '@inquirer/prompts';
import ora from 'ora';
import chalk from 'chalk';
import { fetchModels, pickModel } from '../providers/discovery.js';
import { PROVIDERS, PROVIDER_NAMES, config } from '../utils/config.js';
import { log } from '../utils/logger.js';
import { clientFor } from './wizard.js';
export function configCommand() {
    const cmd = new Command('config')
        .description('manage provider, API key, base URL, model and options')
        .argument('[action]', 'optional action: show | set-key | set-provider | set-model | set-base-url | set-prompt | path | reset')
        .argument('[value]', 'value for set-* actions (prompts interactively if omitted)')
        .option('--no-prompt', 'never prompt; fail if a value is missing')
        .action(async (action, value, opts) => {
        if (!action)
            return interactiveMenu();
        switch (action) {
            case 'show':
                return showConfig();
            case 'path':
                log.info(config.file());
                return;
            case 'reset':
                config.save({
                    provider: 'openai',
                    apiKey: '',
                    baseUrl: '',
                    activeModel: '',
                    temperature: 0.7,
                    maxTokens: 4096,
                    tunnel: null,
                });
                log.success('configuration reset to defaults');
                return;
            case 'set-key':
                return setKey(value, opts?.prompt);
            case 'set-provider':
                return setProvider(value, opts?.prompt);
            case 'set-model':
                return setModel(value, opts?.prompt);
            case 'set-base-url':
                return setBaseUrl(value, opts?.prompt);
            case 'set-prompt':
                return setPrompt(value, opts?.prompt);
            default:
                log.error(`unknown config action "${action}" (see \`luna config show\`)`);
                process.exit(1);
        }
    });
    return cmd;
}
async function setKey(value, promptAllowed) {
    let key;
    if (value !== undefined)
        key = value;
    else if (promptAllowed === false)
        return log.die('missing key — pass it as an argument.');
    else
        key = await password({ message: 'New API key:', mask: '*' });
    config.save({ apiKey: key.trim() });
    log.success(`API key saved (${config.maskKey(key.trim())})`);
}
async function setProvider(value, promptAllowed) {
    let provider;
    if (value !== undefined) {
        if (!(value in PROVIDERS)) {
            log.error(`unknown provider "${value}" — options: ${PROVIDER_NAMES.join(', ')}`);
            process.exit(1);
        }
        provider = value;
    }
    else if (promptAllowed === false) {
        return log.die('missing provider — pass it as an argument.');
    }
    else {
        provider = await select({
            message: 'Provider:',
            choices: PROVIDER_NAMES.map((p) => ({
                name: `${PROVIDERS[p].label}  ${chalk.dim(PROVIDERS[p].hint)}`,
                value: p,
            })),
        });
    }
    const cfg = config.load();
    config.save({ provider });
    if (cfg.baseUrl && cfg.provider !== provider) {
        log.warn(`base URL override kept (${cfg.baseUrl}) — use \`luna config set-base-url\` or set-provider for ${provider}'s default.`);
    }
    log.success(`provider → ${provider}`);
}
async function setModel(value, promptAllowed) {
    if (value !== undefined) {
        config.save({ activeModel: value.trim() });
        log.success(`active model → ${value.trim()}`);
        return;
    }
    if (promptAllowed === false)
        return log.die('missing model — pass it as an argument.');
    const cfg = config.load();
    const client = clientFor(cfg);
    const s = ora({ text: 'querying provider…' }).start();
    const models = await fetchModels(client).catch(() => []).finally(() => s.stop());
    if (models.length > 0) {
        log.info(`found ${models.length} models — picking…`);
    }
    await pickModel(cfg, client, (m) => {
        config.save({ activeModel: m });
        log.success(`active model → ${chalk.cyan(m)}`);
    });
}
async function setBaseUrl(value, promptAllowed) {
    let url;
    if (value !== undefined)
        url = value;
    else if (promptAllowed === false)
        return log.die('missing URL — pass it as an argument.');
    else {
        url = await input({ message: 'Base URL (OpenAI-compatible):', default: config.get('baseUrl') || undefined });
    }
    config.save({ baseUrl: url.trim() });
    log.success(`base URL → ${url.trim() || chalk.dim('(provider default)')}`);
}
async function setPrompt(value, promptAllowed) {
    let text;
    if (value !== undefined)
        text = value;
    else if (promptAllowed === false)
        return log.die('missing text — pass it as an argument.');
    else
        text = await input({ message: 'System prompt (Enter keeps current):', default: config.get('systemPrompt') });
    config.save({ systemPrompt: text });
    log.success('system prompt updated');
}
function showConfig() {
    const cfg = config.load();
    log.info([
        `  file        ${config.file()}`,
        `  provider    ${cfg.provider} ${chalk.dim(PROVIDERS[cfg.provider].label)}`,
        `  base url    ${cfg.baseUrl || config.baseUrlOf(cfg)}`,
        `  api key     ${config.maskKey(cfg.apiKey)}`,
        `  model       ${cfg.activeModel || chalk.dim('(not set)')}`,
        `  temperature ${cfg.temperature}`,
        `  max tokens  ${cfg.maxTokens}`,
        `  stream      ${cfg.stream ? 'on' : 'off'}`,
        `  tunnel      ${cfg.tunnel?.url ?? chalk.dim('none')}`,
    ].join('\n'));
}
/** `luna config` with no args: interactive menu. */
async function interactiveMenu() {
    for (;;) {
        const choice = await select({
            message: 'Luna configuration:',
            choices: [
                { name: `provider        ${chalk.dim(config.get('provider'))}`, value: 'provider' },
                { name: `api key         ${chalk.dim(config.maskKey(config.get('apiKey')))}`, value: 'key' },
                { name: `base url        ${chalk.dim(config.get('baseUrl') || config.baseUrlOf(config.load()))}`, value: 'url' },
                { name: `model           ${chalk.dim(config.get('activeModel') || '(not set)')}`, value: 'model' },
                { name: `temperature     ${chalk.dim(String(config.get('temperature')))}`, value: 'temp' },
                { name: `max tokens      ${chalk.dim(String(config.get('maxTokens')))}`, value: 'tokens' },
                { name: `streaming       ${chalk.dim(config.get('stream') ? 'on' : 'off')}`, value: 'stream' },
                { name: `system prompt   ${chalk.dim(config.get('systemPrompt').slice(0, 30) + '…')}`, value: 'prompt' },
                { name: 'show config', value: 'show' },
                { name: 'exit', value: 'exit' },
            ],
        });
        switch (choice) {
            case 'provider':
                await setProvider();
                break;
            case 'key':
                await setKey();
                break;
            case 'url':
                await setBaseUrl();
                break;
            case 'model':
                await setModel();
                break;
            case 'temp': {
                const t = await number({ message: 'Temperature (0–2):', default: config.get('temperature'), min: 0, max: 2 });
                config.save({ temperature: t });
                log.success(`temperature → ${t}`);
                break;
            }
            case 'tokens': {
                const t = await number({ message: 'Max tokens per response:', default: config.get('maxTokens'), min: 1 });
                config.save({ maxTokens: t });
                log.success(`max tokens → ${t}`);
                break;
            }
            case 'stream': {
                const on = await confirm({ message: 'Stream responses?', default: config.get('stream') });
                config.save({ stream: on });
                log.success(`streaming → ${on ? 'on' : 'off'}`);
                break;
            }
            case 'prompt':
                await setPrompt();
                break;
            case 'show':
                showConfig();
                break;
            case 'exit':
                return;
        }
    }
}
