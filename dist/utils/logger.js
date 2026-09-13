import chalk from 'chalk';
const isDebug = () => process.env.LUNA_DEBUG === '1';
export const log = {
    info(msg) {
        process.stdout.write(msg + '\n');
    },
    success(msg) {
        process.stderr.write(chalk.green('✔ ') + msg + '\n');
    },
    warn(msg) {
        process.stderr.write(chalk.yellow('⚠ ') + msg + '\n');
    },
    error(msg) {
        process.stderr.write(chalk.red('✖ ') + msg + '\n');
    },
    debug(msg) {
        if (isDebug())
            process.stderr.write(chalk.cyan('· ') + msg + '\n');
    },
    /** Print an error and exit the process. */
    die(msg, code = 1) {
        log.error(msg);
        process.exit(code);
    },
};
export const v = chalk;
