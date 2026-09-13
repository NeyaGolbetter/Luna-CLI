import { select, input } from '@inquirer/prompts';
import chalk from 'chalk';
import { ProviderError } from '../utils/errors.js';
import { log } from '../utils/logger.js';
/**
 * GET /v1/models with graceful degradation: providers without a models
 * endpoint (or with auth quirks) fall back to manual entry.
 */
export async function fetchModels(client) {
    try {
        const models = await client.listModels();
        if (models.length === 0)
            log.debug('provider returned an empty model list');
        return models;
    }
    catch (e) {
        if (e instanceof ProviderError && e.status === 404) {
            log.debug('provider has no /models endpoint — falling back to manual model entry');
            return [];
        }
        throw e;
    }
}
function modelChoiceLabel(m) {
    const owner = m.owned_by ? ` — ${m.owned_by}` : '';
    return `${m.id}${owner}`;
}
/**
 * Interactive model picker (Module A.2). Shows fetched models via an inquirer
 * list prompt; on failure, prompts for a manual model id. Persists the choice.
 */
export async function pickModel(cfg, client, onSaved) {
    const models = await fetchModels(client);
    let model;
    if (models.length > 0) {
        const MAX_LIST = 150;
        const shown = models.slice(0, MAX_LIST);
        const entries = [
            ...shown.map((m) => ({ name: modelChoiceLabel(m), value: m.id })),
            { name: chalk.dim('Type a model id manually…'), value: '__manual__' },
        ];
        const current = cfg.activeModel;
        if (current && models.some((m) => m.id === current)) {
            entries.unshift({ name: `★ ${current}`, value: current });
        }
        const picked = await select({
            message: `Pick the active model (${models.length} available):`,
            choices: entries,
            pageSize: 15,
        });
        if (picked === '__manual__') {
            model = await input({
                message: 'Model id (e.g. gpt-4o-mini):',
                validate: (v) => (v.trim() ? true : 'Model id cannot be empty.'),
            });
        }
        else {
            model = picked;
        }
    }
    else {
        model = await input({
            message: 'Model id (provider did not expose /models):',
            default: cfg.activeModel || undefined,
            validate: (v) => (v.trim() ? true : 'Model id cannot be empty.'),
        });
    }
    const trimmed = model.trim();
    onSaved?.(trimmed);
    return trimmed;
}
