/**
 * Cast System Plugin - OpenClaw entrypoint
 *
 * This plugin wraps the existing cast-system core modules and exposes:
 * - Gateway RPC method: cast-system.api
 * - HTTP API compatibility routes under /api/cast-manager
 * - Static mini app under /cast-manager and /cast-system
 * - Agent tools for status/context/switch
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function sendText(res, statusCode, text, contentType) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', contentType || 'text/plain; charset=utf-8');
  res.end(text);
}

function mimeTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    case '.txt':
    case '.md':
      return 'text/plain; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const body = await readRequestBody(req);
  if (!body.length) {
    return {};
  }
  const parsed = parseJsonSafe(body.toString('utf8'));
  if (!isObject(parsed)) {
    throw new Error('Invalid JSON body');
  }
  return parsed;
}

async function parseMultipart(req) {
  const contentType = req.headers['content-type'] || '';
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (match && (match[1] || match[2])) || '';

  if (!boundary) {
    throw new Error('Missing multipart boundary');
  }

  const rawBuffer = await readRequestBody(req);
  const raw = rawBuffer.toString('latin1');
  const parts = raw.split(`--${boundary}`).slice(1, -1);

  const fields = {};
  const files = [];

  for (let part of parts) {
    part = part.replace(/^\r\n/, '').replace(/\r\n$/, '');
    if (!part.trim()) {
      continue;
    }

    const sep = part.indexOf('\r\n\r\n');
    if (sep < 0) {
      continue;
    }

    const headerLines = part.slice(0, sep).split('\r\n');
    const payloadBinary = part.slice(sep + 4).replace(/\r\n$/, '');

    const headers = {};
    for (const line of headerLines) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const key = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        headers[key] = value;
      }
    }

    const disposition = headers['content-disposition'] || '';
    const nameMatch = /name="([^"]+)"/i.exec(disposition);
    if (!nameMatch) {
      continue;
    }

    const fieldName = nameMatch[1];
    const filenameMatch = /filename="([^"]*)"/i.exec(disposition);

    if (filenameMatch && filenameMatch[1]) {
      files.push({
        fieldName,
        filename: path.basename(filenameMatch[1]),
        contentType: headers['content-type'] || 'application/octet-stream',
        content: Buffer.from(payloadBinary, 'latin1'),
      });
    } else {
      fields[fieldName] = Buffer.from(payloadBinary, 'latin1').toString('utf8');
    }
  }

  return { fields, files };
}

async function ensureDirectory(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

async function fileExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function normalizePathCandidate(api, candidate) {
  if (!candidate || typeof candidate !== 'string') {
    return null;
  }
  try {
    if (api && typeof api.resolvePath === 'function') {
      return api.resolvePath(candidate);
    }
  } catch {
    // Fall through.
  }
  return path.resolve(candidate);
}

async function pickCastsPath(api, config, pluginRoot) {
  const candidates = [];

  if (typeof config.castsPath === 'string' && config.castsPath.trim()) {
    candidates.push(config.castsPath.trim());
  }

  candidates.push('casts');
  candidates.push('./casts');

  const homeDir = os.homedir();
  if (homeDir) {
    candidates.push(path.join(homeDir, '.openclaw', 'workspace', 'casts'));
    candidates.push(path.join(homeDir, '.openclaw', 'casts'));
  }

  candidates.push(path.join(pluginRoot, 'casts'));

  const normalized = candidates
    .map((candidate) => normalizePathCandidate(api, candidate))
    .filter((candidate) => typeof candidate === 'string' && candidate.length > 0);

  for (const candidate of normalized) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  const fallback = normalized[0] || path.join(process.cwd(), 'casts');
  await fsp.mkdir(fallback, { recursive: true });
  return fallback;
}

async function serveStatic(rootDir, pathname, mountPrefix, res) {
  let relativePath = pathname.slice(mountPrefix.length);
  if (!relativePath || relativePath === '/') {
    relativePath = '/index.html';
  }

  let decoded;
  try {
    decoded = decodeURIComponent(relativePath);
  } catch {
    sendText(res, 400, 'Bad request');
    return;
  }

  const safeRoot = path.resolve(rootDir);
  const joined = path.join(safeRoot, decoded.replace(/^\/+/, ''));
  let target = path.resolve(joined);

  if (!target.startsWith(safeRoot)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  try {
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) {
      target = path.join(target, 'index.html');
    }
  } catch {
    sendText(res, 404, 'Not found');
    return;
  }

  try {
    const content = await fsp.readFile(target);
    res.statusCode = 200;
    res.setHeader('Content-Type', mimeTypeFor(target));
    res.setHeader('Cache-Control', 'no-store');
    res.end(content);
  } catch {
    sendText(res, 500, 'Failed to read static file');
  }
}

module.exports = function castSystemPlugin(api) {
  const logger = api && api.logger ? api.logger : console;
  const pluginRoot = path.resolve(__dirname, '..');
  const srcRoot = path.join(pluginRoot, 'src');
  const staticRoot = path.join(pluginRoot, 'static');

  const config = isObject(api && api.pluginConfig) ? api.pluginConfig : {};

  const CastManager = require(path.join(srcRoot, 'CastManager.js'));
  const WorkingMemoryManager = require(path.join(srcRoot, 'WorkingMemoryManager.js'));
  const CastFileManager = require(path.join(srcRoot, 'CastFileManager.js'));
  const ContextIndexer = require(path.join(srcRoot, 'ContextIndexer.js'));
  const MemoryRouter = require(path.join(srcRoot, 'MemoryRouter.js'));
  const CastAutoPopulator = require(path.join(srcRoot, 'CastAutoPopulator.js'));
  const CastCatalog = require(path.join(srcRoot, 'CastCatalog.js'));
  const SharedConversationContext = require(path.join(srcRoot, 'SharedConversationContext.js'));
  const ContextStore = require(path.join(srcRoot, 'ContextStore.js'));
  const { ContextAssembler } = require(path.join(srcRoot, 'ContextAssembler.js'));
  const { migrateContextV2 } = require(path.join(srcRoot, 'migrations', 'migrate-context-v2.js'));

  const retrievalConfig = isObject(config.retrieval) ? config.retrieval : {};
  const catalogConfig = isObject(config.catalog) ? config.catalog : {};
  const sharedConversationConfig = isObject(config.sharedConversation) ? config.sharedConversation : {};
  const contextV2Config = isObject(config.contextV2) ? config.contextV2 : {};
  const contextV2Enabled = contextV2Config.enabled !== false;

  let castsPath = null;
  let workspaceRoot = process.cwd();
  let castManager = null;
  let castCatalog = null;
  let sharedConversation = null;
  let contextStore = null;
  let contextAssembler = null;
  let initPromise = null;

  const ensureInitialized = async () => {
    if (castManager) {
      return castManager;
    }

    if (initPromise) {
      return initPromise;
    }

    initPromise = (async () => {
      castsPath = await pickCastsPath(api, config, pluginRoot);
      workspaceRoot = path.dirname(castsPath);

      try {
        process.chdir(workspaceRoot);
      } catch (error) {
        logger.warn(`[CastSystem] Failed to switch cwd to ${workspaceRoot}: ${error.message}`);
      }

      logger.info(`[CastSystem] Using casts path: ${castsPath}`);

      const manager = new CastManager(castsPath);
      await manager.loadCasts();

      if (contextV2Enabled) {
        contextStore = new ContextStore({
          workspaceRoot,
          logger,
          config: contextV2Config
        });
        await contextStore.initialize();
        contextAssembler = new ContextAssembler({
          tokenBudget: Number.isFinite(contextV2Config.tokenBudget)
            ? Number(contextV2Config.tokenBudget)
            : 1800
        });
      }

      castCatalog = new CastCatalog({ castsPath, logger });
      if (catalogConfig.reconcileOnStartup !== false) {
        await castCatalog.reconcileAll(manager);
      }
      if (sharedConversationConfig.enabled !== false) {
        sharedConversation = new SharedConversationContext({
          workspaceRoot,
          logger,
          contextStore,
          maxItems: Number.isFinite(sharedConversationConfig.maxItems)
            ? Number(sharedConversationConfig.maxItems)
            : 200
        });
        await sharedConversation.initialize();
      }
      castManager = manager;
      return manager;
    })();

    try {
      return await initPromise;
    } catch (error) {
      initPromise = null;
      throw error;
    }
  };

  const requireCast = (manager, castId) => {
    if (!castId || typeof castId !== 'string') {
      throw new Error('castId is required');
    }
    const cast = manager.getCast(castId);
    if (!cast) {
      throw new Error(`Cast not found: ${castId}`);
    }
    return cast;
  };

  const withScopedActiveCast = async (manager, cast, fn) => {
    const previousActive = manager.getActiveCast();
    const previousActiveId = previousActive ? previousActive.id : null;
    manager.activeCast = cast;

    try {
      return await fn();
    } finally {
      manager.activeCast = previousActive || null;
      if (manager.stateManager && typeof manager.stateManager.setActiveCast === 'function') {
        await manager.stateManager.setActiveCast(previousActiveId);
      } else if (!previousActiveId && manager.stateManager && typeof manager.stateManager.clearActiveCast === 'function') {
        await manager.stateManager.clearActiveCast();
      }
    }
  };

  const pathTouchesKnowledge = (value) => {
    if (typeof value !== 'string') return false;
    const normalized = value.replace(/^\/+/, '');
    return (
      normalized === 'context' ||
      normalized.startsWith('context/') ||
      normalized === 'docs' ||
      normalized.startsWith('docs/')
    );
  };

  const resolveKnowledgeDirectory = (requested) => {
    if (typeof requested !== 'string' || !requested.trim()) {
      return 'docs';
    }
    return requested;
  };

  const dedupeStrings = (values) => {
    const seen = new Set();
    const output = [];
    for (const value of Array.isArray(values) ? values : []) {
      const normalized = String(value || '').trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      output.push(normalized);
    }
    return output;
  };

  const normalizeToolId = (value) => String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');

  const parseFrontmatterFields = (rawText) => {
    const text = String(rawText || '');
    const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!match) return {};
    const fields = {};
    for (const line of match[1].split('\n')) {
      const parsed = line.match(/^([a-zA-Z0-9_-]+):\s*(.+)$/);
      if (!parsed) continue;
      const key = parsed[1].trim();
      const value = parsed[2].trim().replace(/^['"]|['"]$/g, '');
      if (key && value) fields[key] = value;
    }
    return fields;
  };

  const extractSkillSummary = (rawText) => {
    const text = String(rawText || '');
    const lines = text.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('---')) continue;
      if (trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('name:')) continue;
      if (trimmed.startsWith('description:')) continue;
      return trimmed.replace(/^"|"$/g, '').slice(0, 220);
    }
    return '';
  };

  const getCastToolPolicy = (castConfig) => {
    const config = isObject(castConfig) ? castConfig : {};
    const tools = isObject(config.tools) ? config.tools : {};
    const fallbackAllowed = Array.isArray(config.allowedTools) ? config.allowedTools : [];
    const allowedRaw = Array.isArray(tools.allowed) ? tools.allowed : fallbackAllowed;
    const allowedTools = dedupeStrings(allowedRaw.map((item) => normalizeToolId(item)).filter(Boolean));
    const mode = tools.mode === 'allowlist' && allowedTools.length > 0 ? 'allowlist' : 'all';
    return { mode, allowedTools };
  };

  const getCastToolPromptSection = (castConfig) => {
    const policy = getCastToolPolicy(castConfig);
    if (policy.mode !== 'allowlist' || policy.allowedTools.length === 0) {
      return [
        '## Tool Access Policy',
        'No cast-specific tool restrictions. All available tools may be used when needed.'
      ];
    }
    return [
      '## Tool Access Policy',
      'This cast is on a strict tool allowlist. You must only call tools in this list.',
      ...policy.allowedTools.map((toolId) => `- ${toolId}`),
      'If a required capability is missing from this list, continue without calling unavailable tools and explain the limitation.'
    ];
  };

  const ensureHexColor = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const match = raw.match(/^#?([0-9a-fA-F]{6})$/);
    return match ? `#${match[1].toLowerCase()}` : '';
  };

  const hashStringToColor = (value) => {
    const input = String(value || '').trim();
    let hash = 0;
    for (let i = 0; i < input.length; i += 1) {
      hash = ((hash << 5) - hash) + input.charCodeAt(i);
      hash |= 0;
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue} 72% 58%)`;
  };

  const defaultHexPalette = [
    '#4f46e5',
    '#0ea5e9',
    '#10b981',
    '#f59e0b',
    '#ef4444',
    '#d946ef',
    '#ec4899',
    '#14b8a6',
    '#8b5cf6',
    '#22c55e'
  ];

  const pickCastColor = (seed) => {
    const normalized = String(seed || '').trim();
    if (!normalized) return defaultHexPalette[0];
    let hash = 0;
    for (let i = 0; i < normalized.length; i += 1) {
      hash = ((hash << 5) - hash) + normalized.charCodeAt(i);
      hash |= 0;
    }
    const idx = Math.abs(hash) % defaultHexPalette.length;
    return defaultHexPalette[idx];
  };

  const slugifyCastId = (value) => String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  const extractSystemPromptFromProfile = (content) => {
    const text = String(content || '');
    const sectionMatch = text.match(/\n##\s*System Prompt\s*\n([\s\S]*?)(?:\n##\s+|\n#\s+|$)/i);
    if (sectionMatch && sectionMatch[1]) {
      return sectionMatch[1].trim();
    }
    return text.trim();
  };

  const upsertSystemPromptSection = (content, prompt) => {
    const text = String(content || '').trim();
    const safePrompt = String(prompt || '').trim();
    const section = `## System Prompt\n${safePrompt || '[empty]'}`;
    if (!text) {
      return `${section}\n`;
    }
    if (/\n##\s*System Prompt\s*\n/i.test(text)) {
      return text.replace(/\n##\s*System Prompt\s*\n([\s\S]*?)(?=\n##\s+|\n#\s+|$)/i, `\n${section}\n`);
    }
    return `${text}\n\n${section}\n`;
  };

  const ensureCastConfigColor = async (cast, preferredColor) => {
    const { configPath, configJson } = await readCastConfigJson(cast);
    const currentColor = ensureHexColor(configJson && configJson.color ? configJson.color : '');
    const nextColor = ensureHexColor(preferredColor) || currentColor || pickCastColor(cast.id || cast.config && cast.config.name);
    if (currentColor === nextColor) {
      cast.config = configJson;
      return nextColor;
    }
    configJson.color = nextColor;
    configJson.modified = new Date().toISOString();
    await fsp.writeFile(configPath, JSON.stringify(configJson, null, 2), 'utf8');
    cast.config = configJson;
    return nextColor;
  };

  const createCastByName = async (manager, params) => {
    const name = String(params && params.name ? params.name : '').trim();
    if (!name) {
      throw new Error('name is required');
    }
    let baseId = slugifyCastId(params.castId || name);
    if (!baseId) {
      baseId = `cast-${Date.now()}`;
    }
    let castId = baseId;
    let suffix = 2;
    while (manager.getCast(castId)) {
      castId = `${baseId}-${suffix}`;
      suffix += 1;
    }
    const requestedColor = ensureHexColor(params && params.color ? params.color : '');
    const color = requestedColor || pickCastColor(castId);
    const templateId = String(params && params.templateId ? params.templateId : '').trim() || 'architect';
    const cast = await manager.createCast(castId, templateId, {
      name,
      color,
      emoji: String(params && params.emoji ? params.emoji : '').trim() || '🔹',
      description: String(params && params.description ? params.description : '').trim() || `${name} cast`
    });
    await ensureCastConfigColor(cast, color);
    return cast;
  };

  const readCastConfigJson = async (cast) => {
    const configPath = path.join(cast.path, 'cast.json');
    let configJson = {};
    try {
      configJson = parseJsonSafe(await fsp.readFile(configPath, 'utf8')) || {};
    } catch {
      configJson = {};
    }
    return { configPath, configJson };
  };

  const persistCastToolPolicy = async (manager, castId, requested) => {
    const cast = requireCast(manager, castId);
    const { configPath, configJson } = await readCastConfigJson(cast);
    const nextAllowed = dedupeStrings(
      (Array.isArray(requested) ? requested : [])
        .map((item) => normalizeToolId(item))
        .filter(Boolean)
    );
    const mode = nextAllowed.length > 0 ? 'allowlist' : 'all';
    const nextTools = isObject(configJson.tools) ? { ...configJson.tools } : {};
    nextTools.mode = mode;
    nextTools.allowed = nextAllowed;
    configJson.tools = nextTools;
    configJson.modified = new Date().toISOString();
    await fsp.writeFile(configPath, JSON.stringify(configJson, null, 2), 'utf8');
    cast.config = configJson;
    return { mode, allowedTools: nextAllowed };
  };

  const resolveOpenclawHomeGuess = () => {
    if (workspaceRoot && path.basename(workspaceRoot) === 'workspace') {
      return path.dirname(workspaceRoot);
    }
    const home = os.homedir();
    return home ? path.join(home, '.openclaw') : '';
  };

  const readOpenclawSkillExtraDirs = async () => {
    const openclawHome = resolveOpenclawHomeGuess();
    if (!openclawHome) return [];
    const configPath = path.join(openclawHome, 'openclaw.json');
    let json = null;
    try {
      json = parseJsonSafe(await fsp.readFile(configPath, 'utf8'));
    } catch {
      json = null;
    }
    const extras = json && isObject(json.skills) && isObject(json.skills.load) && Array.isArray(json.skills.load.extraDirs)
      ? json.skills.load.extraDirs
      : [];
    return extras
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .map((item) => path.isAbsolute(item) ? item : path.resolve(workspaceRoot || process.cwd(), item));
  };

  const discoverSkillRoots = async () => {
    const home = os.homedir();
    const envRoots = [];
    const extraDirs = await readOpenclawSkillExtraDirs();
    const openclawHome = resolveOpenclawHomeGuess();
    const codexHome = '';
    const configuredRoots = isObject(config.tools) && Array.isArray(config.tools.skillRoots)
      ? config.tools.skillRoots.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const candidates = dedupeStrings([
      ...configuredRoots,
      ...extraDirs,
      ...envRoots,
      workspaceRoot ? path.join(workspaceRoot, 'skills') : '',
      workspaceRoot ? path.join(workspaceRoot, '.skills') : '',
      openclawHome ? path.join(openclawHome, 'workspace', 'skills') : '',
      codexHome ? path.join(codexHome, 'skills') : '',
      home ? path.join(home, '.codex', 'skills') : '',
      home ? path.join(home, '.agents', 'skills') : '',
      home ? path.join(home, 'documents', 'for_agents', 'SKILLS', 'codex') : ''
    ].filter(Boolean));

    const existing = [];
    for (const candidate of candidates) {
      const resolved = path.resolve(candidate);
      if (await fileExists(resolved)) {
        existing.push(resolved);
      }
    }
    return dedupeStrings(existing);
  };

  const walkSkillDirs = async (rootDir, maxDepth = 3) => {
    const discovered = [];
    const visit = async (dir, depth) => {
      if (depth > maxDepth) return;
      const skillPath = path.join(dir, 'SKILL.md');
      if (await fileExists(skillPath)) {
        discovered.push(dir);
      }
      if (depth === maxDepth) return;
      let entries = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        await visit(path.join(dir, entry.name), depth + 1);
      }
    };
    await visit(rootDir, 0);
    return discovered;
  };

  let toolCatalogCache = { timestamp: 0, tools: [] };

  const listAvailableTools = async () => {
    const now = Date.now();
    if (toolCatalogCache.tools.length > 0 && now - toolCatalogCache.timestamp < 5000) {
      return toolCatalogCache.tools;
    }

    const roots = await discoverSkillRoots();
    const mapped = new Map();

    for (const root of roots) {
      const dirs = await walkSkillDirs(root, 3);
      for (const dir of dirs) {
        const skillPath = path.join(dir, 'SKILL.md');
        let content = '';
        try {
          content = await fsp.readFile(skillPath, 'utf8');
        } catch {
          continue;
        }
        const relativeId = normalizeToolId(path.relative(root, dir));
        if (!relativeId) continue;
        if (mapped.has(relativeId)) continue;
        const frontmatter = parseFrontmatterFields(content);
        const fallbackName = path.basename(dir);
        const name = String(frontmatter.name || fallbackName).trim();
        const description = String(frontmatter.description || extractSkillSummary(content) || '').trim();
        mapped.set(relativeId, {
          id: relativeId,
          name: name || relativeId,
          description: description || 'No description available.',
          sourceRoot: root
        });
      }
    }

    const tools = Array.from(mapped.values())
      .sort((a, b) => a.name.localeCompare(b.name));
    toolCatalogCache = { timestamp: now, tools };
    return tools;
  };

  const formatSharedHits = (sharedSearch) => {
    return (sharedSearch && Array.isArray(sharedSearch.results))
      ? sharedSearch.results.map((hit, index) => ({
          rank: index + 1,
          type: hit.type,
          text: hit.text,
          score: hit.score,
          citation: { docId: hit.id, chunkId: null, start: 0 }
        }))
      : [];
  };

  const maybeReconcileCast = async (castOrId) => {
    const castId = castOrId && typeof castOrId === 'object' ? castOrId.id : castOrId;
    if (!castCatalog || !castId) return null;
    if (catalogConfig.reconcileOnMutation === false) return null;
    try {
      return await castCatalog.reconcileCast(castOrId);
    } catch (error) {
      logger.warn(`[CastSystem] reconcile skipped for ${castId}: ${error.message}`);
      return null;
    }
  };

  const enrichCastForList = async (manager, castInfo) => {
    const cast = manager.getCast(castInfo.id);
    if (!cast) {
      return castInfo;
    }
    const toolPolicy = getCastToolPolicy(cast.config);
    const snapshot = castCatalog ? await castCatalog.summarizeCast(cast) : null;
    return {
      ...castInfo,
      emoji: cast.config && cast.config.emoji ? String(cast.config.emoji) : '🔹',
      color: ensureHexColor(cast.config && cast.config.color ? cast.config.color : '') || pickCastColor(cast.id),
      description: cast.config && cast.config.description ? String(cast.config.description) : '',
      contextCount: snapshot ? snapshot.contextCount : castInfo.contextCount,
      indexedCount: snapshot ? snapshot.indexedCount : castInfo.indexedCount,
      staleContextIndex: snapshot ? snapshot.staleContextIndex : castInfo.staleContextIndex,
      lastIndexedAt: snapshot ? snapshot.lastIndexedAt : castInfo.lastIndexedAt,
      toolMode: toolPolicy.mode,
      allowedTools: toolPolicy.allowedTools
    };
  };

  const buildAgentPromptPack = (query, cast, searchResult, sharedSearch) => {
    const snippets = (searchResult.results || []).map((item, index) => ({
      rank: index + 1,
      docId: item.document.id,
      excerpt: item.excerpt || item.document.preview || '',
      citation: item.citation || { docId: item.document.id, chunkId: null, start: 0 },
      score: item.score,
    }));

    return {
      task: 'Answer the user query using cast knowledge snippets plus shared conversation signals.',
      rules: [
        'Prefer high-scoring snippets first.',
        'Cite sources as [docId#chunkId] in each factual claim.',
        'If evidence is missing, explicitly state uncertainty.'
      ],
      cast: {
        id: cast.id,
        name: cast.config && cast.config.name ? cast.config.name : cast.id,
      },
      query,
      snippets,
      sharedConversation: formatSharedHits(sharedSearch),
    };
  };

  const getConversationMemories = async (cast) => {
    const conversationsPath = path.join(cast.memoryPath, 'conversations');
    const memories = [];

    let files = [];
    try {
      files = await fsp.readdir(conversationsPath);
    } catch {
      return { success: true, memories, total: 0 };
    }

    const markdown = files.filter((file) => file.endsWith('.md')).sort().reverse();

    for (const file of markdown) {
      const fullPath = path.join(conversationsPath, file);
      const content = await fsp.readFile(fullPath, 'utf8');
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
      const summaryMatch = content.match(/## Summary\n([\s\S]*?)(?=\n##|$)/);

      if (!frontmatterMatch) {
        continue;
      }

      const frontmatter = frontmatterMatch[1];
      const dateMatch = frontmatter.match(/date:\s*"([^"]+)"/);
      const topicsMatch = frontmatter.match(/topics:\n([\s\S]*?)(?=\n\w+:|\n---|\n$)/);

      memories.push({
        file,
        date: dateMatch ? dateMatch[1] : file.split('_')[0],
        summary: summaryMatch ? summaryMatch[1].trim() : 'No summary',
        topics: topicsMatch
          ? (topicsMatch[1].match(/-\s*"([^"]+)"/g) || []).map((item) => item.replace(/-\s*"|"/g, ''))
          : [],
      });
    }

    return { success: true, memories, total: memories.length };
  };

  const clampText = (value, maxChars) => {
    const text = String(value || '').trim();
    if (!Number.isFinite(maxChars) || maxChars <= 0) {
      return text;
    }
    if (text.length <= maxChars) {
      return text;
    }
    return `${text.slice(0, maxChars)} ...[truncated]`;
  };

  const extractMessageText = (message) => {
    if (!message) return '';
    if (typeof message === 'string') return message;

    // Agent messages usually carry content as string or block array.
    const content = message.content ?? message.text ?? message.message ?? '';
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((block) => {
          if (!block) return '';
          if (typeof block === 'string') return block;
          if (typeof block.text === 'string') return block.text;
          if (block.type === 'image') return '[image]';
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    if (content && typeof content === 'object' && typeof content.text === 'string') {
      return content.text;
    }
    return '';
  };

  const buildLiveSessionSummary = (messages) => {
    const rows = Array.isArray(messages) ? messages : [];
    if (rows.length === 0) {
      return 'No prior messages found in active session.';
    }

    const roleCount = { system: 0, user: 0, assistant: 0, tool: 0, other: 0 };
    const recentUsers = [];
    const recentAssistant = [];

    for (const msg of rows.slice(-60)) {
      const roleRaw = String(msg && msg.role ? msg.role : 'other').toLowerCase();
      const role = Object.prototype.hasOwnProperty.call(roleCount, roleRaw) ? roleRaw : 'other';
      roleCount[role] += 1;
      const text = clampText(extractMessageText(msg).replace(/\s+/g, ' '), 220);
      if (!text) continue;
      if (role === 'user' && recentUsers.length < 6) {
        recentUsers.push(text);
      } else if (role === 'assistant' && recentAssistant.length < 6) {
        recentAssistant.push(text);
      }
    }

    return [
      `Session messages: ${rows.length} (system=${roleCount.system}, user=${roleCount.user}, assistant=${roleCount.assistant}, tool=${roleCount.tool}, other=${roleCount.other}).`,
      recentUsers.length > 0
        ? `Recent user intents: ${recentUsers.map((line, idx) => `${idx + 1}) ${line}`).join(' | ')}`
        : 'Recent user intents: none.',
      recentAssistant.length > 0
        ? `Recent assistant outputs: ${recentAssistant.map((line, idx) => `${idx + 1}) ${line}`).join(' | ')}`
        : 'Recent assistant outputs: none.'
    ].join('\n');
  };

  const formatLastMessages = (messages, limit = 20) => {
    const rows = Array.isArray(messages) ? messages : [];
    const tail = rows.slice(-Math.max(1, limit));
    if (tail.length === 0) {
      return 'No recent messages.';
    }

    return tail
      .map((msg, idx) => {
        const role = String(msg && msg.role ? msg.role : 'unknown').toLowerCase();
        const text = clampText(extractMessageText(msg).replace(/\s+/g, ' '), 320) || '[no text]';
        return `${idx + 1}. [${role}] ${text}`;
      })
      .join('\n');
  };

  const buildDeterministicCastPrepend = async (manager, event) => {
    const activeCast = manager.getActiveCast();
    if (!activeCast) {
      const liveSummary = buildLiveSessionSummary(event && event.messages ? event.messages : []);
      const recentMessages = formatLastMessages(event && event.messages ? event.messages : [], 20);
      const currentPrompt = clampText(event && event.prompt ? event.prompt : '', 1200);
      return [
        '[CAST MODE OFF - DEFAULT AGENT]',
        'No cast is active. Operate in the default agent persona and default tool scope.',
        'Do not apply cast profiles, cast tool allowlists, or cast-specific style instructions from earlier turns.',
        '',
        '## Live Session Summary',
        liveSummary,
        '',
        '## Last 20 Session Messages',
        recentMessages,
        '',
        '## Current User Prompt',
        currentPrompt || '[empty prompt]'
      ].join('\n');
    }

    const castName = activeCast.config && activeCast.config.name ? activeCast.config.name : activeCast.id;
    let profileContent = '';
    if (activeCast.profilePath) {
      try {
        profileContent = await fsp.readFile(activeCast.profilePath, 'utf8');
      } catch {
        profileContent = '';
      }
    }
    profileContent = clampText(profileContent, 8000);

    let sharedContextText = '';
    if (sharedConversation) {
      try {
        const shared = await sharedConversation.getContext({
          limit: Number.isFinite(sharedConversationConfig.contextLimit)
            ? Number(sharedConversationConfig.contextLimit)
            : 8
        });
        sharedContextText = clampText(shared && shared.text ? shared.text : '', 4000);
      } catch {
        sharedContextText = '';
      }
    }

    let storedSummary = '';
    try {
      const memory = await getConversationMemories(activeCast);
      if (memory && Array.isArray(memory.memories) && memory.memories.length > 0) {
        const latest = memory.memories[0];
        const topics = Array.isArray(latest.topics) && latest.topics.length > 0
          ? ` Topics: ${latest.topics.join(', ')}.`
          : '';
        storedSummary = `Latest stored summary (${latest.date || latest.file}): ${latest.summary || 'n/a'}.${topics}`;
      }
    } catch {
      storedSummary = '';
    }
    if (!storedSummary) {
      storedSummary = 'No stored conversation summary found for this cast.';
    }

    const liveSummary = buildLiveSessionSummary(event && event.messages ? event.messages : []);
    const recentMessages = formatLastMessages(event && event.messages ? event.messages : [], 20);
    const currentPrompt = clampText(event && event.prompt ? event.prompt : '', 1200);
    const toolPolicyLines = getCastToolPromptSection(activeCast.config || {});

    return [
      '[CAST HARD SWITCH - DETERMINISTIC MODE]',
      `Active cast is locked to: ${castName} (${activeCast.id}).`,
      'You must respond in this cast persona without drifting to another style.',
      '',
      '## Cast Profile (authoritative)',
      profileContent || `No profile.md found for ${activeCast.id}.`,
      '',
      ...toolPolicyLines,
      '',
      '## Shared Context Sheet',
      sharedContextText || 'No shared conversation context available.',
      '',
      '## Session Summary',
      storedSummary,
      '',
      '## Live Session Summary',
      liveSummary,
      '',
      '## Last 20 Session Messages',
      recentMessages,
      '',
      '## Current User Prompt',
      currentPrompt || '[empty prompt]'
    ].join('\n');
  };

  const ensureContextV2 = () => {
    if (!contextV2Enabled || !contextStore || !contextAssembler) {
      throw new Error('Context V2 is not enabled');
    }
    return { store: contextStore, assembler: contextAssembler };
  };

  const buildContextV2Prompt = async (params = {}) => {
    const { store, assembler } = ensureContextV2();
    const snapshot = await store.getContextSnapshot({
      castId: params.castId || null,
      userId: params.userId || null,
      query: params.query || '',
      limit: Number.isFinite(params.limit) ? Number(params.limit) : undefined
    });
    const assembled = assembler.assemble(snapshot, {
      tokenBudget: Number.isFinite(params.tokenBudget) ? Number(params.tokenBudget) : undefined
    });
    return { snapshot, assembled };
  };

  const handleContextV2Action = async (action, params, manager) => {
    if (!contextV2Enabled || !contextStore || !contextAssembler) {
      return null;
    }

    if (action === 'getContextSnapshot') {
      const snapshot = await contextStore.getContextSnapshot(params || {});
      return { success: true, snapshot };
    }

    if (action === 'listContractRules') {
      const rules = await contextStore.listContractRules();
      return { success: true, rules };
    }

    if (action === 'setContractRule') {
      const text = String(params && params.text ? params.text : '').trim();
      if (!text) {
        throw new Error('text is required');
      }
      const parsed = contextStore.parseContractMutationIntent(text);
      if (!parsed.matched) {
        throw new Error('Explicit contract mutation intent not detected');
      }
      if (parsed.confidence < (contextV2Config.confidenceThresholds && Number(contextV2Config.confidenceThresholds.contract) || 0.9)) {
        const pending = await contextStore.addSessionEntry(`Pending contract candidate: ${text}`, {
          type: 'pending_contract_candidate',
          source: 'user_explicit_nl',
          castId: params.castId || (manager.getActiveCast() ? manager.getActiveCast().id : null),
          userId: params.userId || null,
          confidence: parsed.confidence
        });
        return { success: true, pending: true, parsed, candidate: pending.entry };
      }
      const result = await contextStore.addContractRule(text, {
        source: 'user_explicit_nl',
        castId: params.castId || (manager.getActiveCast() ? manager.getActiveCast().id : null),
        userId: params.userId || null,
        confidence: parsed.confidence
      });
      return { success: true, pending: false, parsed, ...result };
    }

    if (action === 'removeContractRule') {
      const selector = params && (params.selector || params.id || params.match)
        ? String(params.selector || params.id || params.match)
        : '';
      const result = await contextStore.removeContractRule(selector, {
        userId: params.userId || null
      });
      return { success: true, ...result };
    }

    if (action === 'setSessionFrame') {
      const result = await contextStore.setSessionFrame(params || {}, {
        source: 'user_explicit_nl',
        castId: params.castId || (manager.getActiveCast() ? manager.getActiveCast().id : null),
        userId: params.userId || null
      });
      return { success: true, ...result };
    }

    if (action === 'getSharedContextSheet') {
      const sheet = await contextStore.getSharedContextSheet({
        castId: params.castId || (manager.getActiveCast() ? manager.getActiveCast().id : null),
        userId: params.userId || null,
        query: params.query || ''
      });
      return { success: true, sheet };
    }

    if (action === 'updateSharedContextSheet') {
      const content = String(params && (params.content || params.text) ? (params.content || params.text) : '').trim();
      if (!content) {
        throw new Error('content is required');
      }
      const mode = String(params && params.mode ? params.mode : 'replace');
      const result = await contextStore.updateSharedContextSheet(content, {
        mode,
        source: 'user_explicit_nl',
        castId: params.castId || (manager.getActiveCast() ? manager.getActiveCast().id : null),
        userId: params.userId || null
      });
      return { success: true, ...result };
    }

    if (action === 'applyContextPromptEdit' || action === 'applySharedContextPromptEdit') {
      const prompt = String(params && (params.prompt || params.text || params.instruction) ? (params.prompt || params.text || params.instruction) : '').trim();
      if (!prompt) {
        throw new Error('prompt is required');
      }
      const result = await contextStore.applySharedContextPromptEdit(prompt, {
        source: 'user_explicit_nl',
        castId: params.castId || (manager.getActiveCast() ? manager.getActiveCast().id : null),
        userId: params.userId || null
      });
      return { success: true, ...result };
    }

    if (action === 'setIntentState') {
      const state = String(params && params.state ? params.state : '').trim();
      if (!state) throw new Error('state is required');
      return await contextStore.setIntentState(state, {
        source: 'user_explicit_nl',
        castId: params.castId || (manager.getActiveCast() ? manager.getActiveCast().id : null),
        userId: params.userId || null
      });
    }

    if (action === 'getContextConflicts') {
      const conflicts = await contextStore.getConflicts();
      return { success: true, conflicts };
    }

    if (action === 'resolveContextConflict') {
      const conflictId = String(params && params.conflictId ? params.conflictId : '').trim();
      if (!conflictId) throw new Error('conflictId is required');
      const strategy = String(params && params.strategy ? params.strategy : 'keepA');
      const mergeText = String(params && params.mergeText ? params.mergeText : '');
      const result = await contextStore.resolveConflict(conflictId, strategy, mergeText, {
        userId: params.userId || null,
        castId: params.castId || (manager.getActiveCast() ? manager.getActiveCast().id : null),
        source: 'user_explicit_nl'
      });
      return { success: true, ...result };
    }

    if (action === 'contextDiagnostics') {
      return { success: true, diagnostics: contextStore.diagnostics() };
    }

    if (action === 'migrateContextV2') {
      const report = await migrateContextV2({
        store: contextStore,
        workspaceRoot,
        castsPath,
        logger
      });
      return { success: true, report };
    }

    if (action === 'getPromptContext') {
      const castId = params.castId || (manager.getActiveCast() ? manager.getActiveCast().id : null);
      const { snapshot, assembled } = await buildContextV2Prompt({
        ...params,
        castId
      });

      const cast = castId ? manager.getCast(castId) : null;
      let legacy = null;
      if (cast) {
        const memoryManager = new WorkingMemoryManager(cast.path, { contextStore, castId: cast.id });
        await memoryManager.initialize();
        legacy = await memoryManager.getContextForPrompt(params.userId);
      }

      return {
        success: true,
        context: {
          workingMemory: assembled.assembledText,
          userContext: legacy ? legacy.userContext : '',
          sharedConversation: (snapshot.references || []).slice(0, 4).map((row) => row.text).join('\n'),
          sharedConversationStructured: snapshot.references || [],
          sharedContextSheet: await contextStore.getSharedContextSheet({
            castId,
            userId: params.userId || null,
            query: params.query || ''
          }),
          contextV2: assembled
        }
      };
    }

    if (action === 'autoCapture') {
      const castId = params.castId || (manager.getActiveCast() ? manager.getActiveCast().id : null);
      if (!castId) throw new Error('castId is required');
      const capture = await contextStore.captureAuto({
        castId,
        userId: params.userId || null,
        message: params.message || '',
        response: params.response || ''
      });
      return { success: true, result: capture, contextV2: true };
    }

    if (action === 'answerFromContext') {
      const cast = requireCast(manager, params.castId);
      const query = String(params.query || '').trim();
      if (!query) {
        throw new Error('query is required');
      }

      const indexer = new ContextIndexer(cast);
      await indexer.initialize();
      const searchResult = await indexer.search(query, {
        limit: Number.isFinite(params.limit) ? Number(params.limit) : 8,
        minScore: Number.isFinite(params.minScore) ? Number(params.minScore) : 0.1,
        rerankMode: retrievalConfig.rerank === 'agent' ? 'agent' : 'off',
        maxCandidates: Number.isFinite(retrievalConfig.maxCandidates)
          ? Number(retrievalConfig.maxCandidates)
          : 30
      });
      const snapshot = await contextStore.getContextSnapshot({
        castId: cast.id,
        userId: params.userId || null,
        query,
        limit: Number.isFinite(params.limit) ? Number(params.limit) : 8
      });
      const assembled = contextAssembler.assemble(snapshot, {
        tokenBudget: Number.isFinite(params.tokenBudget) ? Number(params.tokenBudget) : undefined
      });

      const sources = (searchResult.results || []).map((result) => ({
        docId: result.document.id,
        score: result.score,
        tier: 'cast_context',
        citation: result.citation || { docId: result.document.id, chunkId: null, start: 0 }
      }));
      for (const ref of snapshot.references || []) {
        sources.push({
          docId: ref.id || 'episodic',
          score: Number.isFinite(ref.score) ? ref.score : 0.5,
          tier: 'context_v2',
          citation: { docId: ref.id || 'episodic', chunkId: null, start: 0 }
        });
      }

      const castSnippets = searchResult.results.length > 0
        ? searchResult.results.slice(0, 4).map((result, idx) => {
            const cite = result.citation && result.citation.chunkId !== null
              ? `${result.citation.docId}#${result.citation.chunkId}`
              : result.document.id;
            const snippet = String(result.excerpt || result.document.preview || '').replace(/\s+/g, ' ').trim();
            return `${idx + 1}. ${snippet} [${cite}]`;
          }).join('\n')
        : 'No relevant context snippets were found for this query.';

      const v2Summary = assembled.sections.references.length > 0
        ? `\n\nContext V2 references:\n${assembled.sections.references.slice(0, 3).map((row, idx) => `${idx + 1}. ${row.text}`).join('\n')}`
        : '';

      return {
        success: true,
        mode: 'hybrid-lite+context-v2',
        query,
        draftAnswer: `${castSnippets}${v2Summary}`,
        sources,
        promptPack: buildAgentPromptPack(query, cast, searchResult, { results: snapshot.references || [] }),
        retrieval: {
          total: searchResult.total,
          queryTime: searchResult.queryTime,
          rerankMode: searchResult.rerankMode,
          contextV2Hits: (snapshot.references || []).length
        },
        contextV2: {
          sections: assembled.sections,
          excludedConflicts: (snapshot.conflicts || []).length
        }
      };
    }

    return null;
  };

  const handleAction = async (action, payload) => {
    const params = isObject(payload) ? payload : {};
    const manager = await ensureInitialized();

    // Keep API and UI in sync with on-disk cast edits created outside this process.
    try {
      await manager.loadCasts();
    } catch (error) {
      logger.warn(`[CastSystem] Could not refresh casts before action ${action}: ${error && error.message ? error.message : error}`);
    }

    const contextV2Result = await handleContextV2Action(action, params, manager);
    if (contextV2Result) {
      return contextV2Result;
    }

    switch (action) {
      case 'listCasts': {
        const baseCasts = manager.listCasts();
        const casts = [];
        for (const castInfo of baseCasts) {
          casts.push(await enrichCastForList(manager, castInfo));
        }
        const active = manager.getActiveCast();
        return {
          success: true,
          casts,
          activeCast: active
            ? {
                id: active.id,
                name: active.config && active.config.name ? active.config.name : active.id,
              }
            : null,
        };
      }

      case 'getCast': {
        const cast = requireCast(manager, params.castId);
        return { success: true, cast };
      }

      case 'listAvailableTools': {
        const tools = await listAvailableTools();
        return { success: true, tools };
      }

      case 'getCastTools': {
        const cast = requireCast(manager, params.castId);
        const tools = await listAvailableTools();
        const policy = getCastToolPolicy(cast.config || {});
        const availableIds = new Set(tools.map((tool) => tool.id));
        const missingTools = policy.allowedTools.filter((toolId) => !availableIds.has(toolId));
        return {
          success: true,
          castId: cast.id,
          mode: policy.mode,
          allowedTools: policy.allowedTools,
          availableTools: tools,
          missingTools
        };
      }

      case 'setCastTools': {
        if (!params.castId) {
          throw new Error('castId is required');
        }
        const updated = await persistCastToolPolicy(manager, params.castId, params.allowedTools);
        return {
          success: true,
          castId: params.castId,
          mode: updated.mode,
          allowedTools: updated.allowedTools
        };
      }

      case 'addCastTool': {
        if (!params.castId) {
          throw new Error('castId is required');
        }
        const toolId = normalizeToolId(params.toolId);
        if (!toolId) {
          throw new Error('toolId is required');
        }
        const cast = requireCast(manager, params.castId);
        const current = getCastToolPolicy(cast.config || {});
        const next = dedupeStrings([...current.allowedTools, toolId]);
        const updated = await persistCastToolPolicy(manager, params.castId, next);
        return {
          success: true,
          castId: params.castId,
          mode: updated.mode,
          allowedTools: updated.allowedTools
        };
      }

      case 'removeCastTool': {
        if (!params.castId) {
          throw new Error('castId is required');
        }
        const toolId = normalizeToolId(params.toolId);
        if (!toolId) {
          throw new Error('toolId is required');
        }
        const cast = requireCast(manager, params.castId);
        const current = getCastToolPolicy(cast.config || {});
        const next = current.allowedTools.filter((item) => item !== toolId);
        const updated = await persistCastToolPolicy(manager, params.castId, next);
        return {
          success: true,
          castId: params.castId,
          mode: updated.mode,
          allowedTools: updated.allowedTools
        };
      }

      case 'switchCast': {
        const previousCast = manager.getActiveCast();
        if (
          sharedConversation &&
          previousCast &&
          sharedConversationConfig.absorbScratchpadOnSwitch !== false
        ) {
          await sharedConversation.absorbCastSnapshot(previousCast, { reason: 'cast-switch' });
        }
        const result = await manager.switchCast(params.castId);
        if (sharedConversation) {
          await sharedConversation.captureSwitch({
            from: result.from || null,
            to: result.to || params.castId,
            userId: params.userId || null
          });
        }
        if (contextV2Enabled && contextStore) {
          await contextStore.addEpisodicEvent({
            type: 'switch',
            text: `Switch: ${result.from || 'none'} -> ${result.to || params.castId}`,
            castId: result.to || params.castId || null,
            userId: params.userId || null,
            source: 'system',
            metadata: {
              from: result.from || null,
              to: result.to || params.castId || null
            }
          });
        }
        return {
          success: true,
          cast: {
            id: result.cast.id,
            name: result.cast.name,
          },
          profile: result.profile || null,
          stats: result.stats,
        };
      }

      case 'getProfile': {
        const cast = requireCast(manager, params.castId);
        const profilePath = cast.profilePath || path.join(cast.path, 'profile.md');

        let content;
        try {
          content = await fsp.readFile(profilePath, 'utf8');
        } catch {
          content = `---\ncast:\n  name: "${cast.config.name}"\n---\n\n# ${cast.config.name}\n\nNo profile yet.`;
        }

        return {
          success: true,
          profile: {
            name: cast.config.name,
            content,
          },
        };
      }

      case 'getPersona': {
        const cast = requireCast(manager, params.castId);
        const profilePath = cast.profilePath || path.join(cast.path, 'profile.md');
        let content = '';
        try {
          content = await fsp.readFile(profilePath, 'utf8');
        } catch {
          content = '';
        }
        return {
          success: true,
          castId: cast.id,
          name: cast.config && cast.config.name ? cast.config.name : cast.id,
          color: ensureHexColor(cast.config && cast.config.color ? cast.config.color : '') || pickCastColor(cast.id),
          systemPrompt: extractSystemPromptFromProfile(content),
          profileContent: content
        };
      }

      case 'saveProfile': {
        const cast = requireCast(manager, params.castId);
        const profilePath = cast.profilePath || path.join(cast.path, 'profile.md');
        await ensureDirectory(profilePath);
        await fsp.writeFile(profilePath, String(params.content || ''), 'utf8');

        if (params.name && params.name !== cast.config.name) {
          const configPath = path.join(cast.path, 'cast.json');
          const configJson = parseJsonSafe(await fsp.readFile(configPath, 'utf8')) || {};
          configJson.name = params.name;
          configJson.modified = new Date().toISOString();
          await fsp.writeFile(configPath, JSON.stringify(configJson, null, 2));
          await manager.loadCasts();
        }

        return { success: true };
      }

      case 'savePersona': {
        const cast = requireCast(manager, params.castId);
        const profilePath = cast.profilePath || path.join(cast.path, 'profile.md');
        await ensureDirectory(profilePath);

        let content = '';
        try {
          content = await fsp.readFile(profilePath, 'utf8');
        } catch {
          content = '';
        }

        const nextPrompt = String(params.systemPrompt || '').trim();
        const nextName = String(params.name || '').trim() || (cast.config && cast.config.name ? cast.config.name : cast.id);
        const nextColor = ensureHexColor(params.color || '') || ensureHexColor(cast.config && cast.config.color ? cast.config.color : '') || pickCastColor(cast.id);

        const updatedProfile = upsertSystemPromptSection(content, nextPrompt);
        await fsp.writeFile(profilePath, updatedProfile, 'utf8');

        const { configPath, configJson } = await readCastConfigJson(cast);
        configJson.name = nextName;
        configJson.color = nextColor;
        configJson.modified = new Date().toISOString();
        await fsp.writeFile(configPath, JSON.stringify(configJson, null, 2), 'utf8');
        cast.config = configJson;
        await manager.loadCasts();

        return {
          success: true,
          castId: cast.id,
          name: nextName,
          color: nextColor,
          systemPrompt: nextPrompt
        };
      }

      case 'listContext': {
        const cast = requireCast(manager, params.castId);
        const indexer = new ContextIndexer(cast);
        await indexer.initialize();

        const documents = indexer.listDocuments();
        const totalTokens = documents.reduce((sum, doc) => sum + (doc.tokenCount || 0), 0);

        let indexSize = '0 KB';
        try {
          const indexPath = path.join(cast.indexPath, 'inverted.json');
          const stats = await fsp.stat(indexPath);
          indexSize = `${(stats.size / 1024).toFixed(1)} KB`;
        } catch {
          // Keep default size value.
        }

        const snapshot = castCatalog ? await castCatalog.summarizeCast(cast) : null;
        return {
          success: true,
          documents,
          totalTokens,
          indexSize,
          contextCount: snapshot ? snapshot.contextCount : documents.length,
          indexedCount: snapshot ? snapshot.indexedCount : documents.length,
          staleContextIndex: snapshot ? snapshot.staleContextIndex : false,
        };
      }

      case 'getMemory': {
        const cast = requireCast(manager, params.castId);
        const result = await withScopedActiveCast(manager, cast, async () => {
          const router = new MemoryRouter(manager, { contextStore });
          await router.initialize();
          return router.getRecent({
            days: params.days,
            limit: params.limit,
          });
        });
        return { success: true, entries: result.entries };
      }

      case 'getConversationMemories': {
        const cast = requireCast(manager, params.castId);
        const response = await getConversationMemories(cast);
        const limit = Number.isFinite(params.limit) ? Number(params.limit) : 10;
        response.memories = response.memories.slice(0, limit);
        response.total = response.memories.length;
        return response;
      }

      case 'getHandoffs': {
        const cast = requireCast(manager, params.castId);
        const result = await withScopedActiveCast(manager, cast, async () => {
          const router = new MemoryRouter(manager, { contextStore });
          await router.initialize();
          return router.getHandoffs();
        });
        return { success: true, handoffs: result.handoffs };
      }

      case 'populate': {
        if (!params.castId) {
          throw new Error('castId is required');
        }
        const populator = new CastAutoPopulator(workspaceRoot);
        return await populator.populate(params.castId);
      }

      case 'createCast': {
        const cast = await manager.createCast(params.castId, params.templateId || 'default', {
          name: params.name,
          emoji: params.emoji,
          color: params.color,
          description: params.description,
        });
        await ensureCastConfigColor(cast, params.color);
        await maybeReconcileCast(cast);
        return {
          success: true,
          cast: {
            id: cast.id,
            name: cast.config && cast.config.name ? cast.config.name : cast.id,
            emoji: cast.config && cast.config.emoji ? cast.config.emoji : '🔹',
            color: ensureHexColor(cast.config && cast.config.color ? cast.config.color : '') || pickCastColor(cast.id),
            description: cast.config && cast.config.description ? cast.config.description : ''
          }
        };
      }

      case 'createCastByName': {
        const cast = await createCastByName(manager, params || {});
        await maybeReconcileCast(cast);
        return {
          success: true,
          cast: {
            id: cast.id,
            name: cast.config && cast.config.name ? cast.config.name : cast.id,
            emoji: cast.config && cast.config.emoji ? cast.config.emoji : '🔹',
            color: ensureHexColor(cast.config && cast.config.color ? cast.config.color : '') || pickCastColor(cast.id),
            description: cast.config && cast.config.description ? cast.config.description : ''
          }
        };
      }

      case 'deleteCast': {
        if (!params.castId) {
          throw new Error('castId is required');
        }
        const cast = requireCast(manager, params.castId);
        if (
          sharedConversation &&
          manager.getActiveCast() &&
          manager.getActiveCast().id === cast.id &&
          sharedConversationConfig.absorbScratchpadOnSwitch !== false
        ) {
          await sharedConversation.absorbCastSnapshot(cast, { reason: 'cast-delete' });
        }
        const result = await manager.deleteCast(cast.id, { allowActiveDelete: true });
        if (contextV2Enabled && contextStore) {
          await contextStore.addEpisodicEvent({
            type: 'cast_delete',
            text: `Deleted cast: ${cast.id}`,
            castId: cast.id,
            userId: params.userId || null,
            source: 'system'
          });
        }
        return {
          success: true,
          deletedCastId: result.deletedCastId,
          wasActive: !!result.wasActive
        };
      }

      case 'listFiles': {
        const cast = requireCast(manager, params.castId);
        const fileManager = new CastFileManager(cast);
        await fileManager.initialize();
        return await fileManager.listFiles(params.directory || 'documents');
      }

      case 'getFile': {
        const cast = requireCast(manager, params.castId);
        const fileManager = new CastFileManager(cast);
        return await fileManager.getFile(params.filePath);
      }

      case 'saveFile': {
        const cast = requireCast(manager, params.castId);
        const fileManager = new CastFileManager(cast);
        const result = await fileManager.saveFile(params.filePath, params.content || '');
        if (pathTouchesKnowledge(params.filePath)) {
          const indexer = new ContextIndexer(cast);
          await indexer.initialize();
          await indexer.indexDocument(fileManager.resolvePath(params.filePath));
          await indexer.saveIndex();
          await maybeReconcileCast(cast);
        }
        return result;
      }

      case 'deleteFile': {
        const cast = requireCast(manager, params.castId);
        const fileManager = new CastFileManager(cast);
        const result = await fileManager.deleteFile(params.filePath, { recursive: !!params.recursive });
        if (pathTouchesKnowledge(params.filePath)) {
          const indexer = new ContextIndexer(cast);
          await indexer.initialize();
          await indexer.removeDocument(params.filePath);
          await maybeReconcileCast(cast);
        }
        return result;
      }

      case 'createFolder': {
        const cast = requireCast(manager, params.castId);
        const fileManager = new CastFileManager(cast);
        return await fileManager.createFolder(params.folderPath);
      }

      case 'searchFiles': {
        const cast = requireCast(manager, params.castId);
        const fileManager = new CastFileManager(cast);
        return await fileManager.searchFiles(params.query, {
          directory: params.directory,
          searchContent: params.searchContent,
        });
      }

      case 'getFileTree': {
        const cast = requireCast(manager, params.castId);
        const fileManager = new CastFileManager(cast);
        return await fileManager.getFileTree(params.directory || 'documents');
      }

      case 'promoteToContext': {
        const cast = requireCast(manager, params.castId);
        const fileManager = new CastFileManager(cast);
        const fullPath = fileManager.resolvePath(params.filePath);

        if (!fullPath) {
          throw new Error('Invalid file path');
        }

        const filename = path.basename(params.filePath);
        const destinationDir = params.destination === 'context' ? cast.contextPath : cast.docsPath;
        const destination = path.join(destinationDir, filename);
        await fsp.copyFile(fullPath, destination);

        const indexer = new ContextIndexer(cast);
        await indexer.initialize();
        await indexer.indexDocument(destination);
        await indexer.saveIndex();
        await maybeReconcileCast(cast);

        return {
          success: true,
          message: destinationDir === cast.contextPath
            ? 'Document promoted to context and indexed'
            : 'Document promoted to docs and indexed',
          file: filename
        };
      }

      case 'getScratchpad': {
        const cast = requireCast(manager, params.castId);
        const memoryManager = new WorkingMemoryManager(cast.path, { contextStore, castId: cast.id });
        await memoryManager.initialize();
        const scratchpad = await memoryManager.getScratchpad();
        return { success: true, scratchpad };
      }

      case 'updateScratchpad': {
        const cast = requireCast(manager, params.castId);
        const memoryManager = new WorkingMemoryManager(cast.path, { contextStore, castId: cast.id });
        await memoryManager.initialize();
        const result = await memoryManager.updateScratchpad(
          params.section,
          params.content,
          !!params.append,
        );
        return { success: true, result };
      }

      case 'clearScratchpad': {
        const cast = requireCast(manager, params.castId);
        const memoryManager = new WorkingMemoryManager(cast.path, { contextStore, castId: cast.id });
        const result = await memoryManager.clearScratchpad();
        return { success: true, result };
      }

      case 'getUserMemory': {
        const cast = requireCast(manager, params.castId);
        const memoryManager = new WorkingMemoryManager(cast.path, { contextStore, castId: cast.id });
        await memoryManager.initialize();
        const userMemory = await memoryManager.getUserMemory(params.userId);
        return { success: true, userMemory };
      }

      case 'updateUserMemory': {
        const cast = requireCast(manager, params.castId);
        const memoryManager = new WorkingMemoryManager(cast.path, { contextStore, castId: cast.id });
        await memoryManager.initialize();
        const result = await memoryManager.updateUserMemory(
          params.userId,
          params.section,
          params.content,
          !!params.append,
        );
        return { success: true, result };
      }

      case 'autoCapture': {
        const cast = requireCast(manager, params.castId);
        const memoryManager = new WorkingMemoryManager(cast.path, { contextStore, castId: cast.id });
        await memoryManager.initialize();
        const result = await memoryManager.autoCapture(
          params.userId,
          params.message,
          params.response,
        );
        let shared = null;
        if (sharedConversation && sharedConversationConfig.captureOnAutoCapture !== false) {
          shared = await sharedConversation.captureTurn({
            castId: cast.id,
            userId: params.userId || 'unknown',
            message: params.message || '',
            response: params.response || ''
          });
        }
        return { success: true, result, sharedConversation: shared };
      }

      case 'captureConversationContext': {
        if (!sharedConversation) {
          return { success: true, disabled: true };
        }
        const castId = params.castId || (manager.getActiveCast() ? manager.getActiveCast().id : 'unknown');
        const capture = await sharedConversation.captureTurn({
          castId,
          userId: params.userId || 'unknown',
          message: params.message || '',
          response: params.response || ''
        });
        return { success: true, capture };
      }

      case 'getSharedConversationContext': {
        if (!sharedConversation) {
          return { success: true, disabled: true, context: null };
        }
        const context = await sharedConversation.getContext({
          limit: Number.isFinite(params.limit) ? Number(params.limit) : undefined
        });
        return { success: true, context };
      }

      case 'searchSharedConversationContext': {
        if (!sharedConversation) {
          return { success: true, disabled: true, results: [], total: 0 };
        }
        const query = String(params.query || '').trim();
        if (!query) {
          throw new Error('query is required');
        }
        const result = await sharedConversation.search(query, {
          limit: Number.isFinite(params.limit) ? Number(params.limit) : undefined
        });
        return { success: true, ...result };
      }

      case 'getPromptContext': {
        const cast = requireCast(manager, params.castId);
        const memoryManager = new WorkingMemoryManager(cast.path, { contextStore, castId: cast.id });
        await memoryManager.initialize();
        const context = await memoryManager.getContextForPrompt(params.userId);
        if (sharedConversation) {
          const shared = await sharedConversation.getContext({
            limit: Number.isFinite(sharedConversationConfig.contextLimit)
              ? Number(sharedConversationConfig.contextLimit)
              : 8
          });
          context.sharedConversation = shared.text;
          context.sharedConversationStructured = shared;
        }
        return { success: true, context };
      }

      case 'answerFromContext': {
        const cast = requireCast(manager, params.castId);
        const query = String(params.query || '').trim();
        if (!query) {
          throw new Error('query is required');
        }

        const indexer = new ContextIndexer(cast);
        await indexer.initialize();

        const searchResult = await indexer.search(query, {
          limit: Number.isFinite(params.limit) ? Number(params.limit) : 8,
          minScore: Number.isFinite(params.minScore) ? Number(params.minScore) : 0.1,
          rerankMode: retrievalConfig.rerank === 'agent' ? 'agent' : 'off',
          maxCandidates: Number.isFinite(retrievalConfig.maxCandidates)
            ? Number(retrievalConfig.maxCandidates)
            : 30,
        });
        const sharedSearch = sharedConversation
          ? await sharedConversation.search(query, {
              limit: Number.isFinite(sharedConversationConfig.searchLimit)
                ? Number(sharedConversationConfig.searchLimit)
                : 4
            })
          : { results: [], total: 0 };

        const sources = (searchResult.results || []).map((result) => ({
          docId: result.document.id,
          score: result.score,
          citation: result.citation || { docId: result.document.id, chunkId: null, start: 0 },
        }));
        for (const sharedHit of sharedSearch.results || []) {
          sources.push({
            docId: sharedHit.id,
            score: sharedHit.score,
            citation: { docId: sharedHit.id, chunkId: null, start: 0 },
            type: sharedHit.type
          });
        }

        const draftAnswer = searchResult.results.length > 0
          ? searchResult.results
              .slice(0, 4)
              .map((result, idx) => {
                const cite = result.citation && result.citation.chunkId !== null
                  ? `${result.citation.docId}#${result.citation.chunkId}`
                  : result.document.id;
                const snippet = String(result.excerpt || result.document.preview || '').replace(/\s+/g, ' ').trim();
                return `${idx + 1}. ${snippet} [${cite}]`;
              })
              .join('\n')
          : 'No relevant context snippets were found for this query.';
        const sharedSummary = (sharedSearch.results || []).length > 0
          ? `\n\nShared conversation signals:\n${sharedSearch.results
              .slice(0, 3)
              .map((hit, idx) => `${idx + 1}. (${hit.type}) ${hit.text}`)
              .join('\n')}`
          : '';

        return {
          success: true,
          mode: retrievalConfig.rerank === 'agent' ? 'agent-assisted' : 'hybrid-lite',
          query,
          draftAnswer: `${draftAnswer}${sharedSummary}`,
          sources,
          promptPack: buildAgentPromptPack(query, cast, searchResult, sharedSearch),
          retrieval: {
            total: searchResult.total,
            queryTime: searchResult.queryTime,
            rerankMode: searchResult.rerankMode,
            sharedHits: sharedSearch.total || 0
          },
          sharedConversation: sharedSearch
        };
      }

      default:
        return {
          success: false,
          error: `Unknown action: ${String(action || '')}`,
        };
    }
  };

  const callActionFromPayload = async (payload) => {
    if (!isObject(payload)) {
      throw new Error('Request payload must be an object');
    }
    const action = payload.action;
    if (!action || typeof action !== 'string') {
      throw new Error('action is required');
    }
    return handleAction(action, payload);
  };

  const chunkButtons = (items, perRow) => {
    const rows = [];
    for (let i = 0; i < items.length; i += perRow) {
      rows.push(items.slice(i, i + perRow));
    }
    return rows;
  };

  const buildCastButtonsPayload = async (manager, options = {}) => {
    const baseCasts = manager.listCasts();
    const active = manager.getActiveCast();
    const activeName = active
      ? (active.config && active.config.name ? active.config.name : active.id)
      : null;
    const casts = [];
    for (const castInfo of baseCasts) {
      casts.push(await enrichCastForList(manager, castInfo));
    }

    const buttons = chunkButtons(
      casts.map((cast) => {
        const label = `${cast.name}`.slice(0, 48);
        return {
          text: label,
          callback_data: `/cast s ${cast.id}`
        };
      }),
      2
    );

    const header = options.header || '🎭 Available casts';
    const activeLine = active ? `\nActive: ${activeName} (${active.id})` : '\nActive: none';
    const helpLine = '\nTap a cast button to switch.';
    const extraLines = Array.isArray(options.extraLines)
      ? options.extraLines.map((line) => String(line || '').trim()).filter(Boolean)
      : [];
    const extrasBlock = extraLines.length ? `\n\n${extraLines.join('\n')}` : '';
    const listLines = casts.map((cast) => {
      return `- ${cast.name} (${cast.id})`;
    });

    return {
      text: `${header}${activeLine}${extrasBlock}\n\n${listLines.join('\n')}${helpLine}`,
      channelData: {
        telegram: {
          buttons
        }
      }
    };
  };

  const normalizeOneLine = (value, maxLength = 160) => String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);

  const getLastNonCommandMessage = async () => {
    if (!sharedConversation) return '';
    try {
      const context = await sharedConversation.getContext({ limit: 12 });
      const turns = Array.isArray(context && context.recentTurns) ? context.recentTurns : [];
      for (const turn of turns) {
        const message = normalizeOneLine(turn && turn.message ? turn.message : '', 140);
        if (message && !message.startsWith('/')) {
          return message;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[CastSystem] Failed reading recent turns: ${message}`);
    }
    return '';
  };

  const buildSwitchExtras = async () => {
    const lastUserMessage = await getLastNonCommandMessage();
    const normalized = normalizeOneLine(lastUserMessage, 160).toLowerCase();

    if (!lastUserMessage) {
      return ['Great, we can continue. What should we tackle next?'];
    }

    if (
      normalized.endsWith('?') ||
      /^(how|what|why|can|could|should|is|are|do|does|did|where|when)\b/.test(normalized)
    ) {
      return ['Good question. Let’s pick up right there.'];
    }

    if (/(bug|error|issue|broken|fail|failing|fix)\b/.test(normalized)) {
      return ['Understood. Let’s continue and work through the fix.'];
    }

    if (/(build|create|implement|design|plan|refactor)\b/.test(normalized)) {
      return ['Perfect. Let’s continue and move this forward.'];
    }

    return ['Got it. Let’s continue from there.'];
  };

  const stripTrailingSlashes = (value) => String(value || '').replace(/\/+$/, '');

  const joinUrl = (base, suffix) => {
    const b = stripTrailingSlashes(base);
    const s = String(suffix || '').startsWith('/') ? String(suffix) : `/${suffix}`;
    return `${b}${s}`;
  };

  const resolveTelegramChatIdFromCtx = (ctx) => {
    const to = String(ctx && ctx.to ? ctx.to : '').trim();
    const match = to.match(/^telegram:(-?\d+)/);
    return match ? match[1] : null;
  };

  const getMiniappsBaseUrl = (cfg) => {
    const raw = cfg && cfg.plugins && cfg.plugins.entries && cfg.plugins.entries.miniapps
      && cfg.plugins.entries.miniapps.config
      ? cfg.plugins.entries.miniapps.config.baseUrl
      : null;
    return typeof raw === 'string' ? raw.trim() : '';
  };

  const getMiniappsAppsRoot = (cfg) => {
    const raw = cfg && cfg.plugins && cfg.plugins.entries && cfg.plugins.entries.miniapps
      && cfg.plugins.entries.miniapps.config
      ? cfg.plugins.entries.miniapps.config.appsRoot
      : null;
    if (typeof raw === 'string' && raw.trim()) {
      return raw.trim();
    }
    return '/home/talha/.openclaw/workspace/apps/miniapps';
  };

  const resolveCastManagerMiniappUrl = (cfg) => {
    const baseUrl = getMiniappsBaseUrl(cfg);
    if (!baseUrl) return '';

    // Fallback default when manifest is unavailable.
    let resolvedPath = '/cast-manager/';
    const appsRoot = getMiniappsAppsRoot(cfg);
    const manifestPath = path.join(appsRoot, 'cast-manager', 'app.json');

    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.url === 'string' && parsed.url.trim()) {
        resolvedPath = parsed.url.trim();
      }
    } catch {
      // Use fallback path.
    }

    if (!/^https?:\/\//i.test(baseUrl)) {
      return '';
    }

    // If manifest gives an absolute path (/apps/...), join with host origin.
    if (resolvedPath.startsWith('/')) {
      try {
        const origin = new URL(baseUrl).origin;
        return `${origin}${resolvedPath}`;
      } catch {
        return '';
      }
    }

    return joinUrl(baseUrl, resolvedPath);
  };

  const getTelegramBotToken = (cfg) => {
    const raw = cfg && cfg.channels && cfg.channels.telegram ? cfg.channels.telegram.botToken : null;
    return typeof raw === 'string' ? raw.trim() : '';
  };

  const sendTelegramWebAppButtonMessage = async (ctx, text, buttonText, webAppUrl) => {
    const cfg = ctx && ctx.config ? ctx.config : {};
    const token = getTelegramBotToken(cfg);
    if (!token) {
      throw new Error('Telegram bot token is not configured');
    }

    const chatId = resolveTelegramChatIdFromCtx(ctx);
    if (!chatId) {
      throw new Error('Could not resolve Telegram chat id from context');
    }

    const payload = {
      chat_id: chatId,
      text: String(text || ''),
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[{ text: String(buttonText || 'Open'), web_app: { url: String(webAppUrl) } }]]
      }
    };

    if (ctx && ctx.messageThreadId !== undefined && ctx.messageThreadId !== null && ctx.messageThreadId !== '') {
      const n = Number(ctx.messageThreadId);
      if (Number.isFinite(n)) {
        payload.message_thread_id = Math.trunc(n);
      }
    }

    const sendPayload = async (value) => {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value)
      });
      const data = await response.json().catch(() => null);
      return { response, data };
    };

    const firstTry = await sendPayload(payload);
    if (firstTry.response.ok && firstTry.data && firstTry.data.ok) {
      return;
    }

    const firstError = firstTry.data && firstTry.data.description
      ? String(firstTry.data.description)
      : `HTTP ${firstTry.response.status}`;

    // Telegram often rejects web_app buttons in group contexts with BUTTON_TYPE_INVALID.
    if (/BUTTON_TYPE_INVALID/i.test(firstError)) {
      const fallbackPayload = {
        ...payload,
        text: `${String(text || '')}\n${String(webAppUrl)}`,
        reply_markup: {
          inline_keyboard: [[{ text: String(buttonText || 'Open Cast Manager'), url: String(webAppUrl) }]]
        }
      };
      const secondTry = await sendPayload(fallbackPayload);
      if (secondTry.response.ok && secondTry.data && secondTry.data.ok) {
        return;
      }
      const secondError = secondTry.data && secondTry.data.description
        ? String(secondTry.data.description)
        : `HTTP ${secondTry.response.status}`;
      throw new Error(`Telegram sendMessage failed: ${secondError}`);
    }

    throw new Error(`Telegram sendMessage failed: ${firstError}`);
  };

  const buildCastMenuPayload = (manager) => {
    const active = manager.getActiveCast();
    const mode = active ? 'ON' : 'OFF';
    const activeName = active
      ? `${active.config && active.config.name ? active.config.name : active.id} (${active.id})`
      : 'none (default agent persona)';

    const lines = [
      '🎭 Cast command menu',
      `Cast mode: ${mode}`,
      `Current cast: ${activeName}`,
      '',
      '/cast - show this menu with all command forms',
      '/cast list - show clickable buttons for available casts',
      '/cast switch <castId> - switch to a cast',
      '/cast manager - open Cast Manager miniapp',
      '/cast edit [castId] - open cast editor actions',
      '/cast setprompt <castId> <text> - replace cast profile prompt',
      '/cast doc <list|add|rm> <castId> ... - manage cast docs',
      '/cast id - show current cast and ingested/saved document names',
      '/cast exit - leave cast mode and return to default agent persona'
    ];
    return { text: lines.join('\n') };
  };

  const resolveCastForEdit = (manager, castIdMaybe) => {
    if (castIdMaybe) {
      const cast = manager.getCast(castIdMaybe);
      if (!cast) {
        throw new Error(`Cast "${castIdMaybe}" not found`);
      }
      return cast;
    }
    const active = manager.getActiveCast();
    if (!active) {
      throw new Error('No active cast. Use /cast switch <castId> first, or pass a castId explicitly.');
    }
    return active;
  };

  const buildCastEditPanel = async (manager, castIdMaybe) => {
    if (!castIdMaybe && !manager.getActiveCast()) {
      const choices = manager.listCasts();
      const buttons = chunkButtons(
        choices.map((cast) => ({
          text: String(cast.name || cast.id || 'cast').slice(0, 48),
          callback_data: `/cast edit ${cast.id}`
        })),
        2
      );
      return {
        text: [
          '🛠️ Cast editor',
          'No active cast selected.',
          '',
          'Pick a cast to edit:',
          ...choices.map((cast) => `- ${cast.name} (${cast.id})`)
        ].join('\n'),
        channelData: {
          telegram: {
            buttons
          }
        }
      };
    }

    const cast = resolveCastForEdit(manager, castIdMaybe);
    const castId = cast.id;
    const castName = cast.config && cast.config.name ? cast.config.name : castId;
    const profileResult = await handleAction('getProfile', { castId }).catch(() => ({ profile: { content: '' } }));
    const profilePreview = normalizeOneLine(
      String(profileResult && profileResult.profile && profileResult.profile.content ? profileResult.profile.content : '')
        .replace(/^---[\s\S]*?---\s*/m, ''),
      220
    );

    const lines = [
      `🛠️ Cast editor: ${castName} (${castId})`,
      '',
      `Prompt preview: ${profilePreview || '(empty)'}`,
      '',
      'Actions:',
      `- /cast edit prompt ${castId}`,
      `- /cast edit docs ${castId}`,
      `- /cast id`,
    ];

    return {
      text: lines.join('\n'),
      channelData: {
        telegram: {
          buttons: [
            [{ text: 'Edit Persona', callback_data: `/cast edit prompt ${castId}` }],
            [{ text: 'Manage Docs', callback_data: `/cast edit docs ${castId}` }],
            [{ text: 'View Summary', callback_data: `/cast id` }],
          ]
        }
      }
    };
  };

  const buildPromptEditorPayload = async (manager, castIdMaybe) => {
    const cast = resolveCastForEdit(manager, castIdMaybe);
    const castId = cast.id;
    const castName = cast.config && cast.config.name ? cast.config.name : castId;
    const profileResult = await handleAction('getProfile', { castId }).catch(() => ({ profile: { content: '' } }));
    const profileText = String(profileResult && profileResult.profile && profileResult.profile.content ? profileResult.profile.content : '');
    const profilePreview = normalizeOneLine(profileText.replace(/^---[\s\S]*?---\s*/m, ''), 300);

    return {
      text: [
        `✍️ Persona editor: ${castName} (${castId})`,
        '',
        `Current prompt preview: ${profilePreview || '(empty)'}`,
        '',
        'Replace prompt:',
        `/cast setprompt ${castId} <new prompt text>`,
      ].join('\n')
    };
  };

  const listAllDocItems = async (castId) => {
    const [contextList, docsList, documentsList] = await Promise.all([
      handleAction('listFiles', { castId, directory: 'context' }).catch(() => ({ items: [] })),
      handleAction('listFiles', { castId, directory: 'docs' }).catch(() => ({ items: [] })),
      handleAction('listFiles', { castId, directory: 'documents' }).catch(() => ({ items: [] })),
    ]);
    return [contextList, docsList, documentsList]
      .flatMap((row) => Array.isArray(row && row.items) ? row.items : [])
      .filter((item) => item && item.type === 'file' && item.name && item.path);
  };

  const buildDocsEditorPayload = async (manager, castIdMaybe) => {
    const cast = resolveCastForEdit(manager, castIdMaybe);
    const castId = cast.id;
    const castName = cast.config && cast.config.name ? cast.config.name : castId;
    const items = await listAllDocItems(castId);
    const uniqueNames = Array.from(new Set(items.map((item) => item.name))).sort((a, b) => a.localeCompare(b));
    const shown = uniqueNames.slice(0, 20).map((name) => `- ${name}`);
    const more = uniqueNames.length > 20 ? [`- ...and ${uniqueNames.length - 20} more`] : [];

    return {
      text: [
        `📚 Docs editor: ${castName} (${castId})`,
        '',
        `Files (${uniqueNames.length}):`,
        ...(shown.length ? shown : ['- none']),
        ...more,
        '',
        'Commands:',
        `/cast doc list ${castId}`,
        `/cast doc add ${castId} <title> | <content>`,
        `/cast doc rm ${castId} <filename>`,
      ].join('\n')
    };
  };

  const parseSetPromptArgs = (rawArgs) => {
    const match = String(rawArgs || '').match(/^setprompt\s+(\S+)\s+([\s\S]+)$/i);
    if (!match) return null;
    return { castId: match[1], content: match[2].trim() };
  };

  const parseDocAddArgs = (rawArgs) => {
    const match = String(rawArgs || '').match(/^doc\s+add\s+(\S+)\s+([\s\S]+)$/i);
    if (!match) return null;
    const castId = match[1];
    const remainder = match[2].trim();
    const pipeIdx = remainder.indexOf('|');
    if (pipeIdx < 0) return { castId, title: '', content: '' };
    return {
      castId,
      title: remainder.slice(0, pipeIdx).trim(),
      content: remainder.slice(pipeIdx + 1).trim()
    };
  };

  const toSafeDocSlug = (value) => {
    const slug = String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    return slug || `note-${Date.now()}`;
  };

  const findDocPathByName = async (castId, fileName) => {
    const target = String(fileName || '').trim();
    if (!target) return null;
    const items = await listAllDocItems(castId);
    const exact = items.find((item) => item.name === target);
    if (exact) return exact.path;
    const loose = items.find((item) => item.name.toLowerCase() === target.toLowerCase());
    return loose ? loose.path : null;
  };

  const buildCastIdPayload = async (manager) => {
    const active = manager.getActiveCast();
    if (!active) {
      return {
        text: [
          '🆔 Cast details',
          'Current cast: none (default agent persona)',
          '',
          'Tool policy:',
          '- all tools allowed',
          '',
          'Documents:',
          '- none'
        ].join('\n')
      };
    }

    const castId = active.id;
    const castName = active.config && active.config.name ? active.config.name : castId;
    const [contextList, docsList, documentsList, indexedList] = await Promise.all([
      handleAction('listFiles', { castId, directory: 'context' }).catch(() => ({ items: [] })),
      handleAction('listFiles', { castId, directory: 'docs' }).catch(() => ({ items: [] })),
      handleAction('listFiles', { castId, directory: 'documents' }).catch(() => ({ items: [] })),
      handleAction('listContext', { castId }).catch(() => ({ documents: [] })),
    ]);

    const names = new Set();
    const addName = (name) => {
      const normalized = normalizeOneLine(name, 200);
      if (!normalized) return;
      names.add(normalized);
    };

    for (const row of [contextList, docsList, documentsList]) {
      const items = Array.isArray(row && row.items) ? row.items : [];
      for (const item of items) {
        if (item && item.type === 'file' && item.name) {
          addName(item.name);
        }
      }
    }

    const indexedDocs = Array.isArray(indexedList && indexedList.documents) ? indexedList.documents : [];
    for (const doc of indexedDocs) {
      if (doc && doc.id) {
        addName(path.basename(String(doc.id)));
      }
    }

    const sortedNames = Array.from(names).sort((a, b) => a.localeCompare(b));
    const docLines = sortedNames.length
      ? sortedNames.map((name) => `- ${name}`)
      : ['- none'];
    const toolPolicy = getCastToolPolicy(active.config || {});
    const toolLines = toolPolicy.mode === 'allowlist' && toolPolicy.allowedTools.length > 0
      ? toolPolicy.allowedTools.map((toolId) => `- ${toolId}`)
      : ['- all tools allowed'];

    return {
      text: [
        '🆔 Cast details',
        `Current cast: ${castName} (${castId})`,
        '',
        'Tool policy:',
        ...toolLines,
        '',
        `Documents (${sortedNames.length}):`,
        ...docLines
      ].join('\n')
    };
  };

  const clearActiveCast = async (manager, userId) => {
    const active = manager.getActiveCast();
    if (!active) {
      return { success: true, alreadyDefault: true };
    }

    const previousId = active.id;
    manager.activeCast = null;
    if (manager.stateManager && typeof manager.stateManager.clearActiveCast === 'function') {
      await manager.stateManager.clearActiveCast();
    } else if (manager.stateManager && typeof manager.stateManager.setActiveCast === 'function') {
      await manager.stateManager.setActiveCast(null);
    }
    if (sharedConversation) {
      await sharedConversation.captureSwitch({
        from: previousId,
        to: null,
        userId: userId || null
      });
    }
    return { success: true, previousId };
  };

  api.registerCommand({
    name: 'cast',
    description: 'Cast control: /cast list or /cast switch <castId>',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      try {
        const manager = await ensureInitialized();
        const incomingArgs = String(ctx && ctx.args ? ctx.args : '').trim();
        const rawArgs = incomingArgs.replace(/^\/?cast(?:@[a-z0-9_]+)?\s*/i, '').trim();
        const args = rawArgs.split(/\s+/).filter(Boolean);
        const sub = (args[0] || '').toLowerCase();
        const channel = String((ctx && ctx.channel) || '').toLowerCase();

        if (!rawArgs) {
          return buildCastMenuPayload(manager);
        }

        if (sub === 'list' || sub === 'ls') {
          const payload = await buildCastButtonsPayload(manager);
          if (channel === 'telegram') {
            return payload;
          }
          return { text: payload.text };
        }

        if (sub === 'switch' || sub === 's') {
          const isButtonSwitch = sub === 's';
          const castId = args[1];
          if (!castId) {
            return { text: 'Usage: /cast switch <castId>' };
          }

          const result = await handleAction('switchCast', {
            castId,
            userId: ctx && ctx.senderId ? String(ctx.senderId) : null
          });

          if (!result.success) {
            return { text: `Failed to switch cast: ${result.error || castId}` };
          }

          const extras = await buildSwitchExtras(result);
          if (isButtonSwitch) {
            return {
              text: [
                `✅ Switched to ${result.cast.name} (${result.cast.id})`,
                'Cast mode: ON',
                ...extras
              ].join('\n')
            };
          }

          const payload = await buildCastButtonsPayload(manager, {
            header: `✅ Switched to ${result.cast.name} (${result.cast.id})`,
            extraLines: ['Cast mode: ON', ...extras]
          });
          if (channel === 'telegram') {
            return payload;
          }
          return { text: payload.text };
        }

        if (sub === 'manager') {
          const managerUrl = resolveCastManagerMiniappUrl(ctx && ctx.config ? ctx.config : null);
          if (!managerUrl) {
            return { text: 'Cast manager is not configured yet. Set plugins.entries.miniapps.config.baseUrl first.' };
          }

          if (!/^https:\/\//i.test(managerUrl)) {
            return { text: `Cast manager URL must be HTTPS for Telegram mini apps. Current: ${managerUrl}` };
          }

          if (channel === 'telegram') {
            await sendTelegramWebAppButtonMessage(
              ctx,
              'Open Cast Manager:',
              'Open Cast Manager',
              managerUrl
            );
            // Message already sent manually to support Telegram web_app buttons.
            return { text: '' };
          }

          return { text: `Cast manager: ${managerUrl}` };
        }

        if (sub === 'id' || sub === 'info') {
          return await buildCastIdPayload(manager);
        }

        if (sub === 'edit') {
          const editMode = (args[1] || '').toLowerCase();
          const editCastId = args[2] || (editMode && !['prompt', 'docs'].includes(editMode) ? args[1] : '');
          if (!editMode || editMode === 'panel' || !['prompt', 'docs'].includes(editMode)) {
            const payload = await buildCastEditPanel(manager, editCastId);
            if (channel === 'telegram') return payload;
            return { text: payload.text };
          }
          if (editMode === 'prompt') {
            return await buildPromptEditorPayload(manager, editCastId);
          }
          if (editMode === 'docs') {
            return await buildDocsEditorPayload(manager, editCastId);
          }
          return { text: 'Usage: /cast edit [castId] OR /cast edit <prompt|docs> [castId]' };
        }

        if (sub === 'setprompt') {
          const parsed = parseSetPromptArgs(rawArgs);
          if (!parsed || !parsed.castId || !parsed.content) {
            return { text: 'Usage: /cast setprompt <castId> <new prompt text>' };
          }
          await handleAction('saveProfile', {
            castId: parsed.castId,
            content: parsed.content
          });
          return { text: `✅ Updated prompt for ${parsed.castId}.` };
        }

        if (sub === 'doc') {
          const op = (args[1] || '').toLowerCase();
          const castId = args[2];
          if (!op || !castId) {
            return { text: 'Usage: /cast doc <list|add|rm> <castId> ...' };
          }
          if (op === 'list') {
            return await buildDocsEditorPayload(manager, castId);
          }
          if (op === 'add') {
            const parsed = parseDocAddArgs(rawArgs);
            if (!parsed || !parsed.title || !parsed.content) {
              return { text: 'Usage: /cast doc add <castId> <title> | <content>' };
            }
            const fileName = `${toSafeDocSlug(parsed.title)}.md`;
            const filePath = `context/${fileName}`;
            const markdown = `# ${parsed.title}\n\n${parsed.content}\n`;
            await handleAction('saveFile', { castId, filePath, content: markdown });
            return { text: `✅ Added document ${fileName} to ${castId}.` };
          }
          if (op === 'rm' || op === 'remove' || op === 'del' || op === 'delete') {
            const fileName = args.slice(3).join(' ').trim();
            if (!fileName) {
              return { text: 'Usage: /cast doc rm <castId> <filename>' };
            }
            const filePath = await findDocPathByName(castId, fileName);
            if (!filePath) {
              return { text: `Could not find "${fileName}" in ${castId}.` };
            }
            await handleAction('deleteFile', { castId, filePath });
            return { text: `✅ Removed ${fileName} from ${castId}.` };
          }
          return { text: 'Usage: /cast doc <list|add|rm> <castId> ...' };
        }

        if (sub === 'exit') {
          const exitResult = await clearActiveCast(
            manager,
            ctx && ctx.senderId ? String(ctx.senderId) : null
          );
          if (exitResult.alreadyDefault) {
            return { text: 'ℹ️ Cast mode is already OFF. Default agent persona is active.' };
          }
          return { text: `✅ Cast mode OFF. Exited "${exitResult.previousId}" and returned to the default agent persona.` };
        }

        return {
          text: 'Unknown cast command.\nUse /cast to see all command forms.'
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[CastSystem] /cast command failed: ${message}`);
        return { text: `Cast command failed: ${message}` };
      }
    }
  });

  api.registerCommand({
    name: 'castctx',
    description: 'Context V2 control: rules, session, conflicts',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      try {
        await ensureInitialized();
        if (!contextV2Enabled || !contextStore) {
          return { text: 'Context V2 is disabled.' };
        }

        const incomingArgs = String(ctx && ctx.args ? ctx.args : '').trim();
        const rawArgs = incomingArgs.replace(/^\/?(?:castctx|context)(?:@[a-z0-9_]+)?\s*/i, '').trim();
        const args = rawArgs.split(/\s+/).filter(Boolean);
        const sub = (args[0] || 'show').toLowerCase();
        const senderId = ctx && ctx.senderId ? String(ctx.senderId) : null;
        const activeCast = castManager && castManager.getActiveCast ? castManager.getActiveCast() : null;
        const activeCastId = activeCast ? activeCast.id : null;

        if (sub === 'show') {
          const snapshot = await contextStore.getContextSnapshot({
            castId: activeCastId,
            userId: senderId
          });
          const assembled = contextAssembler.assemble(snapshot, {
            tokenBudget: Number.isFinite(contextV2Config.tokenBudget) ? Number(contextV2Config.tokenBudget) : undefined
          });
          return {
            text: [
              `Context V2 (${assembled.intentState})`,
              '',
              assembled.assembledText,
              '',
              `Token estimate: ${assembled.tokenEstimate}`
            ].join('\n')
          };
        }

        if (sub === 'rules') {
          const rules = await contextStore.listContractRules();
          const lines = rules.length
            ? rules.slice(0, 30).map((rule) => `- [${rule.id}] ${rule.text}${rule.status === 'conflicted' ? ' (conflicted)' : ''}`)
            : ['- none'];
          return { text: ['Contract rules:', ...lines].join('\n') };
        }

        if (sub === 'set-rule') {
          const text = rawArgs.replace(/^set-rule\s+/i, '').trim();
          if (!text) return { text: 'Usage: /context set-rule <text>' };
          const result = await handleAction('setContractRule', {
            text,
            castId: activeCastId,
            userId: senderId
          });
          if (result.pending) {
            return { text: 'Contract candidate captured as pending (confidence below threshold).' };
          }
          return { text: `Rule saved: ${result.rule.id}` };
        }

        if (sub === 'remove-rule') {
          const selector = rawArgs.replace(/^remove-rule\s+/i, '').trim();
          if (!selector) return { text: 'Usage: /context remove-rule <id|match>' };
          const result = await handleAction('removeContractRule', { selector, userId: senderId });
          if (!result.removed) return { text: 'Rule not found.' };
          return { text: `Removed rule: ${result.rule.id}` };
        }

        if (sub === 'session') {
          const op = (args[1] || 'show').toLowerCase();
          if (op === 'show') {
            const snapshot = await contextStore.getContextSnapshot({
              castId: activeCastId,
              userId: senderId
            });
            const lines = [
              `Intent state: ${snapshot.intentState}`,
              `Objective: ${contextStore.session.objective || '(none)'}`,
              'Acceptance criteria:',
              ...(contextStore.session.acceptanceCriteria.length
                ? contextStore.session.acceptanceCriteria.map((item) => `- ${item}`)
                : ['- none'])
            ];
            return { text: lines.join('\n') };
          }

          if (op === 'set') {
            const field = (args[2] || '').toLowerCase();
            const remainder = rawArgs.replace(/^session\s+set\s+\S+\s*/i, '').trim();
            if (!field || !remainder) {
              return { text: 'Usage: /context session set <objective|criteria|state> <value>' };
            }
            if (field === 'objective') {
              await handleAction('setSessionFrame', { objective: remainder, castId: activeCastId, userId: senderId });
              return { text: 'Session objective updated.' };
            }
            if (field === 'criteria') {
              const criteria = remainder.split('|').map((item) => item.trim()).filter(Boolean);
              await handleAction('setSessionFrame', { acceptanceCriteria: criteria, castId: activeCastId, userId: senderId });
              return { text: 'Session acceptance criteria updated.' };
            }
            if (field === 'state') {
              await handleAction('setIntentState', { state: remainder, castId: activeCastId, userId: senderId });
              return { text: `Intent state updated to ${remainder}.` };
            }
            return { text: 'Usage: /context session set <objective|criteria|state> <value>' };
          }
        }

        if (sub === 'sheet') {
          const op = (args[1] || 'show').toLowerCase();
          if (op === 'show') {
            const result = await handleAction('getSharedContextSheet', {
              castId: activeCastId,
              userId: senderId
            });
            return {
              text: [
                `Shared Context Sheet (${result.sheet && result.sheet.source ? result.sheet.source : 'unknown'})`,
                '',
                result.sheet && result.sheet.text ? result.sheet.text : '(empty)'
              ].join('\n')
            };
          }

          if (op === 'set' || op === 'append') {
            const content = rawArgs.replace(/^sheet\s+(?:set|append)\s+/i, '').trim();
            if (!content) return { text: 'Usage: /context sheet <set|append> <content>' };
            await handleAction('updateSharedContextSheet', {
              castId: activeCastId,
              userId: senderId,
              mode: op === 'append' ? 'append' : 'replace',
              content
            });
            return { text: `Shared context sheet ${op === 'append' ? 'appended' : 'updated'}.` };
          }

          if (op === 'edit') {
            const prompt = rawArgs.replace(/^sheet\s+edit\s+/i, '').trim();
            if (!prompt) return { text: 'Usage: /context sheet edit <instruction>' };
            const result = await handleAction('applyContextPromptEdit', {
              castId: activeCastId,
              userId: senderId,
              prompt
            });
            if (result.applied) return { text: 'Shared context sheet updated from prompt.' };
            if (result.pending) return { text: 'Prompt captured as pending shared-sheet edit candidate.' };
            return { text: 'No shared-sheet edit intent detected.' };
          }

          return { text: 'Usage: /context sheet <show|set|append|edit> ...' };
        }

        if (sub === 'conflicts') {
          const conflicts = await contextStore.getConflicts();
          const open = conflicts.filter((item) => item.status === 'open');
          const lines = open.length
            ? open.slice(0, 20).map((item) => `- [${item.id}] ${item.reason} (sim=${Number(item.similarity || 0).toFixed(2)})`)
            : ['- none'];
          return { text: ['Open conflicts:', ...lines].join('\n') };
        }

        if (sub === 'resolve') {
          const conflictId = args[1];
          const strategy = args[2] || 'keepA';
          const mergeText = rawArgs.replace(/^resolve\s+\S+\s+\S+\s*/i, '').trim();
          if (!conflictId) return { text: 'Usage: /context resolve <conflictId> <keepA|keepB|merge> [mergeText]' };
          const result = await handleAction('resolveContextConflict', {
            conflictId,
            strategy,
            mergeText,
            castId: activeCastId,
            userId: senderId
          });
          if (!result.resolved) return { text: 'Conflict not found or already resolved.' };
          return { text: `Resolved conflict ${conflictId} using ${strategy}.` };
        }

        return {
          text: 'Usage:\n/context show\n/context rules\n/context set-rule <text>\n/context remove-rule <id|match>\n/context session show\n/context session set <objective|criteria|state> <value>\n/context sheet show\n/context sheet set <content>\n/context sheet append <content>\n/context sheet edit <instruction>\n/context conflicts\n/context resolve <conflictId> <keepA|keepB|merge>'
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[CastSystem] /context command failed: ${message}`);
        return { text: `Context command failed: ${message}` };
      }
    }
  });

  let lastCastModeState = 'unknown';

  const beforeAgentStartCastHook = async (event) => {
    try {
      const manager = await ensureInitialized();
      const castModeState = manager.getActiveCast() ? 'on' : 'off';
      if (castModeState !== lastCastModeState) {
        logger.info(`[CastSystem] Cast mode transition: ${lastCastModeState} -> ${castModeState}`);
        lastCastModeState = castModeState;
      }
      let prependContext = await buildDeterministicCastPrepend(manager, event || {});
      if (contextV2Enabled && contextStore && contextAssembler) {
        const active = manager.getActiveCast();
        const userId = event && event.userId ? String(event.userId) : null;
        if (Array.isArray(event && event.messages) && event.messages.length > 1) {
          await contextStore.captureLatestTurnFromMessages(event.messages, {
            castId: active ? active.id : null,
            userId
          });
        }
        const lastMessage = Array.isArray(event && event.messages) && event.messages.length > 0
          ? event.messages[event.messages.length - 1]
          : null;
        const query = extractMessageText(lastMessage || '');
        const snapshot = await contextStore.getContextSnapshot({
          castId: active ? active.id : null,
          userId,
          query
        });
        const assembled = contextAssembler.assemble(snapshot, {
          tokenBudget: Number.isFinite(contextV2Config.tokenBudget) ? Number(contextV2Config.tokenBudget) : undefined
        });
        prependContext = `${prependContext}\n\n[CONTEXT V2]\n${assembled.assembledText}`;
      }
      return { prependContext };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[CastSystem] before_agent_start hook failed: ${message}`);
      return;
    }
  };

  if (typeof api.on === 'function') {
    api.on('before_agent_start', beforeAgentStartCastHook);
  } else if (typeof api.registerHook === 'function') {
    api.registerHook('before_agent_start', beforeAgentStartCastHook, {
      name: 'cast-system-hard-switch'
    });
  } else {
    logger.warn('[CastSystem] Hook API unavailable; deterministic cast injection disabled');
  }

  api.registerGatewayMethod('clawcast.api', async ({ params, body, respond }) => {
    try {
      const payload = isObject(params) ? params : isObject(body) ? body : {};
      const result = await callActionFromPayload(payload);
      respond(true, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[CastSystem] gateway action failed: ${message}`);
      respond(false, { success: false, error: message });
    }
  });

  api.registerHttpHandler(async (req, res) => {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;

    if (pathname === '/health' && method === 'GET') {
      sendJson(res, 200, {
        status: 'ok',
        plugin: 'clawcast',
        timestamp: Date.now(),
      });
      return true;
    }

    if (pathname === '/api/cast-manager') {
      if (method !== 'POST') {
        sendJson(res, 405, { success: false, error: 'Method not allowed' });
        return true;
      }

      try {
        const payload = await readJsonBody(req);
        const result = await callActionFromPayload(payload);
        sendJson(res, 200, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 400, { success: false, error: message });
      }
      return true;
    }

    if (pathname === '/api/cast-manager/agent-upload') {
      if (method !== 'POST') {
        sendJson(res, 405, { success: false, error: 'Method not allowed' });
        return true;
      }

      try {
        const payload = await readJsonBody(req);
        const manager = await ensureInitialized();
        const cast = requireCast(manager, payload.castId);

        if (!payload.filename || typeof payload.filename !== 'string') {
          throw new Error('filename is required');
        }

        if (typeof payload.content !== 'string') {
          throw new Error('content is required');
        }

        const fileManager = new CastFileManager(cast);
        await fileManager.initialize();
        const targetPath = path.join(resolveKnowledgeDirectory(payload.directory), payload.filename);
        const result = await fileManager.saveFile(targetPath, payload.content);
        if (pathTouchesKnowledge(targetPath)) {
          const indexer = new ContextIndexer(cast);
          await indexer.initialize();
          await indexer.indexDocument(fileManager.resolvePath(targetPath));
          await indexer.saveIndex();
          await maybeReconcileCast(cast);
        }

        sendJson(res, 200, { success: true, file: result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 400, { success: false, error: message });
      }
      return true;
    }

    if (pathname === '/api/cast-manager/promote-to-context') {
      if (method !== 'POST') {
        sendJson(res, 405, { success: false, error: 'Method not allowed' });
        return true;
      }

      try {
        const payload = await readJsonBody(req);
        const result = await handleAction('promoteToContext', payload);
        sendJson(res, 200, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 400, { success: false, error: message });
      }
      return true;
    }

    if (pathname === '/api/cast-manager/upload') {
      if (method !== 'POST') {
        sendJson(res, 405, { success: false, error: 'Method not allowed' });
        return true;
      }

      try {
        const { fields, files } = await parseMultipart(req);
        const manager = await ensureInitialized();
        const cast = requireCast(manager, fields.castId);
        const directory = resolveKnowledgeDirectory(fields.directory);

        if (!files.length) {
          throw new Error('No files provided');
        }

        const fileManager = new CastFileManager(cast);
        await fileManager.initialize();

        const uploaded = [];
        for (const file of files) {
          const result = await fileManager.uploadFile(directory, file.filename, file.content, {
            index: pathTouchesKnowledge(directory),
          });
          uploaded.push(result);
        }

        if (pathTouchesKnowledge(directory)) {
          await maybeReconcileCast(cast);
        }

        sendJson(res, 200, {
          success: true,
          uploaded: uploaded.length,
          files: uploaded,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 400, { success: false, error: message });
      }
      return true;
    }

    if (method === 'GET' && (pathname === '/cast-manager' || pathname.startsWith('/cast-manager/'))) {
      await serveStatic(path.join(staticRoot, 'cast-manager'), pathname, '/cast-manager', res);
      return true;
    }

    if (method === 'GET' && (pathname === '/cast-system' || pathname.startsWith('/cast-system/'))) {
      const suffix = pathname.slice('/cast-system'.length) || '/';
      const targetPath = suffix === '/' ? '/cast-manager/' : '/cast-manager' + suffix;
      const target = targetPath + (url.search || '');
      res.statusCode = 302;
      res.setHeader('Location', target);
      res.end('');
      return true;
    }

    return false;
  });

  api.registerTool({
    name: 'cast_system_status',
    description: 'Check Cast System plugin status and list casts',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    async execute() {
      const manager = await ensureInitialized();
      const payload = await handleAction('listCasts', {});
      const casts = payload.casts || [];
      const active = manager.getActiveCast();
      const castList = casts.length
        ? casts.map((cast) => `${cast.name} (${cast.id}, docs=${cast.contextCount})`).join(', ')
        : 'none';

      return {
        content: [
          {
            type: 'text',
            text: `Cast System ready. Active: ${active ? active.id : 'none'}. Casts: ${castList}`,
          },
        ],
      };
    },
  });

  api.registerTool({
    name: 'cast_system_switch',
    description: 'Switch active cast persona',
    parameters: {
      type: 'object',
      properties: {
        castId: { type: 'string' },
      },
      required: ['castId'],
    },
    async execute(_toolCallId, params) {
      try {
        const result = await handleAction('switchCast', params || {});
        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? `Switched to ${result.cast.name} (${result.cast.id}).`
                : `Failed: ${result.error}`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Failed: ${message}` }] };
      }
    },
  });

  api.registerTool({
    name: 'cast_system_get_context',
    description: 'Get formatted prompt context for cast + user',
    parameters: {
      type: 'object',
      properties: {
        castId: { type: 'string' },
        userId: { type: 'string' },
      },
      required: ['castId', 'userId'],
    },
    async execute(_toolCallId, params) {
      try {
        const result = await handleAction('getPromptContext', params || {});
        if (!result.success) {
          return { content: [{ type: 'text', text: `Failed: ${result.error}` }] };
        }

        const context = result.context || {};
        return {
          content: [
            {
              type: 'text',
              text: `Working memory:\n${context.workingMemory || ''}\n\nUser context:\n${context.userContext || ''}\n\nShared conversation:\n${context.sharedConversation || ''}`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Failed: ${message}` }] };
      }
    },
  });

  api.registerTool({
    name: 'cast_system_get_shared_context',
    description: 'Get shared conversation context across all casts',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
      },
      required: [],
    },
    async execute(_toolCallId, params) {
      try {
        const result = await handleAction('getSharedConversationContext', params || {});
        if (!result.success) {
          return { content: [{ type: 'text', text: `Failed: ${result.error}` }] };
        }
        const context = result.context || {};
        return {
          content: [
            {
              type: 'text',
              text: context.text || 'No shared conversation context yet.',
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Failed: ${message}` }] };
      }
    },
  });

  api.registerTool({
    name: 'cast_system_answer_from_context',
    description: 'Retrieve cast context and build an evidence pack for an answer',
    parameters: {
      type: 'object',
      properties: {
        castId: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['castId', 'query'],
    },
    async execute(_toolCallId, params) {
      try {
        const result = await handleAction('answerFromContext', params || {});
        if (!result.success) {
          return { content: [{ type: 'text', text: `Failed: ${result.error}` }] };
        }
        return {
          content: [
            {
              type: 'text',
              text: `Draft answer:\n${result.draftAnswer}\n\nSources:\n${result.sources.map((s) => `- ${s.docId} (score ${Number(s.score || 0).toFixed(3)})`).join('\n')}`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Failed: ${message}` }] };
      }
    },
  });

  api.registerService({
    id: 'clawcast',
    start: async () => {
      try {
        await ensureInitialized();
        logger.info('[CastSystem] service started');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[CastSystem] service init failed: ${message}`);
      }
    },
    stop: () => {
      logger.info('[CastSystem] service stopped');
    },
  });

  logger.info('[CastSystem] plugin registered');

  return {
    id: 'clawcast',
    name: 'Cast System',
    version: '1.0.0',
  };
};
