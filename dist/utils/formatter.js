import chalk from 'chalk';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
export const VERSION = '0.1.0';
export const APP_NAME = 'luna';
/** Effective terminal width; safe on Termux (narrow) and non-TTY pipes. */
export function terminalWidth() {
    const w = process.stdout.columns || Number(process.env.LUNA_WIDTH) || 0;
    if (Number.isFinite(w) && w >= 20)
        return Math.min(w, 240);
    return 80;
}
export function isTermux() {
    return Boolean(process.env.TERMUX_VERSION) || process.platform === 'android';
}
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
export function stripAnsi(s) {
    return s.replace(ANSI_RE, '');
}
/** Word-wrap plain text to a width (accounts for ANSI sequences). */
export function wrapText(text, width = terminalWidth()) {
    const out = [];
    for (const rawLine of text.split('\n')) {
        const line = rawLine.replace(/\t/g, '  ');
        if (stripAnsi(line).length <= width) {
            out.push(line);
            continue;
        }
        let visual = 0;
        let cur = '';
        const push = () => {
            out.push(cur);
            cur = '';
            visual = 0;
        };
        // Hard-break a single token wider than the width (urls, long code).
        const pushWide = (tok) => {
            let rest = tok;
            while (stripAnsi(rest).length > width) {
                let cut = 0;
                let v = 0;
                while (cut < rest.length && v < width) {
                    const ch = rest[cut];
                    if (ch === '\u001b') {
                        // keep the whole escape sequence together
                        while (cut < rest.length && !/[@-~]/.test(rest[cut]))
                            cut++;
                        cut++;
                    }
                    else {
                        v++;
                        cut++;
                    }
                }
                out.push(rest.slice(0, cut));
                rest = rest.slice(cut);
            }
            cur = rest;
            visual = stripAnsi(cur).length;
        };
        // Split on words, preserving whitespace tokens.
        const tokens = line.split(/(\s+)/);
        for (const tok of tokens) {
            if (!tok)
                continue;
            const tLen = stripAnsi(tok).length;
            if (tok.trim() === '') {
                // whitespace-only token
                if (cur.length > 0) {
                    if (visual + tLen > width)
                        push();
                    cur += tok;
                    visual += tLen;
                }
                continue;
            }
            if (cur.length > 0 && visual + tLen > width)
                push();
            if (tLen > width) {
                pushWide(tok);
                continue;
            }
            cur += tok;
            visual += tLen;
        }
        if (cur.length > 0)
            out.push(cur);
    }
    return out.join('\n');
}
function codeFenceSize(text) {
    let total = 0;
    for (const m of text.matchAll(/```[\s\S]*?```/g))
        total += m[0].length;
    return total;
}
const HEAVY_CODE_THRESHOLD = 6000;
/**
 * Render Markdown to terminal-safe text.
 * Default path: marked-terminal (full styling, syntax highlighting).
 * For very code-heavy answers we fall back to a lightweight renderer so
 * low-end (Termux) devices don't stall on cli-highlight.
 */
export function renderMarkdown(md, width = terminalWidth()) {
    if (!md)
        return '';
    if (codeFenceSize(md) > HEAVY_CODE_THRESHOLD)
        return renderPlainMarkdown(md, width);
    try {
        const markedInstance = marked.use(markedTerminal({
            width,
            code: chalk.yellow,
            codespan: chalk.yellow,
            heading: chalk.green.bold,
            firstHeading: chalk.magenta.underline.bold,
            blockquote: chalk.gray.italic,
            hr: chalk.gray,
            list: chalk.reset,
            listitem: chalk.reset,
            table: chalk.reset,
            paragraph: chalk.reset,
            strong: chalk.bold,
            em: chalk.italic,
            link: chalk.blue,
            href: chalk.blue.underline,
            del: chalk.gray.strikethrough,
            emoji: false,
        }));
        const out = markedInstance.parse(md, { async: false });
        return typeof out === 'string' ? out : md;
    }
    catch {
        return renderPlainMarkdown(md, width);
    }
}
/** Minimal, fast Markdown renderer (headings, lists, code, emphasis, links). */
function renderPlainMarkdown(md, width) {
    const lines = md.split('\n');
    const out = [];
    let inCode = false;
    let codeLang = '';
    let listIndent = 0;
    for (const line of lines) {
        if (/^\s*```/.test(line)) {
            if (inCode) {
                out.push('');
                inCode = false;
            }
            else {
                inCode = true;
                codeLang = line.replace(/^\s*```/, '').trim();
                if (codeLang)
                    out.push(chalk.gray(`  ${codeLang}`));
            }
            continue;
        }
        if (inCode) {
            out.push(chalk.yellow('  ' + line));
            continue;
        }
        const h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) {
            out.push(chalk.green.bold(h[2].trim()));
            out.push('');
            continue;
        }
        const ul = line.match(/^\s*[-*+]\s+(.*)$/);
        if (ul) {
            out.push(`${' '.repeat(listIndent)}• ${ul[1]}`);
            continue;
        }
        const ol = line.match(/^\s*(\d+)\.\s+(.*)$/);
        if (ol) {
            out.push(`${' '.repeat(listIndent)}${ol[1]}. ${ol[2]}`);
            continue;
        }
        if (/^\s*([-*_]){3,}\s*$/.test(line)) {
            out.push(chalk.gray('─'.repeat(Math.min(width, 40))));
            continue;
        }
        out.push(line);
    }
    if (inCode)
        out.push('');
    return out.join('\n');
}
/** Heuristic: does this look like it wants Markdown rendering? */
export function looksLikeMarkdown(s) {
    return (/(^|\n)#{1,6}\s/.test(s) ||
        /```/.test(s) ||
        /^\s*[-*+]\s+\S/m.test(s) ||
        /\*\*[^*\n]+\*\*/.test(s) ||
        /(^|\n)\|.+\|/m.test(s));
}
export function renderAssistantText(text, width = terminalWidth()) {
    if (!text)
        return '';
    if (!looksLikeMarkdown(text) && !process.stdout.isTTY)
        return wrapText(text, width);
    return renderMarkdown(text, width);
}
const BANNER_LINES = [
    '    ▄████▄  ▒█████   ▓█████▄ ▄▄▄█████▓',
    '   ▒██▀ ▀█ ▒██▒  ██▒▒██▀ ██▒▓  ██▒ ▓',
    '   ▒▓█    ▄▒██░  ██▒░██   █▒▸  ▐▒▒▓▄░',
    '   ▒▓▓ ▄██▒██   ██░░▒█   ▓▒▄   ▒██ ░',
    '   ▒ ▓███▀ ░ ████▓▒░░░▒   ▒▒ ▒██▒   ░',
    '   ░ ░▒  ▒  ▒ ░▒  ▒    ░   ░ ▒░░  ░  ',
    '     ░   ░  ░  ░  ░    ░   ░  ░    ',
];
export function banner(model, provider, mcpServers, mcpTools) {
    const w = terminalWidth();
    const lines = BANNER_LINES.filter((l) => l.length <= w);
    const head = lines.map((l) => chalk.magenta(l)).join('\n');
    const sub = [
        chalk.dim('┌────────────────────────────────────────────'),
        chalk.dim('│') +
            '  ' +
            chalk.cyan('model') +
            chalk.dim('  ') +
            (model || chalk.dim('none')) +
            '   ' +
            chalk.cyan('provider') +
            chalk.dim('  ') +
            provider,
        chalk.dim('│') +
            '  ' +
            chalk.cyan('mcp') +
            chalk.dim('    ') +
            (mcpServers
                ? `${mcpServers} server(s), ${mcpTools} tool(s) ready`
                : chalk.dim('no servers configured (see `luna mcp add`)')),
        chalk.dim('│') + '  ' + chalk.dim('commands: /help /clear /model /tools /status /exit'),
        chalk.dim('└────────────────────────────────────────────'),
    ].join('\n');
    return head + '\n' + sub + '\n';
}
