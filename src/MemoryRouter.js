/**
 * MemoryRouter - Routes memory operations to cast-specific locations
 * 
 * Features:
 * - Cast-specific memory paths (casts/{id}/memory/)
 * - Shared session context (cast-shared/)
 * - Memory indexing and search
 * - Handoff messages between casts
 * 
 * Architecture:
 * - Each cast has isolated memory (their notes, learnings)
 * - Shared session visible to all (current conversation)
 * - Handoffs enable cast-to-cast communication
 */

const fs = require('fs').promises;
const path = require('path');
const Logger = require('./Logger');

class MemoryRouter {
  constructor(castManager, options = {}) {
    this.castManager = castManager;
    this.logger = new Logger('MemoryRouter');
    this.sharedPath = 'cast-shared';
    this.handoffsPath = path.join(this.sharedPath, 'handoffs');
    this.contextStore = options.contextStore || null;
  }
  
  /**
   * Initialize shared directories
   */
  async initialize() {
    await this.logger.info('Initializing MemoryRouter');
    
    // Ensure shared directories exist
    await fs.mkdir(this.sharedPath, { recursive: true });
    await fs.mkdir(this.handoffsPath, { recursive: true });
    await fs.mkdir(path.join(this.sharedPath, 'memory'), { recursive: true });
    
    await this.logger.debug('Shared directories created');
  }
  
  /**
   * Save a memory entry
   */
  async save(entry, options = {}) {
    const {
      importance = 'normal',  // 'low', 'normal', 'high', 'critical'
      shared = false,         // Also save to shared session?
      castId = null           // Override cast (default: active)
    } = options;
    
    const targetCast = castId 
      ? this.castManager.getCast(castId)
      : this.castManager.getActiveCast();
    
    if (!targetCast) {
      throw new Error('No target cast for memory save');
    }
    
    const timestamp = new Date().toISOString();
    const date = timestamp.split('T')[0];
    
    // Format entry
    const formattedEntry = this._formatEntry(entry, timestamp, importance);
    
    // Save to cast-specific memory
    const castMemoryPath = path.join(targetCast.memoryPath, `${date}.md`);
    await this._appendToFile(castMemoryPath, formattedEntry);
    
    await this.logger.debug(`Saved to ${targetCast.id} memory`, {
      date,
      importance,
      shared
    });
    
    // Also save to shared if high importance or explicitly requested
    if (shared || importance === 'high' || importance === 'critical') {
      const sharedPath = path.join(this.sharedPath, 'memory', `${date}.md`);
      const sharedEntry = this._formatSharedEntry(entry, timestamp, targetCast.id);
      await this._appendToFile(sharedPath, sharedEntry);
      
      await this.logger.debug('Also saved to shared memory');
    }

    if (this.contextStore) {
      await this.contextStore.addSessionEntry(entry, {
        type: 'memory_entry',
        source: 'system',
        castId: targetCast.id,
        userId: null,
        confidence: importance === 'critical' ? 0.95 : importance === 'high' ? 0.85 : 0.7
      });
      await this.contextStore.addEpisodicEvent({
        type: 'memory_router_save',
        text: entry,
        castId: targetCast.id,
        source: 'system',
        metadata: { importance, shared }
      });
    }
    
    return {
      saved: true,
      cast: targetCast.id,
      date,
      importance,
      shared
    };
  }
  
  /**
   * Get memory for current cast
   */
  async getRecent(options = {}) {
    const {
      days = 7,
      limit = 50,
      importance = null,  // Filter by importance
      includeShared = true
    } = options;
    
    const activeCast = this.castManager.getActiveCast();
    if (!activeCast) {
      throw new Error('No active cast');
    }
    
    const entries = [];
    
    // Get cast-specific memory
    const castEntries = await this._readCastMemory(activeCast, days);
    entries.push(...castEntries.map(e => ({ ...e, source: 'cast' })));
    
    // Get shared memory if requested
    if (includeShared) {
      const sharedEntries = await this._readSharedMemory(days);
      // Filter to only entries relevant to this cast or high importance
      const relevantShared = sharedEntries.filter(e => 
        e.castId === activeCast.id || 
        e.importance === 'high' ||
        e.importance === 'critical'
      );
      entries.push(...relevantShared.map(e => ({ ...e, source: 'shared' })));
    }
    
    // Sort by timestamp (newest first)
    entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    // Filter by importance if specified
    let filtered = entries;
    if (importance) {
      filtered = entries.filter(e => e.importance === importance);
    }
    
    // Limit results
    const limited = filtered.slice(0, limit);
    
    return {
      entries: limited,
      total: entries.length,
      cast: activeCast.id,
      days
    };
  }
  
  /**
   * Create a handoff message to another cast
   */
  async createHandoff(toCastId, message, options = {}) {
    const fromCast = this.castManager.getActiveCast();
    if (!fromCast) {
      throw new Error('No active cast to send handoff from');
    }
    
    const toCast = this.castManager.getCast(toCastId);
    if (!toCast) {
      throw new Error(`Cast "${toCastId}" not found`);
    }
    
    const timestamp = new Date().toISOString();
    const handoff = {
      id: `handoff-${Date.now()}`,
      from: fromCast.id,
      to: toCastId,
      timestamp,
      message,
      context: options.context || {},
      status: 'pending'
    };
    
    // Save to handoffs directory
    const handoffFile = path.join(
      this.handoffsPath,
      `${fromCast.id}-to-${toCastId}-${Date.now()}.json`
    );
    
    await fs.writeFile(handoffFile, JSON.stringify(handoff, null, 2));
    
    await this.logger.info('Handoff created', {
      from: fromCast.id,
      to: toCastId,
      handoffId: handoff.id
    });
    
    return handoff;
  }
  
  /**
   * Get pending handoffs for current cast
   */
  async getHandoffs(options = {}) {
    const {
      status = 'pending',  // 'pending', 'read', 'all'
      from = null          // Filter by sender
    } = options;
    
    const activeCast = this.castManager.getActiveCast();
    if (!activeCast) {
      throw new Error('No active cast');
    }
    
    const handoffs = [];
    
    try {
      const files = await fs.readdir(this.handoffsPath);
      
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        
        // Check if this handoff is for the active cast
        if (!file.includes(`-to-${activeCast.id}-`)) continue;
        
        const filePath = path.join(this.handoffsPath, file);
        const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
        
        // Filter by status
        if (status !== 'all' && data.status !== status) continue;
        
        // Filter by sender
        if (from && data.from !== from) continue;
        
        handoffs.push(data);
      }
    } catch (error) {
      await this.logger.warn('Could not read handoffs', { error: error.message });
    }
    
    // Sort by timestamp (newest first)
    handoffs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    return {
      handoffs,
      count: handoffs.length,
      cast: activeCast.id
    };
  }
  
  /**
   * Mark handoff as read
   */
  async readHandoff(handoffId) {
    try {
      const files = await fs.readdir(this.handoffsPath);
      
      for (const file of files) {
        const filePath = path.join(this.handoffsPath, file);
        const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
        
        if (data.id === handoffId) {
          data.status = 'read';
          data.readAt = new Date().toISOString();
          await fs.writeFile(filePath, JSON.stringify(data, null, 2));
          
          await this.logger.info('Handoff marked as read', { handoffId });
          return data;
        }
      }
    } catch (error) {
      await this.logger.error('Failed to read handoff', { error: error.message });
    }
    
    return null;
  }
  
  /**
   * Get current session context (shared across all casts)
   */
  async getSessionContext() {
    const sessionPath = path.join(this.sharedPath, 'current-session.md');
    
    try {
      const content = await fs.readFile(sessionPath, 'utf8');
      return {
        exists: true,
        content,
        lastModified: (await fs.stat(sessionPath)).mtime.toISOString()
      };
    } catch {
      return {
        exists: false,
        content: '',
        lastModified: null
      };
    }
  }
  
  /**
   * Update shared session context
   */
  async updateSessionContext(content, options = {}) {
    const { append = true } = options;
    const sessionPath = path.join(this.sharedPath, 'current-session.md');
    
    if (append) {
      const timestamp = new Date().toISOString();
      const entry = `\n## ${timestamp}\n\n${content}\n`;
      await this._appendToFile(sessionPath, entry);
    } else {
      await fs.writeFile(sessionPath, content);
    }
    
    const activeCast = this.castManager.getActiveCast();
    await this.logger.info('Session context updated', {
      by: activeCast?.id || 'unknown',
      append
    });
    
    return {
      updated: true,
      path: sessionPath
    };
  }
  
  // ===== Private helpers =====
  
  _formatEntry(entry, timestamp, importance) {
    const importanceBadge = importance !== 'normal' ? ` [${importance.toUpperCase()}]` : '';
    
    return `\n### ${timestamp}${importanceBadge}\n\n${entry}\n`;
  }
  
  _formatSharedEntry(entry, timestamp, castId) {
    return `\n### ${timestamp} [from: ${castId}]\n\n${entry}\n`;
  }
  
  async _appendToFile(filePath, content) {
    try {
      await fs.appendFile(filePath, content);
    } catch (error) {
      // File might not exist yet
      await fs.writeFile(filePath, content);
    }
  }
  
  async _readCastMemory(cast, days) {
    const entries = [];
    const today = new Date();
    
    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      
      const filePath = path.join(cast.memoryPath, `${dateStr}.md`);
      
      try {
        const content = await fs.readFile(filePath, 'utf8');
        const parsed = this._parseMemoryFile(content, dateStr);
        entries.push(...parsed);
      } catch {
        // File doesn't exist, skip
      }
    }
    
    return entries;
  }
  
  async _readSharedMemory(days) {
    const entries = [];
    const today = new Date();
    
    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      
      const filePath = path.join(this.sharedPath, 'memory', `${dateStr}.md`);
      
      try {
        const content = await fs.readFile(filePath, 'utf8');
        const parsed = this._parseMemoryFile(content, dateStr);
        entries.push(...parsed);
      } catch {
        // File doesn't exist, skip
      }
    }
    
    return entries;
  }
  
  _parseMemoryFile(content, date) {
    const entries = [];
    const lines = content.split('\n');
    
    let currentEntry = null;
    
    for (const line of lines) {
      // Match header line
      const headerMatch = line.match(/^###\s+(.+?)(?:\s+\[from:\s*(\w+)\])?(?:\s+\[(HIGH|CRITICAL|LOW)\])?$/);
      
      if (headerMatch) {
        if (currentEntry) {
          entries.push(currentEntry);
        }
        
        currentEntry = {
          timestamp: headerMatch[1],
          date,
          castId: headerMatch[2] || null,
          importance: headerMatch[3] || 'normal',
          content: ''
        };
      } else if (currentEntry && line.trim()) {
        currentEntry.content += line + '\n';
      }
    }
    
    if (currentEntry) {
      entries.push(currentEntry);
    }
    
    return entries;
  }
}

module.exports = MemoryRouter;
