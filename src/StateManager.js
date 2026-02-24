/**
 * StateManager - Persist active cast and system state
 * 
 * Simple JSON file-based state storage
 */

const fs = require('fs').promises;
const path = require('path');

const STATE_FILE = 'cast-system/state.json';

class StateManager {
  constructor() {
    this.state = {
      activeCast: null,
      lastAccess: null,
      preferences: {}
    };
  }
  
  async load() {
    try {
      const data = await fs.readFile(STATE_FILE, 'utf8');
      this.state = JSON.parse(data);
    } catch {
      // No state file yet, use defaults
      await this.save();
    }
    return this.state;
  }
  
  async save() {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(this.state, null, 2));
  }
  
  getActiveCast() {
    return this.state.activeCast;
  }
  
  async setActiveCast(castId) {
    this.state.activeCast = castId;
    this.state.lastAccess = new Date().toISOString();
    await this.save();
  }
  
  async clearActiveCast() {
    this.state.activeCast = null;
    await this.save();
  }
  
  getPreference(key, defaultValue = null) {
    return this.state.preferences[key] ?? defaultValue;
  }
  
  async setPreference(key, value) {
    this.state.preferences[key] = value;
    await this.save();
  }
}

module.exports = StateManager;
