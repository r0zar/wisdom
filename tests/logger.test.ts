import { describe, it, expect } from 'vitest';
import { logger, getContextLogger, AppError } from '../src/logger';

describe('Logger', () => {
  it('should export a logger instance', () => {
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('should create context loggers', () => {
    const contextLogger = getContextLogger('test-context');
    expect(contextLogger).toBeDefined();
    expect(typeof contextLogger.info).toBe('function');
  });

  it('should create and log app errors', () => {
    const error = new AppError({
      message: 'Test error',
      context: 'test',
      code: 'TEST_ERROR'
    });
    
    expect(error).toBeInstanceOf(AppError);
    expect(error.message).toBe('Test error');
    expect(error.context).toBe('test');
    expect(error.code).toBe('TEST_ERROR');
    
    // Just verify log method exists and doesn't throw
    expect(() => error.log()).not.toThrow();
  });
});