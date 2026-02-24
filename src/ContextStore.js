const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const SafetyFilter = require('./SafetyFilter');
const { ConflictDetector, normalizeText } = require('./ConflictDetector');
const { IntentStateMachine } = require('./IntentStateMachine');
const ContextMetrics = require('./ContextMetrics');

const DEFAULT_CONFIG = {
  tokenBudget: 1800,
  confidenceThresholds: {
    contract: 0.9,
    session: 0.75,
    scratch: 0.4
  },
  conflict: {
    enabled: true,
    similarityThreshold: 0.62
  },
  safety: {
    enabled: true,
    redact: true
  },
  retrieval: {
    mode: 'hybrid',
    vectorOptional: true
  }
};

const DEFAULT_CONTRACT = {
  version: '2.0.0',
  updatedAt: null,
  rules: []
};

const DEFAULT_SESSION = {
  version: '2.0.0',
  updatedAt: null,
  intentState: 'implementation',
  objective: '',
  acceptanceCriteria: [],
  sharedSheet: '',
  sharedSheetUpdatedAt: null,
  lastCapturedTurnHash: null,
  entries: []
};

const DEFAULT_SCRATCH = {
  version: '2.0.0',
  updatedAt: null,
  entries: []
};

const DEFAULT_CONFLICTS = {
  version: '2.0.0',
  updatedAt: null,
  items: []
};

const EXPLICIT_MUTATION_REGEX = /\b(set|add|update|change|replace|remove|delete|adjust|adjusted|modify|modified)\b/i;
const CONTRACT_TARGET_REGEX = /\b(rule|rules|constraint|constraints|policy|policies|always|never|must|must not)\b/i;
const SHARED_SHEET_TARGET_REGEX = /\b(shared context|context sheet|shared sheet)\b/i;

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeJson(filePath, payload) {
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  await fs.rename(tmpPath, filePath);
}

async function appendJsonl(filePath, payload) {
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

class ContextStore {
  constructor(options = {}) {
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
    this.rootDir = path.join(this.workspaceRoot, 'cast-shared', 'context-v2');
    this.contractPath = path.join(this.rootDir, 'contract.json');
    this.sessionPath = path.join(this.rootDir, 'session.json');
    this.scratchPath = path.join(this.rootDir, 'scratchpad.json');
    this.conflictsPath = path.join(this.rootDir, 'conflicts.json');
    this.episodicPath = path.join(this.rootDir, 'episodic.jsonl');
    this.reportPath = path.join(this.rootDir, 'migration-report.json');
    this.logger = options.logger || console;

    this.config = {
      ...DEFAULT_CONFIG,
      ...(options.config || {}),
      confidenceThresholds: {
        ...DEFAULT_CONFIG.confidenceThresholds,
        ...(options.config && options.config.confidenceThresholds ? options.config.confidenceThresholds : {})
      },
      conflict: {
        ...DEFAULT_CONFIG.conflict,
        ...(options.config && options.config.conflict ? options.config.conflict : {})
      },
      safety: {
        ...DEFAULT_CONFIG.safety,
        ...(options.config && options.config.safety ? options.config.safety : {})
      },
      retrieval: {
        ...DEFAULT_CONFIG.retrieval,
        ...(options.config && options.config.retrieval ? options.config.retrieval : {})
      }
    };

    this.contract = { ...DEFAULT_CONTRACT };
    this.session = { ...DEFAULT_SESSION };
    this.scratchpad = { ...DEFAULT_SCRATCH };
    this.conflicts = { ...DEFAULT_CONFLICTS };
    this.episodic = [];

    this.safetyFilter = new SafetyFilter(this.config.safety);
    this.conflictDetector = new ConflictDetector(this.config.conflict);
    this.intentStateMachine = new IntentStateMachine();
    this.metrics = new ContextMetrics({ rootDir: this.rootDir, logger: this.logger });
  }

  async initialize() {
    await ensureDir(this.rootDir);
    await ensureDir(path.join(this.rootDir, 'archives'));

    this.contract = await readJson(this.contractPath, { ...DEFAULT_CONTRACT });
    this.session = await readJson(this.sessionPath, { ...DEFAULT_SESSION });
    this.scratchpad = await readJson(this.scratchPath, { ...DEFAULT_SCRATCH });
    this.conflicts = await readJson(this.conflictsPath, { ...DEFAULT_CONFLICTS });
    this.episodic = await this.readJsonl(this.episodicPath);

    await this.persistAll();
    await this.metrics.initialize();
  }

  async readJsonl(filePath) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  createEntry(payload = {}) {
    const createdAt = payload.createdAt || new Date().toISOString();
    return {
      id: payload.id || `ctx_${crypto.randomBytes(8).toString('hex')}`,
      type: payload.type || 'note',
      text: String(payload.text || '').trim(),
      source: payload.source || 'system',
      castId: payload.castId || null,
      userId: payload.userId || null,
      confidence: Number.isFinite(payload.confidence) ? Number(payload.confidence) : 0.5,
      locked: !!payload.locked,
      mutable: payload.mutable !== false,
      createdAt,
      updatedAt: payload.updatedAt || createdAt,
      tags: asArray(payload.tags),
      references: asArray(payload.references),
      safetyFlags: asArray(payload.safetyFlags),
      status: payload.status || 'active'
    };
  }

  sanitizeText(rawText) {
    return this.safetyFilter.sanitizeText(rawText);
  }

  parseContractMutationIntent(text) {
    const value = String(text || '').trim();
    const explicitVerb = EXPLICIT_MUTATION_REGEX.test(value);
    const targetMentioned = CONTRACT_TARGET_REGEX.test(value);
    if (!explicitVerb || !targetMentioned) {
      return {
        matched: false,
        confidence: 0,
        action: 'none'
      };
    }

    const lower = value.toLowerCase();
    const action = /\b(remove|delete)\b/.test(lower) ? 'remove' : 'set';
    const confidence = lower.length > 24 ? 0.92 : 0.9;
    return {
      matched: true,
      confidence,
      action,
      explicitVerb,
      targetMentioned
    };
  }

  inferContractFromText(text) {
    const normalized = normalizeText(text);
    return /\b(always|never|must|must not|policy|constraint|rule)\b/.test(normalized);
  }

  async addContractRule(text, meta = {}) {
    const safety = this.sanitizeText(text);
    if (!safety.allowed) {
      await this.metrics.record('denied_write', { tier: 'contract' });
      throw new Error('Contract write denied by safety policy');
    }
    if (safety.redacted) {
      await this.metrics.record('redaction', { tier: 'contract' });
    }

    const normalized = normalizeText(safety.text);
    const existing = this.contract.rules.find((item) => item && item.key === normalized && item.status !== 'removed');
    if (existing) {
      existing.updatedAt = new Date().toISOString();
      existing.text = safety.text;
      existing.source = meta.source || existing.source;
      existing.confidence = Number.isFinite(meta.confidence) ? Number(meta.confidence) : existing.confidence;
      await this.persistContract();
      await this.metrics.record('write', { tier: 'contract', dedupe: true });
      return { updated: true, rule: existing, conflicts: [] };
    }

    const entry = this.createEntry({
      type: 'contract_rule',
      text: safety.text,
      source: meta.source || 'system',
      castId: meta.castId || null,
      userId: meta.userId || null,
      confidence: Number.isFinite(meta.confidence) ? Number(meta.confidence) : this.config.confidenceThresholds.contract,
      locked: true,
      mutable: true,
      tags: ['contract'],
      safetyFlags: safety.safetyFlags
    });
    entry.key = normalized;

    const activeRules = this.contract.rules.filter((item) => item && item.status === 'active');
    const conflicts = this.conflictDetector.detectAgainst(entry, activeRules);
    if (conflicts.length > 0) {
      entry.status = 'conflicted';
      for (const conflict of conflicts) {
        const match = this.contract.rules.find((rule) => rule.id === conflict.a);
        if (match) {
          match.status = 'conflicted';
        }
        this.conflicts.items.unshift({
          ...conflict,
          aText: match ? match.text : '',
          bText: entry.text,
          resolvedBy: null,
          resolution: null
        });
        await this.metrics.record('conflict', { tier: 'contract', reason: conflict.reason });
      }
      this.conflicts.items = this.conflicts.items.slice(0, 500);
      this.conflicts.updatedAt = new Date().toISOString();
      await this.persistConflicts();
    }

    this.contract.rules.unshift(entry);
    this.contract.rules = this.contract.rules.slice(0, 2000);
    this.contract.updatedAt = new Date().toISOString();

    await this.persistContract();
    await this.metrics.record('write', { tier: 'contract' });

    return {
      updated: false,
      rule: entry,
      conflicts
    };
  }

  async removeContractRule(selector, meta = {}) {
    const raw = String(selector || '').trim();
    if (!raw) throw new Error('rule selector is required');

    const byId = this.contract.rules.find((item) => item && item.id === raw && item.status !== 'removed');
    const byText = this.contract.rules.find((item) => item && item.status !== 'removed' && normalizeText(item.text).includes(normalizeText(raw)));
    const target = byId || byText;
    if (!target) {
      return { removed: false, reason: 'not_found' };
    }

    target.status = 'removed';
    target.updatedAt = new Date().toISOString();
    target.removedBy = meta.userId || null;
    await this.persistContract();
    await this.metrics.record('write', { tier: 'contract', action: 'remove' });
    return { removed: true, rule: target };
  }

  async listContractRules() {
    await this.metrics.record('read', { tier: 'contract' });
    return this.contract.rules.filter((item) => item && item.status !== 'removed');
  }

  async addSessionEntry(text, meta = {}) {
    const safety = this.sanitizeText(text);
    if (!safety.allowed) {
      await this.metrics.record('denied_write', { tier: 'session' });
      throw new Error('Session write denied by safety policy');
    }
    if (safety.redacted) {
      await this.metrics.record('redaction', { tier: 'session' });
    }

    const entry = this.createEntry({
      type: meta.type || 'session_note',
      text: safety.text,
      source: meta.source || 'system',
      castId: meta.castId || null,
      userId: meta.userId || null,
      confidence: Number.isFinite(meta.confidence) ? Number(meta.confidence) : this.config.confidenceThresholds.session,
      tags: asArray(meta.tags),
      references: asArray(meta.references),
      safetyFlags: safety.safetyFlags
    });
    entry.key = normalizeText(entry.text);

    const activeSession = this.session.entries.filter((item) => item && item.status === 'active');
    const conflicts = this.conflictDetector.detectAgainst(entry, activeSession);
    if (conflicts.length > 0) {
      entry.status = 'conflicted';
      for (const conflict of conflicts) {
        const match = this.session.entries.find((row) => row.id === conflict.a);
        if (match) match.status = 'conflicted';
        this.conflicts.items.unshift({
          ...conflict,
          aText: match ? match.text : '',
          bText: entry.text,
          resolvedBy: null,
          resolution: null
        });
      }
      this.conflicts.items = this.conflicts.items.slice(0, 500);
      this.conflicts.updatedAt = new Date().toISOString();
      await this.persistConflicts();
    }

    this.session.entries.unshift(entry);
    this.session.entries = this.session.entries.slice(0, 2000);
    this.session.updatedAt = new Date().toISOString();

    await this.persistSession();
    await this.metrics.record('write', { tier: 'session' });

    return { entry, conflicts };
  }

  async setSessionFrame(input = {}, meta = {}) {
    const patch = isObjectLike(input) ? input : {};
    if (typeof patch.objective === 'string') {
      this.session.objective = patch.objective.trim();
    }
    if (Array.isArray(patch.acceptanceCriteria)) {
      this.session.acceptanceCriteria = patch.acceptanceCriteria
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 50);
    }
    if (typeof patch.intentState === 'string' && patch.intentState.trim()) {
      this.session.intentState = patch.intentState.trim();
    }
    if (typeof patch.sharedSheet === 'string') {
      const safety = this.sanitizeText(patch.sharedSheet);
      if (!safety.allowed) {
        await this.metrics.record('denied_write', { tier: 'session_shared_sheet' });
        throw new Error('Shared context sheet update denied by safety policy');
      }
      if (safety.redacted) {
        await this.metrics.record('redaction', { tier: 'session_shared_sheet' });
      }
      this.session.sharedSheet = safety.text.trim();
      this.session.sharedSheetUpdatedAt = new Date().toISOString();
    }
    this.session.updatedAt = new Date().toISOString();

    if (patch.note) {
      await this.addSessionEntry(String(patch.note), {
        ...meta,
        type: 'session_note',
        source: meta.source || 'system'
      });
    }

    await this.persistSession();
    return { success: true, session: this.session };
  }

  composeSharedSheet(snapshot) {
    const parts = [];
    if (snapshot.contractRules.length > 0) {
      parts.push('## Contract Rules');
      for (const row of snapshot.contractRules.slice(0, 12)) {
        parts.push(`- ${row.text}`);
      }
      parts.push('');
    }
    if (snapshot.sessionEntries.length > 0) {
      parts.push('## Session Frame');
      for (const row of snapshot.sessionEntries.slice(0, 12)) {
        parts.push(`- ${row.text}`);
      }
      parts.push('');
    }
    if (snapshot.references.length > 0) {
      parts.push('## References');
      for (const row of snapshot.references.slice(0, 8)) {
        parts.push(`- ${row.text}`);
      }
      parts.push('');
    }
    return parts.join('\n').trim() || 'No shared context available.';
  }

  looksComposedSheet(text) {
    const value = String(text || '').trim().toLowerCase();
    if (!value) return false;
    return value.includes('## session frame')
      || value.includes('## references')
      || value.includes('## contract rules');
  }

  async getSharedContextSheet(options = {}) {
    const snapshot = await this.getContextSnapshot(options);
    const mode = String(options.mode || 'hybrid').toLowerCase();
    const manual = this.session.sharedSheet && this.session.sharedSheet.trim()
      ? this.session.sharedSheet.trim()
      : '';
    const composed = this.composeSharedSheet(snapshot);

    let text = composed;
    let source = 'composed';

    if (mode === 'manual' && manual) {
      text = manual;
      source = 'session.sharedSheet';
    } else if (mode === 'composed') {
      text = composed;
      source = 'composed';
    } else if (manual) {
      if (this.looksComposedSheet(manual)) {
        // If sheet was previously copied from composed output, keep it live.
        text = composed;
        source = 'session.sharedSheet(auto-refresh)';
      } else {
        text = `${manual}\n\n## Live Conversation Context\n${composed}`.trim();
        source = 'hybrid';
      }
    }

    await this.metrics.record('read', { tier: 'shared_sheet' });
    return {
      text,
      source,
      updatedAt: this.session.sharedSheetUpdatedAt || this.session.updatedAt || null
    };
  }

  async updateSharedContextSheet(content, options = {}) {
    const mode = String(options.mode || 'replace').toLowerCase();
    const incoming = String(content || '').trim();
    if (!incoming) {
      throw new Error('content is required');
    }
    const safety = this.sanitizeText(incoming);
    if (!safety.allowed) {
      await this.metrics.record('denied_write', { tier: 'shared_sheet' });
      throw new Error('Shared context sheet update denied by safety policy');
    }
    if (safety.redacted) {
      await this.metrics.record('redaction', { tier: 'shared_sheet' });
    }

    const previous = String(this.session.sharedSheet || '');
    if (mode === 'append' && previous.trim()) {
      this.session.sharedSheet = `${previous.trim()}\n${safety.text.trim()}`.trim();
    } else {
      this.session.sharedSheet = safety.text.trim();
    }
    this.session.sharedSheetUpdatedAt = new Date().toISOString();
    this.session.updatedAt = this.session.sharedSheetUpdatedAt;
    await this.persistSession();
    await this.metrics.record('write', { tier: 'shared_sheet', mode });
    await this.addEpisodicEvent({
      type: 'shared_sheet_update',
      text: this.session.sharedSheet.slice(0, 1200),
      castId: options.castId || null,
      userId: options.userId || null,
      source: options.source || 'system'
    });
    return {
      success: true,
      text: this.session.sharedSheet,
      updatedAt: this.session.sharedSheetUpdatedAt
    };
  }

  parseSharedContextEditPrompt(prompt) {
    const text = String(prompt || '').trim();
    if (!text) return { matched: false };
    if (!SHARED_SHEET_TARGET_REGEX.test(text)) return { matched: false };
    if (!EXPLICIT_MUTATION_REGEX.test(text)) return { matched: false };

    const replacePatterns = [
      /replace\s+["“]([^"”]+)["”]\s+with\s+["“]([^"”]+)["”]/i,
      /["“]([^"”]+)["”]\s+should\s+be\s+(?:changed|updated|adjusted|replaced)\s+to\s+["“]([^"”]+)["”]/i
    ];
    for (const pattern of replacePatterns) {
      const match = text.match(pattern);
      if (match) {
        return {
          matched: true,
          confidence: 0.93,
          action: 'replace',
          from: String(match[1] || '').trim(),
          to: String(match[2] || '').trim()
        };
      }
    }

    const removeMatch = text.match(/remove\s+["“]([^"”]+)["”]/i);
    if (removeMatch) {
      return {
        matched: true,
        confidence: 0.92,
        action: 'remove',
        value: String(removeMatch[1] || '').trim()
      };
    }

    const addMatch = text.match(/add\s+["“]([^"”]+)["”](?:\s+to\s+(?:the\s+)?)?(?:shared context|context sheet|shared sheet)/i);
    if (addMatch) {
      return {
        matched: true,
        confidence: 0.9,
        action: 'add',
        value: String(addMatch[1] || '').trim()
      };
    }

    const adjustedAddMatch = text.match(/["“]([^"”]+)["”]\s+should\s+be\s+(?:added|included|adjusted)\s+(?:in|to)\s+(?:the\s+)?(?:shared context|context sheet|shared sheet)/i);
    if (adjustedAddMatch) {
      return {
        matched: true,
        confidence: 0.9,
        action: 'add',
        value: String(adjustedAddMatch[1] || '').trim()
      };
    }

    const setMatch = text.match(/(?:set|update|change)\s+(?:the\s+)?(?:shared context|context sheet|shared sheet)\s*(?:to|as|:)\s*([\s\S]+)/i);
    if (setMatch) {
      return {
        matched: true,
        confidence: 0.9,
        action: 'set',
        value: String(setMatch[1] || '').trim()
      };
    }

    return {
      matched: true,
      confidence: 0.78,
      action: 'uncertain',
      value: text
    };
  }

  async applySharedContextPromptEdit(prompt, options = {}) {
    const parsed = this.parseSharedContextEditPrompt(prompt);
    if (!parsed.matched) {
      return { applied: false, matched: false, parsed };
    }

    const threshold = Number.isFinite(this.config.confidenceThresholds.session)
      ? Number(this.config.confidenceThresholds.session)
      : 0.75;
    if (!Number.isFinite(parsed.confidence) || parsed.confidence < threshold || parsed.action === 'uncertain') {
      const pending = await this.addSessionEntry(`Pending shared context edit: ${String(prompt || '').trim()}`, {
        type: 'pending_shared_sheet_edit',
        source: options.source || 'user_explicit_nl',
        castId: options.castId || null,
        userId: options.userId || null,
        confidence: Number.isFinite(parsed.confidence) ? parsed.confidence : 0.5
      });
      return { applied: false, matched: true, pending: true, parsed, candidate: pending.entry };
    }

    const current = await this.getSharedContextSheet(options);
    let next = String(current.text || '');
    if (parsed.action === 'replace' && parsed.from) {
      const escaped = parsed.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escaped, 'i');
      next = re.test(next) ? next.replace(re, parsed.to) : `${next}\n- ${parsed.to}`.trim();
    } else if (parsed.action === 'remove' && parsed.value) {
      const escaped = parsed.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^.*${escaped}.*$\\n?`, 'gim');
      next = next.replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
    } else if (parsed.action === 'add' && parsed.value) {
      next = `${next}\n- ${parsed.value}`.trim();
    } else if (parsed.action === 'set' && parsed.value) {
      next = parsed.value;
    }

    const updated = await this.updateSharedContextSheet(next, {
      mode: 'replace',
      source: options.source || 'user_explicit_nl',
      castId: options.castId || null,
      userId: options.userId || null
    });
    return { applied: true, matched: true, parsed, updated };
  }

  async setIntentState(state, meta = {}) {
    const nextState = String(state || '').trim() || this.session.intentState;
    this.session.intentState = nextState;
    this.session.updatedAt = new Date().toISOString();
    await this.persistSession();
    await this.addEpisodicEvent({
      type: 'intent_state_change',
      text: `intent=${nextState}`,
      castId: meta.castId || null,
      userId: meta.userId || null,
      source: meta.source || 'system'
    });
    return { success: true, intentState: nextState };
  }

  async inferAndSetIntent(input = {}) {
    const inferred = this.intentStateMachine.infer({
      text: input.text || '',
      command: input.command || ''
    });
    if (inferred !== this.session.intentState) {
      await this.setIntentState(inferred, {
        castId: input.castId || null,
        userId: input.userId || null,
        source: input.source || 'system'
      });
    }
    return inferred;
  }

  async addScratchpadEntry(text, meta = {}) {
    const safety = this.sanitizeText(text);
    if (!safety.allowed) {
      await this.metrics.record('denied_write', { tier: 'scratchpad' });
      throw new Error('Scratchpad write denied by safety policy');
    }
    if (safety.redacted) {
      await this.metrics.record('redaction', { tier: 'scratchpad' });
    }

    const entry = this.createEntry({
      type: meta.type || 'scratch_note',
      text: safety.text,
      source: meta.source || 'system',
      castId: meta.castId || null,
      userId: meta.userId || null,
      confidence: Number.isFinite(meta.confidence) ? Number(meta.confidence) : this.config.confidenceThresholds.scratch,
      tags: asArray(meta.tags),
      references: asArray(meta.references),
      safetyFlags: safety.safetyFlags,
      mutable: true,
      locked: false
    });
    entry.key = normalizeText(entry.text);

    const dedupe = this.scratchpad.entries.find((item) => item && item.key === entry.key && item.status === 'active');
    if (!dedupe) {
      this.scratchpad.entries.unshift(entry);
      this.scratchpad.entries = this.scratchpad.entries.slice(0, 4000);
      this.scratchpad.updatedAt = new Date().toISOString();
      await this.persistScratchpad();
      await this.metrics.record('write', { tier: 'scratchpad' });
    }
    return { entry: dedupe || entry, deduped: !!dedupe };
  }

  async pruneScratchpad(options = {}) {
    const ttlHours = Number.isFinite(options.ttlHours) ? Number(options.ttlHours) : 24;
    const cutoffMs = Date.now() - ttlHours * 60 * 60 * 1000;
    const before = this.scratchpad.entries.length;
    this.scratchpad.entries = this.scratchpad.entries.filter((item) => {
      if (!item || item.locked) return true;
      const updatedAtMs = Date.parse(item.updatedAt || item.createdAt || 0);
      return Number.isFinite(updatedAtMs) ? updatedAtMs >= cutoffMs : true;
    });
    const removed = before - this.scratchpad.entries.length;
    if (removed > 0) {
      this.scratchpad.updatedAt = new Date().toISOString();
      await this.persistScratchpad();
    }
    return { removed, remaining: this.scratchpad.entries.length };
  }

  async addEpisodicEvent(event = {}) {
    const payload = {
      id: event.id || `epi_${crypto.randomBytes(8).toString('hex')}`,
      timestamp: event.timestamp || new Date().toISOString(),
      type: event.type || 'event',
      text: String(event.text || '').trim(),
      castId: event.castId || null,
      userId: event.userId || null,
      source: event.source || 'system',
      references: asArray(event.references),
      metadata: isObjectLike(event.metadata) ? event.metadata : {}
    };
    if (!payload.text && payload.type !== 'switch') {
      return { skipped: true };
    }

    this.episodic.unshift(payload);
    this.episodic = this.episodic.slice(0, 10000);
    await appendJsonl(this.episodicPath, payload);
    await this.metrics.record('write', { tier: 'episodic' });
    return { added: true, event: payload };
  }

  searchEpisodic(query, options = {}) {
    const q = normalizeText(query);
    if (!q) return [];
    const limit = Number.isFinite(options.limit) ? Number(options.limit) : 8;
    const terms = q.split(' ').filter(Boolean);

    const scored = this.episodic
      .map((row) => {
        const hay = normalizeText(row.text);
        if (!hay) return null;
        let score = 0;
        for (const term of terms) {
          if (hay.includes(term)) score += 1;
        }
        if (!score) return null;
        return {
          ...row,
          score: score / terms.length
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored;
  }

  async resolveConflict(conflictId, strategy = 'keepA', mergeText = '', meta = {}) {
    const conflict = this.conflicts.items.find((item) => item.id === conflictId && item.status === 'open');
    if (!conflict) {
      return { resolved: false, reason: 'not_found' };
    }

    const aRule = this.contract.rules.find((item) => item.id === conflict.a)
      || this.session.entries.find((item) => item.id === conflict.a);
    const bRule = this.contract.rules.find((item) => item.id === conflict.b)
      || this.session.entries.find((item) => item.id === conflict.b);

    if (strategy === 'keepA') {
      if (bRule) bRule.status = 'resolved';
      if (aRule) aRule.status = 'active';
    } else if (strategy === 'keepB') {
      if (aRule) aRule.status = 'resolved';
      if (bRule) bRule.status = 'active';
    } else if (strategy === 'merge') {
      const text = String(mergeText || '').trim();
      if (!text) throw new Error('merge text is required');
      await this.addSessionEntry(text, {
        source: meta.source || 'system',
        castId: meta.castId || null,
        userId: meta.userId || null,
        type: 'merged_conflict_resolution'
      });
      if (aRule) aRule.status = 'resolved';
      if (bRule) bRule.status = 'resolved';
    }

    conflict.status = 'resolved';
    conflict.resolution = strategy;
    conflict.resolvedBy = meta.userId || null;
    conflict.resolvedAt = new Date().toISOString();

    await this.persistAll();
    return { resolved: true, conflict };
  }

  async captureAuto(input = {}) {
    const castId = input.castId || null;
    const userId = input.userId || null;
    const message = String(input.message || '').trim();
    const response = String(input.response || '').trim();

    await this.inferAndSetIntent({
      text: `${message}\n${response}`,
      castId,
      userId,
      source: 'auto_capture'
    });

    const captures = [];
    const sharedEdit = await this.applySharedContextPromptEdit(message, {
      source: 'auto_capture',
      castId,
      userId
    });
    if (sharedEdit && sharedEdit.applied) {
      captures.push({ tier: 'session', type: 'shared_sheet_edit', text: 'Applied explicit shared context sheet edit.' });
    } else if (sharedEdit && sharedEdit.pending) {
      captures.push({ tier: 'session', type: 'pending_shared_sheet_edit', text: 'Captured pending shared context sheet edit.' });
    }
    const taskPatterns = [
      /\bi\s+(?:need to|will|am going to)\s+([^\n\.]+)/i,
      /\b(?:next step|todo|to do)\s*[:\-]\s*([^\n]+)/i,
      /-\s*\[\s?\]\s*([^\n]+)/i
    ];
    const decisionPatterns = [
      /\b(?:decision|decided|we will)\s*[:\-]?\s*([^\n\.]+)/i
    ];
    const waitingPatterns = [
      /\b(?:waiting for|will send|will provide)\s+([^\n\.]+)/i
    ];

    for (const pattern of taskPatterns) {
      const match = message.match(pattern);
      if (match && match[1] && match[1].trim().length > 2) {
        const text = `Task: ${match[1].trim()}`;
        await this.addScratchpadEntry(text, {
          type: 'active_task',
          source: 'auto_capture',
          castId,
          userId,
          confidence: 0.62
        });
        captures.push({ tier: 'scratchpad', type: 'task', text });
      }
    }

    for (const pattern of decisionPatterns) {
      const match = `${message}\n${response}`.match(pattern);
      if (match && match[1] && match[1].trim().length > 2) {
        const text = `Decision: ${match[1].trim()}`;
        await this.addSessionEntry(text, {
          type: 'decision',
          source: 'auto_capture',
          castId,
          userId,
          confidence: 0.8
        });
        captures.push({ tier: 'session', type: 'decision', text });
      }
    }

    for (const pattern of waitingPatterns) {
      const match = message.match(pattern);
      if (match && match[1] && match[1].trim().length > 2) {
        const text = `Waiting: ${match[1].trim()}`;
        await this.addScratchpadEntry(text, {
          type: 'waiting_item',
          source: 'auto_capture',
          castId,
          userId,
          confidence: 0.58
        });
        captures.push({ tier: 'scratchpad', type: 'waiting', text });
      }
    }

    await this.addEpisodicEvent({
      type: 'turn',
      text: `${message}\n${response}`.trim(),
      castId,
      userId,
      source: 'auto_capture',
      metadata: {
        captured: captures.length
      }
    });

    return {
      captured: captures.length > 0,
      captures,
      intentState: this.session.intentState
    };
  }

  extractLatestTurnFromMessages(messages) {
    const rows = Array.isArray(messages) ? messages : [];
    if (rows.length < 2) return null;

    let assistantText = '';
    let userText = '';

    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i] || {};
      const role = String(row.role || '').toLowerCase();
      const text = this.messageToText(row);
      if (!text) continue;
      if (!assistantText && role === 'assistant') {
        assistantText = text;
        continue;
      }
      if (assistantText && role === 'user') {
        userText = text;
        break;
      }
    }

    if (!userText || !assistantText) return null;
    return { message: userText, response: assistantText };
  }

  messageToText(message) {
    if (!message) return '';
    if (typeof message === 'string') return message.trim();

    const content = message.content ?? message.text ?? message.message ?? '';
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      return content
        .map((block) => {
          if (!block) return '';
          if (typeof block === 'string') return block;
          if (typeof block.text === 'string') return block.text;
          return '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
    }
    if (content && typeof content === 'object' && typeof content.text === 'string') {
      return String(content.text).trim();
    }
    return '';
  }

  async captureLatestTurnFromMessages(messages, options = {}) {
    const pair = this.extractLatestTurnFromMessages(messages);
    if (!pair) {
      return { captured: false, reason: 'no_turn_pair' };
    }

    const turnHash = crypto
      .createHash('sha1')
      .update(`${pair.message}\n---\n${pair.response}`)
      .digest('hex');

    if (this.session.lastCapturedTurnHash === turnHash) {
      return { captured: false, deduped: true, reason: 'already_captured' };
    }

    const result = await this.captureAuto({
      castId: options.castId || null,
      userId: options.userId || null,
      message: pair.message,
      response: pair.response
    });

    this.session.lastCapturedTurnHash = turnHash;
    this.session.updatedAt = new Date().toISOString();
    await this.persistSession();
    return { captured: true, deduped: false, turnHash, result };
  }

  async getContextSnapshot(options = {}) {
    const castId = options.castId || null;
    const query = String(options.query || '').trim();
    const limit = Number.isFinite(options.limit) ? Number(options.limit) : 8;

    const contractRules = this.contract.rules.filter((item) => item && item.status !== 'removed');
    const sessionEntries = this.session.entries
      .filter((item) => item && item.status !== 'removed')
      .slice(0, 300);

    const scratchpadEntries = this.scratchpad.entries
      .filter((item) => item && item.status !== 'removed')
      .filter((item) => !castId || !item.castId || item.castId === castId)
      .slice(0, 300);

    const references = query
      ? this.searchEpisodic(query, { limit })
      : this.episodic.slice(0, limit);

    const objectiveRows = this.session.objective
      ? [this.createEntry({ id: 'session_objective', type: 'objective', text: this.session.objective, source: 'system', mutable: true })]
      : [];

    const criteriaRows = asArray(this.session.acceptanceCriteria)
      .map((item, idx) => this.createEntry({ id: `session_criteria_${idx}`, type: 'acceptance_criteria', text: item, source: 'system', mutable: true }));
    const sharedSheetRows = this.session.sharedSheet && this.session.sharedSheet.trim()
      ? [this.createEntry({ id: 'session_shared_sheet', type: 'shared_context_sheet', text: this.session.sharedSheet.trim(), source: 'system', mutable: true })]
      : [];

    return {
      contractRules,
      sessionEntries: [...sharedSheetRows, ...objectiveRows, ...criteriaRows, ...sessionEntries],
      scratchpadEntries,
      references,
      conflicts: this.conflicts.items.filter((item) => item && item.status === 'open').slice(0, 100),
      intentState: this.session.intentState,
      updatedAt: {
        contract: this.contract.updatedAt,
        session: this.session.updatedAt,
        scratchpad: this.scratchpad.updatedAt
      }
    };
  }

  async getConflicts() {
    return this.conflicts.items.slice(0, 500);
  }

  async writeMigrationReport(report) {
    await writeJson(this.reportPath, report);
  }

  diagnostics() {
    return {
      rootDir: this.rootDir,
      counts: {
        contract: this.contract.rules.length,
        session: this.session.entries.length,
        scratchpad: this.scratchpad.entries.length,
        episodic: this.episodic.length,
        conflicts: this.conflicts.items.filter((item) => item.status === 'open').length
      },
      intentState: this.session.intentState,
      updatedAt: {
        contract: this.contract.updatedAt,
        session: this.session.updatedAt,
        scratchpad: this.scratchpad.updatedAt,
        conflicts: this.conflicts.updatedAt
      },
      metrics: this.metrics.diagnostics(),
      config: this.config
    };
  }

  async persistContract() {
    this.contract.updatedAt = new Date().toISOString();
    await writeJson(this.contractPath, this.contract);
  }

  async persistSession() {
    this.session.updatedAt = new Date().toISOString();
    await writeJson(this.sessionPath, this.session);
  }

  async persistScratchpad() {
    this.scratchpad.updatedAt = new Date().toISOString();
    await writeJson(this.scratchPath, this.scratchpad);
  }

  async persistConflicts() {
    this.conflicts.updatedAt = new Date().toISOString();
    await writeJson(this.conflictsPath, this.conflicts);
  }

  async persistAll() {
    await Promise.all([
      this.persistContract(),
      this.persistSession(),
      this.persistScratchpad(),
      this.persistConflicts()
    ]);
    await this.metrics.flushCounters();
  }
}

function isObjectLike(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

module.exports = ContextStore;
