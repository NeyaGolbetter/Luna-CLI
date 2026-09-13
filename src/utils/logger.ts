import chalk from 'chalk';

const isDebug = () => process.env.LUNA_DEBUG === '1';

export const log = {
  info(msg: string): void {
    process.stdout.write(msg + '\n');
  },
  success(msg: string): void {
    process.stderr.write(chalk.green('✔ ') + msg + '\n');
  },
  warn(msg: string): void {
    process.stderr.write(chalk.yellow('⚠ ') + msg + '\n');
  },
  error(msg: string): void {
    process.stderr.write(chalk.red('✖ ') + msg + '\n');
  },
  debug(msg: string): void {
    if (isDebug()) process.stderr.write(chalk.cyan('· ') + msg + '\n');
  },
  /** Print an error and exit the process. */
  die(msg: string, code = 1): never {
    log.error(msg);
    process.exit(code);
  },
};

export const v = chalk;
