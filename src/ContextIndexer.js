/**
 * ContextIndexer - Document indexing and search system
 * 
 * Features:
 * - Extract text from PDF, Markdown, TXT, JSON
 * - Build inverted index for fast keyword search
 * - Query documents with relevance scoring
 * - Persist index to disk
 * 
 * Architecture Decision: Inverted index (not vector)
 * - No external dependencies (no ML models)
 * - Fast keyword search
 * - Small index size
 * - Good enough for most use cases
 */

const fs = require('fs').promises;
const path = require('path');
const Logger = require('./Logger');

const QUERY_SYNONYMS = {
  auth: ['authentication', 'authorize', 'authorization', 'login', 'token', 'jwt'],
  bug: ['issue', 'error', 'fault', 'defect', 'failure'],
  deploy: ['deployment', 'release', 'rollout', 'ship'],
  perf: ['performance', 'latency', 'throughput', 'slow'],
  config: ['configuration', 'setting', 'settings', 'option'],
  plugin: ['extension', 'addon', 'module'],
};

const ACRONYM_MAP = {
  ux: ['user', 'experience'],
  ui: ['user', 'interface'],
  api: ['application', 'programming', 'interface'],
  sdk: ['software', 'development', 'kit'],
  db: ['database'],
  qa: ['quality', 'assurance'],
  kpi: ['key', 'performance', 'indicator'],
  rfp: ['request', 'proposal'],
  mvp: ['minimum', 'viable', 'product'],
};

class ContextIndexer {
  constructor(cast) {
    this.cast = cast;
    this.logger = new Logger('ContextIndexer', cast.id);
    
    // In-memory index
    this.documents = new Map();        // docId -> Document
    this.invertedIndex = new Map();    // term -> Set(docIds)
    this.stats = {
      totalDocuments: 0,
      totalTerms: 0,
      indexSize: 0
    };

    this.fieldWeights = {
      title: 3.2,
      path: 2.3,
      headings: 2.8,
      body: 1.0
    };
    
    // Supported formats
    this.supportedFormats = ['.pdf', '.md', '.txt', '.json'];
  }
  
  /**
   * Initialize or load existing index
   */
  async initialize() {
    await this.logger.info('Initializing context indexer');
    
    const indexPath = path.join(this.cast.indexPath, 'inverted.json');
    
    try {
      // Try to load existing index
      await this.loadIndex();
      await this.logger.info('Loaded existing index', {
        documents: this.stats.totalDocuments,
        terms: this.stats.totalTerms
      });
    } catch {
      // No existing index, create new
      await this.logger.info('No existing index, creating new');
      await this.buildIndex();
    }
  }
  
  /**
   * Build index from all documents in context directory
   */
  async buildIndex() {
    await this.logger.info('Building full index');
    const startTime = Date.now();
    
    // Clear existing index
    this.documents.clear();
    this.invertedIndex.clear();
    
    // Find all supported files
    const files = await this._findDocuments();
    await this.logger.info(`Found ${files.length} documents to index`);
    
    let success = 0;
    let failed = 0;
    
    for (const filePath of files) {
      try {
        await this.indexDocument(filePath);
        success++;
      } catch (error) {
        await this.logger.error(`Failed to index ${filePath}`, {
          error: error.message
        });
        failed++;
      }
    }
    
    // Update stats
    this.stats.totalDocuments = this.documents.size;
    this.stats.totalTerms = this.invertedIndex.size;
    
    // Save index
    await this.saveIndex();
    
    const duration = Date.now() - startTime;
    await this.logger.info(`Index build complete`, {
      success,
      failed,
      duration: `${duration}ms`,
      totalDocs: this.stats.totalDocuments,
      totalTerms: this.stats.totalTerms
    });
    
    return {
      total: files.length,
      success,
      failed,
      duration,
      documents: this.stats.totalDocuments,
      terms: this.stats.totalTerms
    };
  }
  
  /**
   * Index a single document
   */
  async indexDocument(filePath) {
    const docId = this._docIdFromPath(filePath);
    const ext = path.extname(filePath).toLowerCase();
    
    await this.logger.debug(`Indexing: ${docId}`);
    
    // Check if already indexed
    if (this.documents.has(docId)) {
      await this.logger.debug(`Document ${docId} already indexed, returning existing`);
      return this.documents.get(docId);
    }
    
    // Extract text based on format
    let content;
    let metadata = {};
    
    try {
      switch (ext) {
        case '.pdf':
          content = await this._extractPDF(filePath);
          metadata.format = 'pdf';
          break;
        case '.md':
          content = await this._extractMarkdown(filePath);
          metadata.format = 'markdown';
          break;
        case '.txt':
          content = await this._extractText(filePath);
          metadata.format = 'text';
          break;
        case '.json':
          content = await this._extractJSON(filePath);
          metadata.format = 'json';
          break;
        default:
          throw new Error(`Unsupported format: ${ext}`);
      }
    } catch (error) {
      throw new Error(`Extraction failed: ${error.message}`);
    }
    
    if (!content || content.trim().length === 0) {
      throw new Error('No content extracted');
    }
    
    // Create document record
    const stats = await fs.stat(filePath);
    const document = {
      id: docId,
      path: filePath,
      format: metadata.format,
      size: stats.size,
      indexed: new Date().toISOString(),
      contentLength: content.length,
      preview: content.slice(0, 200) + (content.length > 200 ? '...' : '')
    };
    
    // Tokenize and index
    const tokens = this._tokenize(content);
    const chunks = this._chunk(content, 1000); // 1000 char chunks for excerpts
    
    document.chunks = chunks;
    document.tokenCount = tokens.length;
    document.lexical = this._buildDocumentLexicalMetadata(document, content);
    
    // Add to documents
    this.documents.set(docId, document);
    
    // Update inverted index
    const uniqueTokens = new Set(tokens);
    for (const token of uniqueTokens) {
      if (!this.invertedIndex.has(token)) {
        this.invertedIndex.set(token, new Set());
      }
      this.invertedIndex.get(token).add(docId);
    }
    
    await this.logger.debug(`Indexed ${docId}`, {
      tokens: tokens.length,
      uniqueTerms: uniqueTokens.size,
      chunks: chunks.length
    });
    
    return document;
  }
  
  /**
   * Search indexed documents
   */
  async search(query, options = {}) {
    const { 
      limit = 5, 
      includeExcerpt = true,
      minScore = 0.1,
      maxCandidates = 50,
      rerankMode = 'off'
    } = options;
    
    await this.logger.debug(`Search query: "${query}"`);
    const startTime = Date.now();
    
    if (!query || query.trim().length === 0) {
      return { results: [], total: 0, queryTime: 0 };
    }
    
    const queryTokens = this._tokenize(query);
    if (queryTokens.length === 0) {
      return { results: [], total: 0, queryTime: 0 };
    }

    const variants = this._buildQueryVariants(query, queryTokens);
    const fieldStats = this._computeFieldStats();
    const perVariantRankings = [];
    const expandedTokenSet = new Set();

    for (const variant of variants) {
      const expandedTerms = this._expandQueryTokens(variant.tokens);
      expandedTerms.forEach((term) => expandedTokenSet.add(term.token));
      const candidateDocs = this._collectCandidates(expandedTerms, maxCandidates);
      const scoredItems = [];

      for (const [docId, candidateMeta] of candidateDocs) {
        const document = this.documents.get(docId);
        if (!document) continue;
        this._ensureDocumentLexicalMetadata(document);

        const scored = this._scoreDocument(
          document,
          candidateMeta,
          variant.tokens,
          expandedTerms,
          variant.query,
          fieldStats
        );
        if (scored.totalScore < minScore) continue;

        const excerptData = includeExcerpt
          ? this._findBestExcerptData(document, variant.tokens, expandedTerms, variant.query)
          : null;

        scoredItems.push({
          document: {
            id: document.id,
            format: document.format,
            size: document.size,
            preview: document.preview
          },
          score: scored.totalScore,
          excerpt: excerptData ? excerptData.excerpt : null,
          matches: candidateMeta.hits,
          scoreBreakdown: scored.breakdown,
          matchedQueryTokens: scored.matchedQueryTokens || [],
          citation: excerptData
            ? {
                docId: document.id,
                chunkId: excerptData.chunkId,
                start: excerptData.start
              }
            : {
                docId: document.id,
                chunkId: null,
                start: 0
              }
        });
      }

      scoredItems.sort((a, b) => b.score - a.score);
      perVariantRankings.push({
        key: variant.key,
        weight: variant.weight,
        results: scoredItems
      });
    }

    const fused = this._fuseWithRrf(perVariantRankings, maxCandidates);

    const reranked = rerankMode === 'agent'
      ? this._rerankLexicalPlus(fused, queryTokens)
      : fused;

    const limited = reranked.slice(0, limit);
    
    const duration = Date.now() - startTime;
    await this.logger.debug(`Search complete`, {
      candidates: fused.length,
      results: limited.length,
      duration: `${duration}ms`
    });
    
    return {
      results: limited,
      total: reranked.length,
      queryTime: duration,
      query: query,
      tokens: queryTokens,
      expandedTokens: Array.from(expandedTokenSet),
      queryVariants: variants.map((variant) => variant.query),
      rerankMode: rerankMode === 'agent' ? 'agent-lexical-plus' : 'lexical-plus'
    };
  }
  
  /**
   * Get document by ID
   */
  getDocument(docId) {
    return this.documents.get(docId);
  }
  
  /**
   * List all indexed documents
   */
  listDocuments() {
    return Array.from(this.documents.values()).map(doc => ({
      id: doc.id,
      format: doc.format,
      size: doc.size,
      indexed: doc.indexed,
      tokenCount: doc.tokenCount
    }));
  }
  
  /**
   * Save index to disk
   */
  async saveIndex() {
    const indexPath = path.join(this.cast.indexPath, 'inverted.json');
    
    // Convert Sets to Arrays for JSON serialization
    const serializableIndex = {};
    for (const [term, docIds] of this.invertedIndex) {
      serializableIndex[term] = Array.from(docIds);
    }
    
    const data = {
      version: '1.0.0',
      castId: this.cast.id,
      updated: new Date().toISOString(),
      stats: this.stats,
      documents: Array.from(this.documents.entries()),
      index: serializableIndex
    };
    
    await fs.writeFile(indexPath, JSON.stringify(data, null, 2));
    await this.logger.debug('Index saved to disk');
  }
  
  /**
   * Load index from disk
   */
  async loadIndex() {
    const indexPath = path.join(this.cast.indexPath, 'inverted.json');
    
    const data = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    
    // Validate version
    if (data.version !== '1.0.0') {
      throw new Error(`Unsupported index version: ${data.version}`);
    }
    
    // Load documents
    this.documents = new Map(data.documents);
    
    // Load inverted index (convert Arrays back to Sets)
    this.invertedIndex = new Map();
    for (const [term, docIds] of Object.entries(data.index)) {
      this.invertedIndex.set(term, new Set(docIds));
    }
    
    // Load stats
    this.stats = data.stats;
    
    await this.logger.debug('Index loaded from disk', {
      documents: this.stats.totalDocuments,
      terms: this.stats.totalTerms
    });
  }
  
  /**
   * Remove document from index
   */
  async removeDocument(docId) {
    const resolvedDocId = this._resolveDocId(docId);
    const document = resolvedDocId ? this.documents.get(resolvedDocId) : null;
    if (!document) {
      return false;
    }
    
    // Remove from inverted index
    for (const [term, docIds] of this.invertedIndex) {
      docIds.delete(resolvedDocId);
      if (docIds.size === 0) {
        this.invertedIndex.delete(term);
      }
    }
    
    // Remove from documents
    this.documents.delete(resolvedDocId);
    
    // Update stats
    this.stats.totalDocuments = this.documents.size;
    this.stats.totalTerms = this.invertedIndex.size;
    
    // Save
    await this.saveIndex();
    
    await this.logger.info(`Removed document: ${resolvedDocId}`);
    
    return true;
  }
  
  // ===== Private helpers =====
  
  async _findDocuments() {
    const files = [];
    const roots = this._knowledgeRoots();
    for (const root of roots) {
      try {
        const entries = await fs.readdir(root, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const ext = path.extname(entry.name).toLowerCase();
          if (this.supportedFormats.includes(ext)) {
            files.push(path.join(root, entry.name));
          }
        }
      } catch (error) {
        await this.logger.warn(`Could not read knowledge directory ${root}`, {
          error: error.message
        });
      }
    }
    
    return files;
  }
  
  async _extractPDF(filePath) {
    // Lightweight fallback: keep plugin dependency-free.
    // If binary decode yields no useful text, return a stable placeholder.
    await this.logger.warn('PDF semantic parsing not enabled, using lightweight fallback');
    const raw = await fs.readFile(filePath);
    const asText = raw.toString('utf8');
    const cleaned = asText.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned.length >= 64) {
      return cleaned;
    }
    return `[PDF content available but text extraction is limited for ${path.basename(filePath)}]`;
  }
  
  async _extractMarkdown(filePath) {
    const content = await fs.readFile(filePath, 'utf8');
    // Simple markdown stripping (remove headers, bold, etc.)
    return content
      .replace(/#+ /g, '')  // Headers
      .replace(/\*\*/g, '')  // Bold
      .replace(/\*/g, '')    // Italic
      .replace(/`{3}[\s\S]*?`{3}/g, '')  // Code blocks
      .replace(/`/g, '')     // Inline code
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');  // Links -> text
  }
  
  async _extractText(filePath) {
    return await fs.readFile(filePath, 'utf8');
  }
  
  async _extractJSON(filePath) {
    const content = await fs.readFile(filePath, 'utf8');
    try {
      const obj = JSON.parse(content);
      return this._flattenObject(obj);
    } catch {
      return content; // Invalid JSON, return raw
    }
  }
  
  _flattenObject(obj, prefix = '') {
    let result = '';
    
    for (const [key, value] of Object.entries(obj)) {
      const newKey = prefix ? `${prefix}.${key}` : key;
      
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result += this._flattenObject(value, newKey);
      } else if (Array.isArray(value)) {
        result += `${newKey}: ${value.join(', ')}\n`;
      } else {
        result += `${newKey}: ${value}\n`;
      }
    }
    
    return result;
  }
  
  _tokenize(text) {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(token => token.length > 2)  // Filter short tokens
      .filter(token => !this._isStopWord(token));  // Filter stop words
  }
  
  _isStopWord(token) {
    const stopWords = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
      'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his',
      'how', 'its', 'may', 'new', 'now', 'old', 'see', 'two', 'who', 'boy',
      'did', 'use', 'her', 'way', 'many', 'oil', 'sit', 'set', 'run', 'eat',
      'far', 'sea', 'eye', 'ago', 'off', 'too', 'any', 'say', 'man', 'try',
      'ask', 'end', 'why', 'let', 'put', 'say', 'she', 'try', 'way', 'own',
      'say', 'too', 'old', 'tell', 'very', 'when', 'much', 'would', 'there',
      'their', 'what', 'said', 'each', 'which', 'will', 'about', 'could',
      'other', 'after', 'first', 'never', 'these', 'think', 'where', 'being',
      'every', 'great', 'might', 'shall', 'still', 'those', 'while', 'this',
      'that', 'with', 'from', 'they', 'have', 'were', 'been', 'have', 'than'
    ]);
    return stopWords.has(token);
  }
  
  _chunk(text, size) {
    const chunks = [];
    for (let i = 0; i < text.length; i += size) {
      chunks.push({
        id: Math.floor(i / size),
        text: text.slice(i, i + size),
        start: i
      });
    }
    return chunks;
  }
  
  _findBestExcerpt(document, queryTokens) {
    if (!document.chunks || document.chunks.length === 0) {
      return document.preview;
    }
    
    // Score each chunk by query token matches
    let bestChunk = null;
    let bestScore = 0;
    
    for (const chunk of document.chunks) {
      const chunkTokens = this._tokenize(chunk.text);
      const matches = chunkTokens.filter(t => queryTokens.includes(t)).length;
      const score = matches / chunkTokens.length;
      
      if (score > bestScore) {
        bestScore = score;
        bestChunk = chunk;
      }
    }
    
    if (bestChunk) {
      // Clean up excerpt
      let excerpt = bestChunk.text.slice(0, 300);
      if (bestChunk.text.length > 300) {
        excerpt += '...';
      }
      return excerpt;
    }
    
    return document.preview;
  }

  _buildDocumentLexicalMetadata(document, rawContent) {
    const titleSource = path.basename(document.id || document.path || '');
    const pathSource = String(document.id || document.path || '');
    const headingsSource = this._extractHeadings(rawContent, document.format);

    const titleTokens = this._tokenize(titleSource);
    const pathTokens = this._tokenize(pathSource.replace(/[/._-]+/g, ' '));
    const headingTokens = this._tokenize(headingsSource.join(' '));
    const bodyTokens = this._tokenize(rawContent);

    return {
      title: titleSource,
      headings: headingsSource,
      tfByField: {
        title: this._countTokens(titleTokens),
        path: this._countTokens(pathTokens),
        headings: this._countTokens(headingTokens),
        body: this._countTokens(bodyTokens)
      },
      fieldLengths: {
        title: titleTokens.length,
        path: pathTokens.length,
        headings: headingTokens.length,
        body: bodyTokens.length
      }
    };
  }

  _ensureDocumentLexicalMetadata(document) {
    if (document && document.lexical && document.lexical.tfByField && document.lexical.fieldLengths) {
      return;
    }
    const content = Array.isArray(document.chunks)
      ? document.chunks.map((chunk) => chunk.text || '').join('\n')
      : String(document.preview || '');
    document.lexical = this._buildDocumentLexicalMetadata(document, content);
  }

  _extractHeadings(content, format) {
    const text = String(content || '');
    if (format === 'markdown') {
      const matches = text.match(/^#{1,6}\s+.+$/gm) || [];
      return matches.map((line) => line.replace(/^#{1,6}\s+/, '').trim()).filter(Boolean).slice(0, 32);
    }
    const genericLines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 4 && line.length < 96)
      .filter((line) => /^[A-Z0-9 _-]+$/.test(line) || /^[A-Z][^.!?]+$/.test(line));
    return genericLines.slice(0, 16);
  }

  _countTokens(tokens) {
    const counts = {};
    for (const token of Array.isArray(tokens) ? tokens : []) {
      counts[token] = (counts[token] || 0) + 1;
    }
    return counts;
  }

  _computeFieldStats() {
    const fields = Object.keys(this.fieldWeights);
    const totals = {};
    for (const field of fields) totals[field] = 0;
    const docs = Array.from(this.documents.values());
    const totalDocs = Math.max(1, docs.length);

    for (const doc of docs) {
      this._ensureDocumentLexicalMetadata(doc);
      for (const field of fields) {
        totals[field] += Math.max(1, Number(doc.lexical.fieldLengths[field] || 0));
      }
    }

    const avgLengths = {};
    for (const field of fields) {
      avgLengths[field] = totals[field] / totalDocs;
    }
    return { avgLengths };
  }

  _stemToken(token) {
    const t = String(token || '').toLowerCase();
    if (t.length <= 4) return t;
    return t
      .replace(/(ments|ment|ingly|edly|edly|ingly|ation|ations|izer|izes|ized|izing|ers|er|ies|ied|ing|ed|es|s)$/, '')
      .replace(/(.)\1{2,}/g, '$1$1');
  }

  _findApproximateTerms(token, limit = 2) {
    const t = String(token || '').toLowerCase();
    if (t.length < 4 || this.invertedIndex.has(t)) {
      return [];
    }
    const target = this._trigrams(t);
    if (target.size === 0) {
      return [];
    }
    const scored = [];
    for (const term of this.invertedIndex.keys()) {
      if (Math.abs(term.length - t.length) > 3) continue;
      const grams = this._trigrams(term);
      const intersection = this._setIntersectionSize(target, grams);
      if (intersection === 0) continue;
      const union = target.size + grams.size - intersection;
      const sim = union > 0 ? intersection / union : 0;
      if (sim >= 0.34) {
        scored.push({ term, sim });
      }
    }
    return scored
      .sort((a, b) => b.sim - a.sim)
      .slice(0, limit)
      .map((item) => item.term);
  }

  _trigrams(token) {
    const padded = `  ${String(token || '')}  `;
    const grams = new Set();
    for (let i = 0; i < padded.length - 2; i += 1) {
      grams.add(padded.slice(i, i + 3));
    }
    return grams;
  }

  _setIntersectionSize(a, b) {
    let n = 0;
    for (const x of a) {
      if (b.has(x)) n += 1;
    }
    return n;
  }

  _buildQueryVariants(rawQuery, baseTokens) {
    const variants = [];
    const addVariant = (query, tokens, weight, source) => {
      const normalizedTokens = this._normalizeQueryTokenSet(tokens);
      if (!normalizedTokens.length) return;
      variants.push({
        key: `${source}:${normalizedTokens.join('|')}`,
        source,
        weight,
        query: String(query || '').trim() || normalizedTokens.join(' '),
        tokens: normalizedTokens,
      });
    };

    addVariant(rawQuery, baseTokens, 1.0, 'original');

    const synonymExpanded = this._expandTokenSet(baseTokens, { includeTypos: false });
    if (synonymExpanded.length > baseTokens.length) {
      addVariant(synonymExpanded.join(' '), synonymExpanded, 0.92, 'expanded');
    }

    const typoExpanded = this._expandTokenSet(baseTokens, { includeTypos: true });
    if (typoExpanded.join('|') !== synonymExpanded.join('|')) {
      addVariant(typoExpanded.join(' '), typoExpanded, 0.86, 'typo');
    }

    const unique = new Map();
    for (const variant of variants) {
      if (!unique.has(variant.key)) {
        unique.set(variant.key, variant);
      }
    }
    return Array.from(unique.values()).slice(0, 4);
  }

  _expandTokenSet(tokens, options = {}) {
    const { includeTypos = false } = options;
    const seen = new Set();
    const out = [];
    for (const token of this._normalizeQueryTokenSet(tokens)) {
      if (!seen.has(token)) {
        seen.add(token);
        out.push(token);
      }

      const stem = this._stemToken(token);
      if (stem && !seen.has(stem)) {
        seen.add(stem);
        out.push(stem);
      }

      const synonyms = QUERY_SYNONYMS[token] || [];
      for (const synonym of synonyms) {
        if (!seen.has(synonym)) {
          seen.add(synonym);
          out.push(synonym);
        }
      }

      const acronymParts = ACRONYM_MAP[token] || [];
      for (const part of acronymParts) {
        if (!seen.has(part)) {
          seen.add(part);
          out.push(part);
        }
      }

      if (includeTypos) {
        const fuzzy = this._findApproximateTerms(token, 2);
        for (const candidate of fuzzy) {
          if (!seen.has(candidate)) {
            seen.add(candidate);
            out.push(candidate);
          }
        }
      }
    }
    return out;
  }

  _normalizeQueryTokenSet(tokens) {
    return (Array.isArray(tokens) ? tokens : [])
      .map((token) => this._normalizeText(token))
      .filter(Boolean)
      .flatMap((token) => token.split(/\s+/))
      .filter((token) => token.length > 1)
      .filter((token) => !this._isStopWord(token));
  }

  _expandQueryTokens(baseTokens) {
    const seen = new Set();
    const expanded = [];
    const baseTokenSet = new Set(this._normalizeQueryTokenSet(baseTokens));

    const addTerm = (token, weight, source) => {
      if (!token || seen.has(token)) return;
      seen.add(token);
      expanded.push({ token, weight, source });
    };

    for (const token of baseTokenSet) {
      addTerm(token, 1.0, 'query');
      const stem = this._stemToken(token);
      if (stem && stem !== token) {
        addTerm(stem, 0.86, 'stem');
      }

      const synonyms = QUERY_SYNONYMS[token] || [];
      for (const synonym of synonyms) {
        addTerm(synonym, 0.72, 'synonym');
      }

      const acronymParts = ACRONYM_MAP[token] || [];
      for (const part of acronymParts) {
        addTerm(part, 0.78, 'acronym');
      }

      const fuzzy = this._findApproximateTerms(token, 2);
      for (const approximate of fuzzy) {
        addTerm(approximate, 0.58, 'fuzzy');
      }
    }

    return expanded;
  }

  _collectCandidates(expandedTerms, maxCandidates) {
    const candidates = new Map();

    for (const term of expandedTerms) {
      const docs = this.invertedIndex.get(term.token);
      if (!docs) continue;
      for (const docId of docs) {
        let entry = candidates.get(docId);
        if (!entry) {
          entry = { hits: 0, weightedHits: 0, matchedTokens: new Set() };
          candidates.set(docId, entry);
        }
        entry.hits += 1;
        entry.weightedHits += term.weight;
        entry.matchedTokens.add(term.token);
      }
    }

    return new Map(
      Array.from(candidates.entries())
        .sort((a, b) => b[1].weightedHits - a[1].weightedHits)
        .slice(0, maxCandidates)
    );
  }

  _fuseWithRrf(rankings, maxCandidates) {
    const k = 60;
    const fused = new Map();

    for (const ranking of rankings) {
      const weight = Number.isFinite(ranking.weight) ? ranking.weight : 1;
      ranking.results.forEach((result, index) => {
        const rank = index + 1;
        const gain = weight / (k + rank);
        let entry = fused.get(result.document.id);
        if (!entry) {
          entry = {
            ...result,
            score: 0,
            _rrf: 0,
            _rankVotes: 0
          };
          fused.set(result.document.id, entry);
        }
        entry._rrf += gain;
        entry._rankVotes += 1;
        if (result.score > entry.score) {
          entry.score = result.score;
          entry.scoreBreakdown = result.scoreBreakdown;
          entry.excerpt = result.excerpt;
          entry.citation = result.citation;
          entry.matchedQueryTokens = result.matchedQueryTokens;
        }
      });
    }

    return Array.from(fused.values())
      .sort((a, b) => b._rrf - a._rrf)
      .slice(0, maxCandidates)
      .map((item) => ({
        ...item,
        score: item.score + (item._rrf * 8) + (item._rankVotes * 0.03)
      }));
  }

  _scoreDocument(document, candidateMeta, queryTokens, expandedTerms, rawQuery, fieldStats) {
    const k1 = 1.2;
    const bField = 0.75;
    const totalDocs = Math.max(1, this.documents.size);
    const lexical = document.lexical || {};
    const tfByField = lexical.tfByField || {};
    const fieldLengths = lexical.fieldLengths || {};
    const matchedBaseTerms = new Set();

    let bm25f = 0;
    for (const term of expandedTerms) {
      let fieldTfWeight = 0;
      for (const field of Object.keys(this.fieldWeights)) {
        const tfMap = tfByField[field] || {};
        const tf = Number(tfMap[term.token] || 0);
        if (!tf) continue;
        const avgLength = Math.max(1, fieldStats.avgLengths[field] || 1);
        const length = Math.max(1, fieldLengths[field] || 1);
        const normalizedTf = tf / (1 - bField + (bField * length) / avgLength);
        fieldTfWeight += this.fieldWeights[field] * normalizedTf;
      }
      if (fieldTfWeight <= 0) continue;

      if (term.source === 'query') {
        matchedBaseTerms.add(term.token);
      }

      const df = this.invertedIndex.has(term.token) ? this.invertedIndex.get(term.token).size : 0;
      const idf = Math.log(1 + ((totalDocs - df + 0.5) / (df + 0.5)));
      bm25f += idf * ((fieldTfWeight * (k1 + 1)) / (fieldTfWeight + k1)) * term.weight;
    }

    const coverage = queryTokens.length > 0 ? (matchedBaseTerms.size / queryTokens.length) : 0;
    const phraseHit = this._containsNormalizedPhrase(document, rawQuery);
    const phraseBoost = phraseHit ? 0.24 : 0;
    const candidateBoost = candidateMeta.weightedHits * 0.02;
    const proximityBoost = this._computeDocumentProximityBoost(document, queryTokens);
    const sectionBoost = this._computeSectionPriorityBoost(document, queryTokens);

    const totalScore = bm25f + (coverage * 0.45) + phraseBoost + candidateBoost + proximityBoost + sectionBoost;

    return {
      totalScore,
      matchedQueryTokens: Array.from(matchedBaseTerms),
      breakdown: {
        bm25f,
        coverage,
        phraseBoost,
        candidateBoost,
        proximityBoost,
        sectionBoost
      }
    };
  }

  _rerankLexicalPlus(results, queryTokens) {
    const prepared = results.map((item) => {
      const breakdown = item.scoreBreakdown || {};
      const coverage = Number.isFinite(breakdown.coverage) ? breakdown.coverage : 0;
      const phraseBoost = Number.isFinite(breakdown.phraseBoost) ? breakdown.phraseBoost : 0;
      const sectionBoost = Number.isFinite(breakdown.sectionBoost) ? breakdown.sectionBoost : 0;
      const overlap = Array.isArray(item.matchedQueryTokens) && queryTokens.length > 0
        ? item.matchedQueryTokens.length / queryTokens.length
        : 0;

      return {
        ...item,
        _baseRelevance: Number(item.score || 0) + (coverage * 0.6) + (overlap * 0.35) + phraseBoost + sectionBoost,
      };
    });

    const selected = [];
    const pool = [...prepared];
    const lambda = 0.78;

    while (pool.length > 0 && selected.length < prepared.length) {
      let bestIndex = 0;
      let bestValue = Number.NEGATIVE_INFINITY;

      for (let i = 0; i < pool.length; i += 1) {
        const candidate = pool[i];
        let maxSimilarity = 0;
        for (const picked of selected) {
          maxSimilarity = Math.max(maxSimilarity, this._resultSimilarity(candidate, picked));
        }
        const mmr = (lambda * candidate._baseRelevance) - ((1 - lambda) * maxSimilarity);
        if (mmr > bestValue) {
          bestValue = mmr;
          bestIndex = i;
        }
      }
      selected.push(pool.splice(bestIndex, 1)[0]);
    }

    return selected.map((item, index) => ({
      ...item,
      score: item._baseRelevance - (index * 0.0001)
    }));
  }

  _findBestExcerptData(document, baseQueryTokens, expandedTerms, rawQuery) {
    if (!document.chunks || document.chunks.length === 0) {
      return {
        excerpt: document.preview,
        chunkId: null,
        start: 0
      };
    }

    let best = null;
    let bestScore = -1;
    for (const chunk of document.chunks) {
      const scored = this._scoreChunk(chunk, baseQueryTokens, expandedTerms, rawQuery);
      if (scored.score > bestScore) {
        bestScore = scored.score;
        best = { chunk, ...scored };
      }
    }

    if (!best) {
      return {
        excerpt: document.preview,
        chunkId: null,
        start: 0
      };
    }

    let excerpt = best.chunk.text.slice(0, 320);
    if (best.chunk.text.length > 320) {
      excerpt += '...';
    }

    return {
      excerpt,
      chunkId: best.chunk.id,
      start: best.chunk.start,
      phraseBoost: best.phraseBoost,
      proximityBoost: best.proximityBoost
    };
  }

  _scoreChunk(chunk, baseQueryTokens, expandedTerms, rawQuery) {
    const chunkLower = String(chunk.text || '').toLowerCase();

    let weightedHits = 0;
    for (const term of expandedTerms) {
      if (chunkLower.includes(term.token)) {
        weightedHits += term.weight;
      }
    }

    const normalizedPhrase = this._normalizeText(rawQuery);
    const phraseBoost = normalizedPhrase && normalizedPhrase.length >= 4 && chunkLower.includes(normalizedPhrase)
      ? 0.35
      : 0;

    const proximityBoost = this._computeProximityBoost(chunkLower, baseQueryTokens);
    return {
      score: weightedHits + phraseBoost + proximityBoost,
      phraseBoost,
      proximityBoost,
    };
  }

  _containsNormalizedPhrase(document, query) {
    if (!query || !document || !Array.isArray(document.chunks)) {
      return false;
    }
    const normalized = this._normalizeText(query);
    if (!normalized) {
      return false;
    }
    return document.chunks.some((chunk) => this._normalizeText(chunk.text).includes(normalized));
  }

  _computeProximityBoost(chunkLower, queryTokens) {
    const hits = [];
    for (const token of queryTokens) {
      const idx = chunkLower.indexOf(token);
      if (idx >= 0) {
        hits.push(idx);
      }
    }
    if (hits.length < 2) {
      return 0;
    }
    hits.sort((a, b) => a - b);
    const span = hits[hits.length - 1] - hits[0];
    if (span <= 40) return 0.3;
    if (span <= 120) return 0.2;
    if (span <= 220) return 0.1;
    return 0;
  }

  _computeDocumentProximityBoost(document, queryTokens) {
    if (!document || !Array.isArray(document.chunks) || queryTokens.length < 2) {
      return 0;
    }
    let best = 0;
    for (const chunk of document.chunks) {
      const score = this._computeProximityBoost(String(chunk.text || '').toLowerCase(), queryTokens);
      if (score > best) best = score;
    }
    return best * 0.75;
  }

  _computeSectionPriorityBoost(document, queryTokens) {
    if (!document || !document.lexical) return 0;
    let boost = 0;
    const titleTf = document.lexical.tfByField && document.lexical.tfByField.title ? document.lexical.tfByField.title : {};
    const headingTf = document.lexical.tfByField && document.lexical.tfByField.headings ? document.lexical.tfByField.headings : {};

    for (const token of queryTokens) {
      if (titleTf[token]) boost += 0.14;
      if (headingTf[token]) boost += 0.11;
    }
    return Math.min(0.45, boost);
  }

  _resultSimilarity(a, b) {
    const aTokens = new Set(Array.isArray(a.matchedQueryTokens) ? a.matchedQueryTokens : []);
    const bTokens = new Set(Array.isArray(b.matchedQueryTokens) ? b.matchedQueryTokens : []);
    if (aTokens.size === 0 || bTokens.size === 0) {
      return 0;
    }
    const intersection = this._setIntersectionSize(aTokens, bTokens);
    const union = aTokens.size + bTokens.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  _getDocumentTokenFrequency(document, token) {
    if (!document || !Array.isArray(document.chunks)) {
      return 0;
    }
    const pattern = new RegExp(`\\b${this._escapeRegex(token)}\\b`, 'g');
    let count = 0;
    for (const chunk of document.chunks) {
      const text = String(chunk.text || '').toLowerCase();
      const matches = text.match(pattern);
      count += matches ? matches.length : 0;
    }
    return count;
  }

  _escapeRegex(input) {
    return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  _normalizeText(input) {
    return String(input || '')
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  _knowledgeRoots() {
    const roots = [];
    if (this.cast.docsPath) {
      roots.push(this.cast.docsPath);
    }
    if (this.cast.contextPath) {
      roots.push(this.cast.contextPath);
    }
    // Keep deterministic order with unique absolute roots.
    const seen = new Set();
    return roots
      .map((root) => path.resolve(root))
      .filter((root) => {
        if (seen.has(root)) return false;
        seen.add(root);
        return true;
      });
  }

  _docIdFromPath(filePath) {
    try {
      const rel = path.relative(this.cast.path, filePath).replace(/\\/g, '/');
      if (rel && !rel.startsWith('..')) {
        return rel;
      }
    } catch {
      // fallback below
    }
    return path.basename(filePath);
  }

  _resolveDocId(docIdOrPath) {
    if (!docIdOrPath) return null;
    const normalized = String(docIdOrPath).replace(/\\/g, '/');
    if (this.documents.has(normalized)) {
      return normalized;
    }

    const basename = path.basename(normalized);
    for (const [docId, doc] of this.documents.entries()) {
      if (path.basename(docId) === basename || path.basename(doc.path || '') === basename) {
        return docId;
      }
      const relative = this._docIdFromPath(doc.path || '');
      if (relative === normalized) {
        return docId;
      }
    }
    return null;
  }
}

module.exports = ContextIndexer;
