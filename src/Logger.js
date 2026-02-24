/**
 * Logger - Detailed logging system for Cast System
 * 
 * Features:
 * - Structured JSON logging
 * - Per-component and per-cast logs
 * - Log levels (debug, info, warn, error)
 * - Automatic log rotation (future)
 * - Performance timing helpers
 */

const fs = require('fs').promises;
const path = require('path');

class Logger {
  constructor(component, castId = null, options = {}) {
    this.component = component;
    this.castId = castId;
    this.options = {
      level: options.level || 'info',
      console: options.console !== false,
      file: options.file !== false,
      ...options
    };
    
    // Determine log path
    if (castId) {
      this.logPath = path.join('casts', castId, 'logs', 'operations.log');
      this.systemLogPath = 'cast-system/logs/all-operations.log';
    } else {
      this.logPath = 'cast-system/logs/system.log';
    }
    
    this.errorLogPath = 'cast-system/logs/errors.log';
    
    // Ensure log directories exist
    this._ensureLogDir();
  }
  
  async _ensureLogDir() {
    try {
      await fs.mkdir(path.dirname(this.logPath), { recursive: true });
      if (this.systemLogPath) {
        await fs.mkdir(path.dirname(this.systemLogPath), { recursive: true });
      }
      await fs.mkdir(path.dirname(this.errorLogPath), { recursive: true });
    } catch (error) {
      console.error('Failed to create log directories:', error);
    }
  }
  
  _shouldLog(level) {
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    return levels[level] >= levels[this.options.level];
  }
  
  _formatEntry(level, message, context = {}) {
    return {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      castId: this.castId,
      message,
      context: Object.keys(context).length > 0 ? context : undefined,
      pid: process.pid
    };
  }
  
  async _writeLog(entry, isError = false) {
    const logLine = JSON.stringify(entry) + '\n';
    
    try {
      // Write to component/cast log
      if (this.options.file) {
        await fs.appendFile(this.logPath, logLine);
      }
      
      // Also write to system-wide log for cross-cast visibility
      if (this.systemLogPath && this.options.file) {
        await fs.appendFile(this.systemLogPath, logLine);
      }
      
      // Errors also go to dedicated error log
      if (isError && this.options.file) {
        await fs.appendFile(this.errorLogPath, logLine);
      }
    } catch (error) {
      console.error('Failed to write log:', error);
    }
  }
  
  _consoleOutput(entry) {
    if (!this.options.console) return;
    
    const colors = {
      debug: '\x1b[36m',  // Cyan
      info: '\x1b[32m',   // Green
      warn: '\x1b[33m',   // Yellow
      error: '\x1b[31m',  // Red
      reset: '\x1b[0m'
    };
    
    const color = colors[entry.level] || colors.reset;
    const prefix = entry.castId 
      ? `[${entry.castId}] ${entry.component}`
      : entry.component;
    
    console.log(
      `${color}[${entry.level.toUpperCase()}]${colors.reset} ` +
      `${prefix}: ${entry.message}`
    );
    
    if (entry.context && Object.keys(entry.context).length > 0) {
      console.log('  Context:', JSON.stringify(entry.context, null, 2));
    }
  }
  
  async log(level, message, context = {}) {
    if (!this._shouldLog(level)) return;
    
    const entry = this._formatEntry(level, message, context);
    
    // Console output
    this._consoleOutput(entry);
    
    // File output
    await this._writeLog(entry, level === 'error');
    
    return entry;
  }
  
  // Convenience methods
  async debug(message, context) {
    return this.log('debug', message, context);
  }
  
  async info(message, context) {
    return this.log('info', message, context);
  }
  
  async warn(message, context) {
    return this.log('warn', message, context);
  }
  
  async error(message, context) {
    return this.log('error', message, context);
  }
  
  // Performance timing helper
  async time(label, fn) {
    const start = Date.now();
    this.debug(`Starting: ${label}`);
    
    try {
      const result = await fn();
      const duration = Date.now() - start;
      this.info(`Completed: ${label}`, { duration });
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      this.error(`Failed: ${label}`, { duration, error: error.message });
      throw error;
    }
  }
  
  // Create child logger with additional context
  child(additionalContext) {
    const childLogger = new Logger(this.component, this.castId, this.options);
    childLogger._formatEntry = (level, message, context = {}) => {
      return this._formatEntry(level, message, {
        ...additionalContext,
        ...context
      });
    };
    return childLogger;
  }
}

// Static method to read logs
Logger.readLogs = async (logPath, options = {}) => {
  const { limit = 100, level = null, since = null } = options;
  
  try {
    const content = await fs.readFile(logPath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    
    let entries = lines.map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
    
    // Filter by level
    if (level) {
      const levels = { debug: 0, info: 1, warn: 2, error: 3 };
      const minLevel = levels[level];
      entries = entries.filter(e => levels[e.level] >= minLevel);
    }
    
    // Filter by time
    if (since) {
      const sinceDate = new Date(since);
      entries = entries.filter(e => new Date(e.timestamp) >= sinceDate);
    }
    
    // Limit results
    return entries.slice(-limit);
  } catch (error) {
    console.error('Failed to read logs:', error);
    return [];
  }
};

module.exports = Logger;
