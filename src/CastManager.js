/**
 * CastManager - Core management of cast personas
 * 
 * Responsibilities:
 * - Load and manage all available casts
 * - Switch between casts
 * - Create new casts from templates
 * - Export/import casts
 * - Track active cast state
 */

const fs = require('fs').promises;
const path = require('path');
const Logger = require('./Logger');
const StateManager = require('./StateManager');

class CastManager {
  constructor(castsDir) {
    this.casts = new Map();
    this.activeCast = null;
    this.logger = new Logger('CastManager');
    this.stateManager = new StateManager();

    const defaultCastsDir = path.join(__dirname, '..', '..', 'casts');
    this.castsDir = path.resolve(castsDir || defaultCastsDir);
    this.workspaceRoot = path.dirname(this.castsDir);
    this.templatesDir = path.join(this.castsDir, '_templates');
  }
  
  /**
   * Load all available casts from casts/ directory
   */
  async loadCasts() {
    await this.logger.info('Loading casts...');
    const startTime = Date.now();
    
    // Load persisted state
    await this.stateManager.load();
    
    try {
      const entries = await fs.readdir(this.castsDir, { withFileTypes: true });
      
      for (const entry of entries) {
        // Skip templates and hidden files
        if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
        if (!entry.isDirectory()) continue;
        
        try {
          const cast = await this.loadCast(entry.name);
          this.casts.set(cast.id, cast);
          await this.logger.debug(`Loaded cast: ${cast.id}`);
        } catch (error) {
          await this.logger.error(`Failed to load cast ${entry.name}:`, {
            error: error.message
          });
        }
      }
      
      // Restore active cast from state
      const savedActiveCast = this.stateManager.getActiveCast();
      if (savedActiveCast && this.casts.has(savedActiveCast)) {
        this.activeCast = this.casts.get(savedActiveCast);
        await this.logger.info(`Restored active cast: ${savedActiveCast}`);
      }
      
      const duration = Date.now() - startTime;
      await this.logger.info(`Loaded ${this.casts.size} casts in ${duration}ms`);
      
    } catch (error) {
      await this.logger.error('Failed to load casts directory:', {
        error: error.message
      });
      throw error;
    }
  }
  
  /**
   * Load a single cast by ID
   */
  async loadCast(castId) {
    const castPath = path.join(this.castsDir, castId);
    const configPath = path.join(castPath, 'cast.json');
    const profilePath = path.join(castPath, 'profile.md');
    
    // Load and validate config
    let config;
    try {
      const configData = await fs.readFile(configPath, 'utf8');
      config = JSON.parse(configData);
    } catch (error) {
      throw new Error(`Invalid or missing cast.json for ${castId}: ${error.message}`);
    }
    
    // Validate required fields
    if (!config.id || !config.name) {
      throw new Error(`Cast ${castId} missing required fields (id, name)`);
    }
    
    // Check for profile
    let profileExists = false;
    try {
      await fs.access(profilePath);
      profileExists = true;
    } catch {
      await this.logger.warn(`Cast ${castId} missing profile.md`);
    }
    
    // Check directory structure
    const requiredDirs = ['memory', 'context', 'docs'];
    for (const dir of requiredDirs) {
      const dirPath = path.join(castPath, dir);
      try {
        await fs.access(dirPath);
      } catch {
        await this.logger.warn(`Cast ${castId} missing ${dir}/ directory, creating...`);
        await fs.mkdir(dirPath, { recursive: true });
      }
    }
    
    return {
      id: config.id,
      config,
      path: castPath,
      profilePath: profileExists ? profilePath : null,
      memoryPath: path.join(castPath, 'memory'),
      contextPath: path.join(castPath, 'context'),
      docsPath: path.join(castPath, 'docs'),
      indexPath: path.join(castPath, 'index'),
      logsPath: path.join(castPath, 'logs')
    };
  }
  
  /**
   * Get a cast by ID (without activating)
   */
  getCast(castId) {
    return this.casts.get(castId);
  }
  
  /**
   * List all available casts
   */
  listCasts() {
    return Array.from(this.casts.values()).map(cast => ({
      id: cast.id,
      name: cast.config.name,
      version: cast.config.version,
      created: cast.config.created,
      contextCount: cast.config.context?.totalDocuments || 0
    }));
  }
  
  /**
   * Switch to a different cast
   */
  async switchCast(castId, options = {}) {
    const { preserveContext = true } = options;
    
    await this.logger.info(`Switching to cast: ${castId}`, { preserveContext });
    const startTime = Date.now();
    
    // 1. Save current cast state if exists
    if (this.activeCast) {
      await this._saveCastState(this.activeCast);
      await this.logger.debug(`Saved state for: ${this.activeCast.id}`);
    }
    
    // 2. Validate and load target cast
    const targetCast = this.casts.get(castId);
    if (!targetCast) {
      const error = new Error(`Cast "${castId}" not found`);
      await this.logger.error('Switch failed', { error: error.message });
      throw error;
    }
    
    // 3. Load profile content
    let profileContent = null;
    if (targetCast.profilePath) {
      try {
        profileContent = await fs.readFile(targetCast.profilePath, 'utf8');
      } catch (error) {
        await this.logger.warn(`Could not load profile for ${castId}:`, {
          error: error.message
        });
      }
    }
    
    // 4. Get memory stats
    const memoryStats = await this._getMemoryStats(targetCast);
    
    // 5. Update active cast
    const previousCast = this.activeCast?.id;
    this.activeCast = targetCast;
    
    // 6. Persist to state
    await this.stateManager.setActiveCast(castId);
    
    // 7. Log the switch
    const duration = Date.now() - startTime;
    await this.logger.info(`Switched to ${castId}`, {
      duration,
      from: previousCast,
      memoryFiles: memoryStats.fileCount,
      contextDocs: targetCast.config.context?.totalDocuments || 0
    });
    
    // 7. Return switch result
    return {
      success: true,
      from: previousCast,
      to: castId,
      profile: profileContent,
      cast: {
        id: targetCast.id,
        name: targetCast.config.name,
        memoryPath: targetCast.memoryPath,
        contextPath: targetCast.contextPath
      },
      stats: memoryStats,
      duration
    };
  }
  
  /**
   * Create a new cast from template
   */
  async createCast(castId, templateId, options = {}) {
    await this.logger.info(`Creating cast ${castId} from template ${templateId}`);
    
    // 1. Validate castId
    if (!castId || !/^[a-z0-9-]+$/.test(castId)) {
      throw new Error('Invalid cast ID. Use lowercase letters, numbers, and hyphens only.');
    }
    
    if (this.casts.has(castId)) {
      throw new Error(`Cast "${castId}" already exists`);
    }
    
    // 2. Validate template
    const templatePath = path.join(this.templatesDir, templateId);
    try {
      await fs.access(templatePath);
    } catch {
      throw new Error(`Template "${templateId}" not found`);
    }
    
    // 3. Copy template to new cast
    const castPath = path.join(this.castsDir, castId);
    await this.logger.debug(`Copying template to ${castPath}`);
    
    await fs.cp(templatePath, castPath, { recursive: true });
    
    // 4. Update cast.json
    const configPath = path.join(castPath, 'cast.json');
    let config;
    
    try {
      const configData = await fs.readFile(configPath, 'utf8');
      config = JSON.parse(configData);
    } catch {
      // If no template config, create default
      config = {};
    }
    
    // Set new values
    config.id = castId;
    config.name = options.name || castId;
    config.created = new Date().toISOString();
    config.modified = config.created;
    config.version = '1.0.0';
    config.template = templateId;
    config.context = config.context || {};
    config.context.totalDocuments = 0;
    config.context.totalSizeBytes = 0;
    
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    
    // 5. Create required directories
    const dirs = ['memory', 'context', 'docs', 'index', 'logs', 'system'];
    for (const dir of dirs) {
      await fs.mkdir(path.join(castPath, dir), { recursive: true });
    }
    
    // 6. Auto-populate the new cast with comprehensive content
    await this.logger.info(`Auto-populating cast ${castId}...`);
    const CastAutoPopulator = require('./CastAutoPopulator');
    const populator = new CastAutoPopulator(this.castsDir.replace('/casts', ''));
    await populator.populate(castId, {
      name: options.name,
      emoji: options.emoji,
      color: options.color,
      description: options.description,
      activationPatterns: options.activationPatterns,
      capabilities: options.capabilities
    });
    
    // 7. Load and register the new cast
    const cast = await this.loadCast(castId);
    this.casts.set(castId, cast);
    
    await this.logger.info(`Created and populated cast: ${castId}`);
    
    return cast;
  }

  /**
   * Delete an existing cast
   */
  async deleteCast(castId, options = {}) {
    const { allowActiveDelete = true } = options;
    const id = String(castId || '').trim();
    if (!id) {
      throw new Error('castId is required');
    }

    const cast = this.casts.get(id);
    if (!cast) {
      throw new Error(`Cast "${id}" not found`);
    }

    const wasActive = this.activeCast && this.activeCast.id === id;
    if (wasActive && !allowActiveDelete) {
      throw new Error(`Cast "${id}" is active and cannot be deleted right now`);
    }

    await this.logger.info(`Deleting cast: ${id}`, { wasActive });

    await fs.rm(cast.path, { recursive: true, force: false });
    this.casts.delete(id);

    if (wasActive) {
      this.activeCast = null;
      await this.stateManager.setActiveCast(null);
    }

    return {
      success: true,
      deletedCastId: id,
      wasActive
    };
  }
  
  /**
   * Export a cast to ZIP file
   */
  async exportCast(castId, options = {}) {
    const CastExporter = require('./CastExporter');
    const exporter = new CastExporter(this);
    return exporter.exportCast(castId, options);
  }
  
  /**
   * Import a cast from ZIP file
   */
  async importCast(zipPath, options = {}) {
    const CastExporter = require('./CastExporter');
    const exporter = new CastExporter(this);
    return exporter.importCast(zipPath, options);
  }
  
  /**
   * Get current active cast
   */
  getActiveCast() {
    return this.activeCast;
  }
  
  /**
   * Helper: Save current cast state
   */
  async _saveCastState(cast) {
    // Update modified timestamp
    const configPath = path.join(cast.path, 'cast.json');
    try {
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      config.modified = new Date().toISOString();
      await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    } catch (error) {
      await this.logger.warn('Failed to update cast modified time:', {
        error: error.message
      });
    }
  }
  
  /**
   * Helper: Get memory directory stats
   */
  async _getMemoryStats(cast) {
    try {
      const files = await fs.readdir(cast.memoryPath);
      const mdFiles = files.filter(f => f.endsWith('.md'));
      
      return {
        fileCount: mdFiles.length,
        path: cast.memoryPath
      };
    } catch {
      return { fileCount: 0, path: cast.memoryPath };
    }
  }
}

module.exports = CastManager;
