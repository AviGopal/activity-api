/**
 * Structured logging utility
 * Supports both JSON and text formats based on configuration
 */

import { config } from '../config';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  [key: string]: any;
}

class Logger {
  private formatJson(level: LogLevel, message: string, context?: LogContext): string {
    const log = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      message,
      ...context,
    };
    return JSON.stringify(log);
  }

  private formatText(level: LogLevel, message: string, context?: LogContext): string {
    const timestamp = new Date().toISOString();
    const levelStr = level.toUpperCase().padEnd(5);
    const contextStr = context ? ` ${JSON.stringify(context)}` : '';
    return `${timestamp} ${levelStr} ${message}${contextStr}`;
  }

  private log(level: LogLevel, message: string, context?: LogContext): void {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const currentLevel = levels.indexOf(config.logLevel);
    const messageLevel = levels.indexOf(level);
    
    if (messageLevel < currentLevel) {
      return; // Skip logs below configured level
    }

    const formatted = config.logFormat === 'json'
      ? this.formatJson(level, message, context)
      : this.formatText(level, message, context);

    if (level === 'error') {
      console.error(formatted);
    } else if (level === 'warn') {
      console.warn(formatted);
    } else {
      console.log(formatted);
    }
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.log('error', message, context);
  }
}

export const logger = new Logger();
