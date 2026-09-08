import { createLogger, type Logger } from '../util/logger.js';

export function loggerForFlags(flags: { json?: boolean }): Logger {
  return createLogger(flags.json ? 'json' : 'human');
}
