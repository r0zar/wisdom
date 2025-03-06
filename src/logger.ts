// Simple logger interface
export interface Logger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  debug: (obj: Record<string, unknown>, msg?: string) => void;
  child: (bindings: object) => Logger;
}

/**
 * Centralized logger configuration
 * 
 * This provides consistent logging across all modules with proper
 * context and standardized error handling.
 */

// Simple console-based logger factory - no external dependencies
const createLogger = (): Logger => {
  // Get log level from environment or default to 'info'
  const logLevel = process.env.LOG_LEVEL || 'info';
  
  // Map log levels to numeric values for comparison
  const logLevels = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
  } as const;
  
  // Current log level
  const currentLevelValue = logLevel in logLevels 
    ? logLevels[logLevel as keyof typeof logLevels] 
    : logLevels.info;
  
  // Format a log message with timestamp and metadata
  const formatLog = (level: string, obj: Record<string, unknown>, msg?: string): string => {
    const timestamp = new Date().toISOString();
    const service = 'wisdom-sdk';
    const objStr = JSON.stringify(obj);
    return `[${timestamp}] ${level.toUpperCase()} [${service}] ${msg || ''} ${objStr}`;
  };
  
  // Simple implementation using console methods
  return {
    debug: (obj: Record<string, unknown>, msg?: string) => {
      if (currentLevelValue <= 0) { // debug level
        console.debug(formatLog('debug', obj, msg));
      }
    },
    info: (obj: Record<string, unknown>, msg?: string) => {
      if (currentLevelValue <= 1) { // info level
        console.info(formatLog('info', obj, msg));
      }
    },
    warn: (obj: Record<string, unknown>, msg?: string) => {
      if (currentLevelValue <= 2) { // warn level
        console.warn(formatLog('warn', obj, msg));
      }
    },
    error: (obj: Record<string, unknown>, msg?: string) => {
      if (currentLevelValue <= 3) { // error level
        console.error(formatLog('error', obj, msg));
      }
    },
    child: (bindings: object) => {
      // For child loggers, we merge the bindings with the log objects
      const childLogger = createLogger();
      
      // Override methods to include the bindings
      return {
        debug: (obj: Record<string, unknown>, msg?: string) => 
          childLogger.debug({ ...obj, ...bindings }, msg),
        info: (obj: Record<string, unknown>, msg?: string) => 
          childLogger.info({ ...obj, ...bindings }, msg),
        warn: (obj: Record<string, unknown>, msg?: string) => 
          childLogger.warn({ ...obj, ...bindings }, msg),
        error: (obj: Record<string, unknown>, msg?: string) => 
          childLogger.error({ ...obj, ...bindings }, msg),
        child: (nestedBindings: object) => 
          childLogger.child({ ...bindings, ...nestedBindings })
      };
    }
  };
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