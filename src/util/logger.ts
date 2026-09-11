export type LogFormat = 'human' | 'json';

export interface Logger {
  /**
   * The format this logger writes in. Absent for custom loggers, which are
   * treated as human (the createLogger() JSON schema is only guaranteed by
   * the logger it produces).
   */
  readonly format?: LogFormat;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export function createLogger(format: LogFormat): Logger {
  const write = (
    level: 'info' | 'warn' | 'error',
    message: string,
    data?: Record<string, unknown>,
  ) => {
    const stream = level === 'error' ? console.error : console.log;
    if (format === 'json') {
      stream(JSON.stringify({ level, message, ...data }));
      return;
    }
    stream(data ? `${message} ${JSON.stringify(data)}` : message);
  };

  return {
    format,
    info: (message, data) => write('info', message, data),
    warn: (message, data) => write('warn', message, data),
    error: (message, data) => write('error', message, data),
  };
}
