const fs = require('fs').promises;
const path = require('path');

const SUPPORTED_KNOWLEDGE_EXTENSIONS = new Set(['.md', '.txt', '.json', '.pdf']);

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function atomicWriteJson(filePath, value) {
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmpPath, filePath);
}

class CastCatalog {
  constructor(options = {}) {
    this.castsPath = path.resolve(options.castsPath || path.join(process.cwd(), 'casts'));
    this.logger = options.logger || console;
  }

  castPath(castOrId) {
    if (castOrId && typeof castOrId === 'object' && castOrId.path) {
      return castOrId.path;
    }
    return path.join(this.castsPath, String(castOrId || ''));
  }

  castConfigPath(castOrId) {
    return path.join(this.castPath(castOrId), 'cast.json');
  }

  contextPath(castOrId) {
    if (castOrId && typeof castOrId === 'object' && castOrId.contextPath) {
      return castOrId.contextPath;
    }
    return path.join(this.castPath(castOrId), 'context');
  }

  docsPath(castOrId) {
    if (castOrId && typeof castOrId === 'object' && castOrId.docsPath) {
      return castOrId.docsPath;
    }
    return path.join(this.castPath(castOrId), 'docs');
  }

  indexPath(castOrId) {
    if (castOrId && typeof castOrId === 'object' && castOrId.indexPath) {
      return path.join(castOrId.indexPath, 'inverted.json');
    }
    return path.join(this.castPath(castOrId), 'index', 'inverted.json');
  }

  async summarizeCast(cast) {
    const castId = cast && cast.id ? cast.id : null;
    if (!castId) {
      throw new Error('cast is required');
    }

    const [knowledgeCount, indexMeta] = await Promise.all([
      this.countKnowledgeDocuments(cast),
      this.readIndexMeta(cast),
    ]);

    return {
      castId,
      contextCount: knowledgeCount,
      docsCount: knowledgeCount,
      indexedCount: indexMeta.indexedCount,
      lastIndexedAt: indexMeta.lastIndexedAt,
      staleContextIndex: knowledgeCount !== indexMeta.indexedCount,
    };
  }

  async reconcileCast(castOrId) {
    const castId = castOrId && typeof castOrId === 'object' ? castOrId.id : castOrId;
    const configPath = this.castConfigPath(castOrId);
    const docsCount = await this.countKnowledgeDocuments(castOrId);
    const indexMeta = await this.readIndexMeta(castOrId);

    let cfg = {};
    try {
      cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
    } catch (error) {
      throw new Error(`Failed to read cast.json for ${castId}: ${error.message}`);
    }

    cfg.context = cfg.context || {};
    cfg.context.totalDocuments = docsCount;
    cfg.context.indexedDocuments = indexMeta.indexedCount;
    cfg.context.lastIndexedAt = indexMeta.lastIndexedAt;
    cfg.context.staleContextIndex = docsCount !== indexMeta.indexedCount;
    cfg.context.lastReconciledAt = new Date().toISOString();

    cfg.docs = cfg.docs || {};
    cfg.docs.totalDocuments = docsCount;
    cfg.docs.indexedDocuments = indexMeta.indexedCount;
    cfg.docs.lastIndexedAt = indexMeta.lastIndexedAt;
    cfg.docs.staleDocsIndex = docsCount !== indexMeta.indexedCount;
    cfg.docs.lastReconciledAt = cfg.context.lastReconciledAt;

    await atomicWriteJson(configPath, cfg);

    return {
      castId,
      contextCount: docsCount,
      docsCount,
      indexedCount: indexMeta.indexedCount,
      staleContextIndex: cfg.context.staleContextIndex,
      lastIndexedAt: indexMeta.lastIndexedAt,
      lastReconciledAt: cfg.context.lastReconciledAt,
    };
  }

  async reconcileAll(castManager) {
    const casts = castManager ? castManager.listCasts() : [];
    const output = [];
    for (const cast of casts) {
      const castObj = castManager.getCast(cast.id);
      try {
        const snapshot = await this.reconcileCast(castObj || cast.id);
        output.push(snapshot);
      } catch (error) {
        this.logger.warn(`[CastCatalog] reconcile failed for ${cast.id}: ${error.message}`);
      }
    }
    return output;
  }

  async readIndexMeta(castOrId) {
    const castId = castOrId && typeof castOrId === 'object' ? castOrId.id : castOrId;
    const idxPath = this.indexPath(castOrId);
    if (!(await exists(idxPath))) {
      return { indexedCount: 0, lastIndexedAt: null };
    }

    try {
      const raw = JSON.parse(await fs.readFile(idxPath, 'utf8'));
      let indexedCount = 0;
      if (Array.isArray(raw.documents)) {
        indexedCount = raw.documents.length;
      } else if (raw.stats && Number.isFinite(raw.stats.totalDocuments)) {
        indexedCount = Number(raw.stats.totalDocuments);
      }
      return {
        indexedCount,
        lastIndexedAt: raw.updated || raw.created || null,
      };
    } catch (error) {
      this.logger.warn(`[CastCatalog] Failed reading index for ${castId}: ${error.message}`);
      return { indexedCount: 0, lastIndexedAt: null };
    }
  }

  async countKnowledgeDocuments(castOrId) {
    const roots = this.knowledgeRoots(castOrId);
    let total = 0;
    for (const root of roots) {
      if (!(await exists(root))) continue;
      total += await this.walkAndCount(root);
    }
    return total;
  }

  async walkAndCount(rootDir) {
    let count = 0;
    const stack = [rootDir];

    while (stack.length > 0) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry.name.startsWith('.')) {
          continue;
        }
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_KNOWLEDGE_EXTENSIONS.has(ext)) {
          count += 1;
        }
      }
    }

    return count;
  }

  knowledgeRoots(castOrId) {
    const roots = [this.docsPath(castOrId), this.contextPath(castOrId)];
    const seen = new Set();
    return roots
      .map((root) => path.resolve(root))
      .filter((root) => {
        if (seen.has(root)) return false;
        seen.add(root);
        return true;
      });
  }
}

module.exports = CastCatalog;
