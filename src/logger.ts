// Simple logger interface
export interface Logger {
  info: (obj: any, msg?: string) => void;
  error: (obj: any, msg?: string) => void;
  warn: (obj: any, msg?: string) => void;
  debug: (obj: any, msg?: string) => void;
  child: (bindings: object) => Logger;
}

/**
 * Centralized logger configuration
 * 
 * This provides consistent logging across all modules with proper
 * context and standardized error handling.
 */

// Create a logger factory
const createLogger = (): Logger => {
  try {
    // Try to import pino dynamically at runtime
    const { pino } = require('pino');
    return pino({
      level: process.env.LOG_LEVEL || 'info',
      base: { service: 'wisdom-sdk' },
    });
  } catch (e) {
    // Fallback logger implementation
    return {
      info: (obj: any, msg?: string) => console.info(msg || '', obj),
      error: (obj: any, msg?: string) => console.error(msg || '', obj),
      warn: (obj: any, msg?: string) => console.warn(msg || '', obj),
      debug: (obj: any, msg?: string) => console.debug(msg || '', obj),
      child: (bindings: object) => {
        console.info('Creating child logger with bindings:', bindings);
        return createLogger();
      }
    };
  }
};

// Default logger instance
export const logger = createLogger();

// Create a child logger with context
export function getContextLogger(context: string): Logger {
  return logger.child({ context });
}

// Error handling utilities
export class AppError extends Error {
  public readonly context: string;
  public readonly code: string;
  public readonly originalError?: Error;
  public readonly data?: Record<string, unknown>;

  constructor({
    message,
    context = 'general',
    code = 'INTERNAL_ERROR',
    originalError,
    data,
  }: {
    message: string;
    context?: string;
    code?: string;
    originalError?: Error;
    data?: Record<string, unknown>;
  }) {
    super(message);
    this.name = 'AppError';
    this.context = context;
    this.code = code;
    this.originalError = originalError;
    this.data = data;
    // Preserve stack trace
    Error.captureStackTrace(this, this.constructor);
  }

  // Logs this error with appropriate context and returns it
  log() {
    const contextLogger = getContextLogger(this.context);
    const logObj = {
      code: this.code,
      error: this.message,
      ...(this.originalError && { originalError: this.originalError.message }),
      ...(this.data && { data: this.data }),
    };

    contextLogger.error(logObj, this.message);
    return this;
  }
}

export default logger;