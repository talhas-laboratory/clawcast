/**
 * Export/Import utilities for cast portability
 * 
 * Features:
 * - Export cast to ZIP with optional inclusions
 * - Import cast from ZIP with validation
 * - Export metadata and versioning
 * - Checksum verification
 */

const fs = require('fs').promises;
const path = require('path');
const AdmZip = require('adm-zip');
const crypto = require('crypto');
const Logger = require('./Logger');

class CastExporter {
  constructor(castManager) {
    this.castManager = castManager;
    this.logger = new Logger('CastExporter');
  }
  
  /**
   * Export a cast to ZIP file
   */
  async exportCast(castId, options = {}) {
    const {
      includeMemory = true,
      includeContext = true,
      includeLogs = false,
      includeIndex = true,
      outputDir = 'cast-exports'
    } = options;
    
    await this.logger.info(`Exporting cast: ${castId}`, options);
    
    // 1. Validate cast exists
    const cast = this.castManager.getCast(castId);
    if (!cast) {
      throw new Error(`Cast "${castId}" not found`);
    }
    
    // 2. Create ZIP
    const zip = new AdmZip();
    
    // 3. Add core files
    await this._addToZip(zip, cast.path, 'cast.json');
    await this._addToZip(zip, cast.path, 'profile.md');
    
    // 4. Add optional directories
    if (includeMemory) {
      await this._addDirectoryToZip(zip, cast.path, 'memory');
    }
    
    if (includeContext) {
      await this._addDirectoryToZip(zip, cast.path, 'context');
    }
    
    if (includeIndex) {
      await this._addDirectoryToZip(zip, cast.path, 'index');
    }
    
    if (includeLogs) {
      await this._addDirectoryToZip(zip, cast.path, 'logs');
    }
    
    // 5. Generate export metadata
    const exportMeta = {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      exportedBy: 'cast-system',
      originalCast: castId,
      castVersion: cast.config.version,
      options: {
        includeMemory,
        includeContext,
        includeLogs,
        includeIndex
      },
      stats: {
        memoryFiles: includeMemory ? await this._countFiles(cast.memoryPath) : 0,
        contextFiles: includeContext ? await this._countFiles(cast.contextPath) : 0,
        indexFiles: includeIndex ? await this._countFiles(cast.indexPath) : 0
      }
    };
    
    // Add metadata to ZIP
    zip.addFile('export-meta.json', Buffer.from(JSON.stringify(exportMeta, null, 2)));
    
    // 6. Ensure output directory exists
    await fs.mkdir(outputDir, { recursive: true });
    
    // 7. Generate filename
    const timestamp = new Date().toISOString().split('T')[0];
    const exportPath = path.join(outputDir, `${castId}-${timestamp}.cast.zip`);
    
    // 8. Write ZIP
    zip.writeZip(exportPath);
    
    // 9. Calculate checksum
    const checksum = await this._calculateChecksum(exportPath);
    
    await this.logger.info('Export complete', {
      path: exportPath,
      size: (await fs.stat(exportPath)).size,
      checksum
    });
    
    return {
      success: true,
      path: exportPath,
      castId,
      checksum,
      metadata: exportMeta
    };
  }
  
  /**
   * Import a cast from ZIP file
   */
  async importCast(zipPath, options = {}) {
    const {
      castId = null,  // Optional: rename on import
      overwrite = false
    } = options;
    
    await this.logger.info(`Importing cast from: ${zipPath}`);
    
    // 1. Validate ZIP exists
    try {
      await fs.access(zipPath);
    } catch {
      throw new Error(`ZIP file not found: ${zipPath}`);
    }
    
    // 2. Read and validate ZIP
    const zip = new AdmZip(zipPath);
    const zipEntries = zip.getEntries();
    
    // 3. Check for required files
    const hasCastJson = zipEntries.some(e => e.entryName === 'cast.json');
    if (!hasCastJson) {
      throw new Error('Invalid cast export: missing cast.json');
    }
    
    // 4. Read export metadata if present
    let exportMeta = null;
    const metaEntry = zipEntries.find(e => e.entryName === 'export-meta.json');
    if (metaEntry) {
      exportMeta = JSON.parse(metaEntry.getData().toString());
      await this.logger.info('Found export metadata', {
        version: exportMeta.version,
        exportedAt: exportMeta.exportedAt,
        originalCast: exportMeta.originalCast
      });
    }
    
    // 5. Read cast.json to get ID
    const castJsonEntry = zipEntries.find(e => e.entryName === 'cast.json');
    const castConfig = JSON.parse(castJsonEntry.getData().toString());
    
    const targetId = castId || castConfig.id;
    
    // 6. Check if cast already exists
    if (this.castManager.getCast(targetId)) {
      if (!overwrite) {
        throw new Error(`Cast "${targetId}" already exists. Use --overwrite to replace.`);
      }
      await this.logger.warn(`Overwriting existing cast: ${targetId}`);
    }
    
    // 7. Extract to casts directory
    const extractPath = path.join('casts', targetId);
    await fs.mkdir(extractPath, { recursive: true });
    
    zip.extractAllTo(extractPath, true);
    
    // 8. Update cast.json with new ID if renamed
    if (castId && castId !== castConfig.id) {
      castConfig.id = castId;
      castConfig.name = castId;
      castConfig.importedFrom = castConfig.id;
      castConfig.importedAt = new Date().toISOString();
      await fs.writeFile(
        path.join(extractPath, 'cast.json'),
        JSON.stringify(castConfig, null, 2)
      );
    }
    
    // 9. Reload casts
    await this.castManager.loadCasts();
    
    await this.logger.info('Import complete', {
      castId: targetId,
      path: extractPath
    });
    
    return {
      success: true,
      castId: targetId,
      path: extractPath,
      metadata: exportMeta
    };
  }
  
  /**
   * Validate a cast export without importing
   */
  async validateExport(zipPath) {
    await this.logger.info(`Validating export: ${zipPath}`);
    
    try {
      await fs.access(zipPath);
    } catch {
      return { valid: false, error: 'File not found' };
    }
    
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    
    const issues = [];
    
    // Check required files
    if (!entries.some(e => e.entryName === 'cast.json')) {
      issues.push('Missing cast.json');
    }
    
    if (!entries.some(e => e.entryName === 'profile.md')) {
      issues.push('Missing profile.md');
    }
    
    // Read metadata
    let metadata = null;
    const metaEntry = entries.find(e => e.entryName === 'export-meta.json');
    if (metaEntry) {
      try {
        metadata = JSON.parse(metaEntry.getData().toString());
      } catch {
        issues.push('Invalid export-meta.json');
      }
    }
    
    // Check cast.json validity
    const castEntry = entries.find(e => e.entryName === 'cast.json');
    if (castEntry) {
      try {
        const castConfig = JSON.parse(castEntry.getData().toString());
        if (!castConfig.id) issues.push('cast.json missing id');
        if (!castConfig.name) issues.push('cast.json missing name');
      } catch {
        issues.push('Invalid cast.json');
      }
    }
    
    return {
      valid: issues.length === 0,
      issues,
      metadata,
      fileCount: entries.length
    };
  }
  
  /**
   * List available exports
   */
  async listExports(exportDir = 'cast-exports') {
    try {
      const files = await fs.readdir(exportDir);
      const exports = [];
      
      for (const file of files) {
        if (!file.endsWith('.cast.zip')) continue;
        
        const filePath = path.join(exportDir, file);
        const stats = await fs.stat(filePath);
        
        // Try to read metadata
        let metadata = null;
        try {
          const zip = new AdmZip(filePath);
          const metaEntry = zip.getEntries().find(e => e.entryName === 'export-meta.json');
          if (metaEntry) {
            metadata = JSON.parse(metaEntry.getData().toString());
          }
        } catch {
          // Ignore metadata read errors
        }
        
        exports.push({
          filename: file,
          path: filePath,
          size: stats.size,
          created: stats.birthtime.toISOString(),
          metadata
        });
      }
      
      // Sort by creation date (newest first)
      exports.sort((a, b) => new Date(b.created) - new Date(a.created));
      
      return exports;
    } catch {
      return [];
    }
  }
  
  // ===== Private helpers =====
  
  async _addToZip(zip, basePath, relativePath) {
    const fullPath = path.join(basePath, relativePath);
    try {
      await fs.access(fullPath);
      zip.addLocalFile(fullPath, '', relativePath);
    } catch {
      // File doesn't exist, skip
    }
  }
  
  async _addDirectoryToZip(zip, basePath, dirName) {
    const dirPath = path.join(basePath, dirName);
    try {
      await fs.access(dirPath);
      zip.addLocalFolder(dirPath, dirName);
    } catch {
      // Directory doesn't exist, skip
    }
  }
  
  async _countFiles(dirPath) {
    try {
      const files = await fs.readdir(dirPath);
      return files.length;
    } catch {
      return 0;
    }
  }
  
  async _calculateChecksum(filePath) {
    const data = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
  }
}

module.exports = CastExporter;
