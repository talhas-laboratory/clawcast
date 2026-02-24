/**
 * CastFileManager - File system management for casts
 * 
 * Features:
 * - List files in cast directories
 * - Upload files
 * - Download files
 * - Delete files
 * - Organize files into folders
 * - Search files
 * - Get file metadata
 */

const fs = require('fs').promises;
const path = require('path');
const Logger = require('./Logger');

class CastFileManager {
  constructor(cast) {
    this.cast = cast;
    this.logger = new Logger('CastFileManager', cast.id);
    
    // Base directories that can be managed
    this.baseDirs = {
      docs: path.join(cast.path, 'docs'),
      documents: path.join(cast.path, 'documents'),
      context: path.join(cast.path, 'context'),
      memory: path.join(cast.path, 'memory'),
      system: path.join(cast.path, 'system'),
      uploads: path.join(cast.path, 'uploads')
    };
  }

  /**
   * Initialize file manager - ensure base directories exist
   */
  async initialize() {
    await this.logger.info('Initializing file manager');
    
    for (const [name, dirPath] of Object.entries(this.baseDirs)) {
      try {
        await fs.mkdir(dirPath, { recursive: true });
        await this.logger.debug(`Ensured directory: ${name}`);
      } catch (error) {
        await this.logger.error(`Failed to create directory ${name}:`, error);
      }
    }
  }

  /**
   * List files in a directory
   */
  async listFiles(directory = 'documents', options = {}) {
    const dirPath = this.resolvePath(directory);
    if (!dirPath) {
      throw new Error(`Invalid directory: ${directory}`);
    }

    await this.logger.debug(`Listing files in ${directory}`);
    
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const files = [];
      const folders = [];

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const stats = await fs.stat(fullPath);
        
        const item = {
          name: entry.name,
          path: this.getRelativePath(fullPath),
          size: stats.size,
          modified: stats.mtime.toISOString(),
          created: stats.birthtime.toISOString()
        };

        if (entry.isDirectory()) {
          // Count items in folder
          const subEntries = await fs.readdir(fullPath);
          item.itemCount = subEntries.length;
          item.type = 'folder';
          folders.push(item);
        } else {
          item.type = 'file';
          item.extension = path.extname(entry.name).toLowerCase();
          files.push(item);
        }
      }

      // Sort: folders first, then files, both alphabetically
      folders.sort((a, b) => a.name.localeCompare(b.name));
      files.sort((a, b) => a.name.localeCompare(b.name));

      return {
        success: true,
        directory,
        path: dirPath,
        items: [...folders, ...files],
        totalFiles: files.length,
        totalFolders: folders.length,
        totalSize: files.reduce((sum, f) => sum + f.size, 0)
      };
    } catch (error) {
      await this.logger.error(`Failed to list files in ${directory}:`, error);
      throw error;
    }
  }

  /**
   * Get file content
   */
  async getFile(filePath) {
    const fullPath = this.resolvePath(filePath);
    if (!fullPath) {
      throw new Error('Invalid file path');
    }

    await this.logger.debug(`Reading file: ${filePath}`);
    
    try {
      const stats = await fs.stat(fullPath);
      
      if (stats.isDirectory()) {
        throw new Error('Path is a directory, not a file');
      }

      // Check file size (limit to 10MB for text files)
      if (stats.size > 10 * 1024 * 1024) {
        throw new Error('File too large (max 10MB)');
      }

      const extension = path.extname(filePath).toLowerCase();
      const isText = this.isTextFile(extension);
      
      if (isText) {
        const content = await fs.readFile(fullPath, 'utf8');
        return {
          success: true,
          name: path.basename(filePath),
          path: filePath,
          content,
          size: stats.size,
          type: 'text',
          extension
        };
      } else {
        // For binary files, return metadata only
        return {
          success: true,
          name: path.basename(filePath),
          path: filePath,
          size: stats.size,
          type: 'binary',
          extension,
          downloadUrl: `/api/cast-manager/download?castId=${this.cast.id}&path=${encodeURIComponent(filePath)}`
        };
      }
    } catch (error) {
      await this.logger.error(`Failed to read file ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * Save/upload file
   */
  async saveFile(filePath, content, options = {}) {
    const fullPath = this.resolvePath(filePath);
    if (!fullPath) {
      throw new Error('Invalid file path');
    }

    await this.logger.info(`Saving file: ${filePath}`);
    
    try {
      // Ensure parent directory exists
      const parentDir = path.dirname(fullPath);
      await fs.mkdir(parentDir, { recursive: true });

      // Write file
      if (options.buffer) {
        await fs.writeFile(fullPath, content);
      } else {
        await fs.writeFile(fullPath, content, 'utf8');
      }

      const stats = await fs.stat(fullPath);
      
      await this.logger.info(`File saved: ${filePath}`, {
        size: stats.size
      });

      return {
        success: true,
        name: path.basename(filePath),
        path: filePath,
        size: stats.size,
        modified: stats.mtime.toISOString()
      };
    } catch (error) {
      await this.logger.error(`Failed to save file ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * Upload file from buffer (for HTTP uploads)
   */
  async uploadFile(directory, filename, buffer, options = {}) {
    const dirPath = this.resolvePath(directory);
    if (!dirPath) {
      throw new Error(`Invalid directory: ${directory}`);
    }

    // Sanitize filename
    const safeFilename = this.sanitizeFilename(filename);
    const filePath = path.join(directory, safeFilename);
    const fullPath = path.join(dirPath, safeFilename);

    await this.logger.info(`Uploading file: ${filePath}`);

    try {
      await fs.writeFile(fullPath, buffer);
      
      const stats = await fs.stat(fullPath);
      
      // Index in context if it's a text file
      if (options.index !== false && this.isTextFile(path.extname(safeFilename))) {
        const ContextIndexer = require('./ContextIndexer');
        const indexer = new ContextIndexer(this.cast);
        await indexer.initialize();
        await indexer.indexDocument(fullPath);
      }

      return {
        success: true,
        name: safeFilename,
        path: filePath,
        size: stats.size,
        type: path.extname(safeFilename).toLowerCase()
      };
    } catch (error) {
      await this.logger.error(`Failed to upload file ${filename}:`, error);
      throw error;
    }
  }

  /**
   * Delete file or folder
   */
  async deleteFile(filePath, options = {}) {
    const fullPath = this.resolvePath(filePath);
    if (!fullPath) {
      throw new Error('Invalid file path');
    }

    await this.logger.info(`Deleting: ${filePath}`);
    
    try {
      const stats = await fs.stat(fullPath);
      
      if (stats.isDirectory()) {
        if (options.recursive) {
          await fs.rm(fullPath, { recursive: true });
        } else {
          // Check if empty
          const entries = await fs.readdir(fullPath);
          if (entries.length > 0) {
            throw new Error('Directory not empty (use recursive: true)');
          }
          await fs.rmdir(fullPath);
        }
      } else {
        await fs.unlink(fullPath);
      }

      await this.logger.info(`Deleted: ${filePath}`);

      return {
        success: true,
        path: filePath
      };
    } catch (error) {
      await this.logger.error(`Failed to delete ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * Create folder
   */
  async createFolder(folderPath) {
    const fullPath = this.resolvePath(folderPath);
    if (!fullPath) {
      throw new Error('Invalid folder path');
    }

    await this.logger.info(`Creating folder: ${folderPath}`);
    
    try {
      await fs.mkdir(fullPath, { recursive: true });
      
      return {
        success: true,
        path: folderPath,
        name: path.basename(folderPath)
      };
    } catch (error) {
      await this.logger.error(`Failed to create folder ${folderPath}:`, error);
      throw error;
    }
  }

  /**
   * Move/rename file or folder
   */
  async move(sourcePath, destPath) {
    const sourceFull = this.resolvePath(sourcePath);
    const destFull = this.resolvePath(destPath);
    
    if (!sourceFull || !destFull) {
      throw new Error('Invalid source or destination path');
    }

    await this.logger.info(`Moving ${sourcePath} to ${destPath}`);
    
    try {
      await fs.rename(sourceFull, destFull);
      
      return {
        success: true,
        source: sourcePath,
        destination: destPath
      };
    } catch (error) {
      await this.logger.error(`Failed to move ${sourcePath}:`, error);
      throw error;
    }
  }

  /**
   * Search files
   */
  async searchFiles(query, options = {}) {
    const directory = options.directory || 'documents';
    const dirPath = this.resolvePath(directory);
    
    await this.logger.info(`Searching for "${query}" in ${directory}`);
    
    const results = [];
    
    async function searchDir(currentPath, relativePath) {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        const relPath = path.join(relativePath, entry.name);
        
        if (entry.isDirectory()) {
          if (options.recursive !== false) {
            await searchDir(fullPath, relPath);
          }
        } else {
          // Check if filename matches
          if (entry.name.toLowerCase().includes(query.toLowerCase())) {
            const stats = await fs.stat(fullPath);
            results.push({
              name: entry.name,
              path: relPath,
              size: stats.size,
              modified: stats.mtime.toISOString()
            });
          }
          
          // Optionally search content (for text files)
          if (options.searchContent && this.isTextFile(path.extname(entry.name))) {
            try {
              const content = await fs.readFile(fullPath, 'utf8');
              if (content.toLowerCase().includes(query.toLowerCase())) {
                // Add if not already added
                if (!results.find(r => r.path === relPath)) {
                  const stats = await fs.stat(fullPath);
                  results.push({
                    name: entry.name,
                    path: relPath,
                    size: stats.size,
                    modified: stats.mtime.toISOString(),
                    matchesContent: true
                  });
                }
              }
            } catch (e) {
              // Ignore read errors
            }
          }
        }
      }
    }
    
    await searchDir(dirPath, '');
    
    return {
      success: true,
      query,
      results,
      totalResults: results.length
    };
  }

  /**
   * Get file tree structure
   */
  async getFileTree(directory = 'documents') {
    const dirPath = this.resolvePath(directory);
    if (!dirPath) {
      throw new Error(`Invalid directory: ${directory}`);
    }

    async function buildTree(currentPath) {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });
      const items = [];

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        
        if (entry.isDirectory()) {
          items.push({
            name: entry.name,
            type: 'folder',
            children: await buildTree(fullPath)
          });
        } else {
          const stats = await fs.stat(fullPath);
          items.push({
            name: entry.name,
            type: 'file',
            size: stats.size,
            extension: path.extname(entry.name).toLowerCase()
          });
        }
      }

      return items;
    }

    const tree = await buildTree(dirPath);

    return {
      success: true,
      directory,
      tree
    };
  }

  // Helper methods

  resolvePath(inputPath) {
    // Check if it's a base directory name
    if (this.baseDirs[inputPath]) {
      return this.baseDirs[inputPath];
    }

    // Check if it starts with a base directory
    for (const [name, dirPath] of Object.entries(this.baseDirs)) {
      if (inputPath.startsWith(name + '/') || inputPath === name) {
        const relativePath = inputPath.slice(name.length).replace(/^\//, '');
        return path.join(dirPath, relativePath);
      }
    }

    // Check if it's an absolute path within the cast
    const fullPath = path.join(this.cast.path, inputPath);
    if (fullPath.startsWith(this.cast.path)) {
      return fullPath;
    }

    return null;
  }

  getRelativePath(fullPath) {
    for (const [name, dirPath] of Object.entries(this.baseDirs)) {
      if (fullPath.startsWith(dirPath)) {
        const relative = fullPath.slice(dirPath.length).replace(/^\//, '');
        return relative ? `${name}/${relative}` : name;
      }
    }
    return path.relative(this.cast.path, fullPath);
  }

  isTextFile(extension) {
    const textExtensions = [
      '.txt', '.md', '.json', '.js', '.ts', '.html', '.css',
      '.yaml', '.yml', '.xml', '.csv', '.log', '.py', '.rb',
      '.java', '.c', '.cpp', '.h', '.go', '.rs', '.php',
      '.sh', '.bash', '.zsh', '.sql', '.graphql'
    ];
    return textExtensions.includes(extension.toLowerCase());
  }

  sanitizeFilename(filename) {
    // Remove dangerous characters
    return filename
      .replace(/[<>:"|?*]/g, '')
      .replace(/\.\./g, '')
      .trim();
  }
}

module.exports = CastFileManager;
