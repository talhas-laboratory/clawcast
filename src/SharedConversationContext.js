const fs = require('fs').promises;
const path = require('path');

const DEFAULT_STATE = {
  version: '1.0.0',
  updatedAt: null,
  decisions: [],
  goals: [],
  constraints: [],
  tasks: [],
  facts: [],
  switches: [],
  recentTurns: []
};

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function atomicWriteJson(filePath, value) {
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmpPath, filePath);
}

class SharedConversationContext {
  constructor(options = {}) {
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
    this.rootDir = path.join(this.workspaceRoot, 'cast-shared', 'conversation');
    this.summaryPath = path.join(this.rootDir, 'summary.json');
    this.eventsPath = path.join(this.rootDir, 'events.jsonl');
    this.contextPath = path.join(this.rootDir, 'context.md');
    this.logger = options.logger || console;
    this.contextStore = options.contextStore || null;
    this.state = { ...DEFAULT_STATE };
    this.maxItems = Number.isFinite(options.maxItems) ? options.maxItems : 200;
  }

  async initialize() {
    await ensureDir(this.rootDir);
    this.state = await readJson(this.summaryPath, { ...DEFAULT_STATE });
    if (!this.state.version) this.state.version = '1.0.0';
    await this.persist();
  }

  async captureTurn(payload = {}) {
    const timestamp = payload.timestamp || new Date().toISOString();
    const castId = String(payload.castId || 'unknown');
    const userId = String(payload.userId || 'unknown');
    const message = String(payload.message || '').trim();
    const response = String(payload.response || '').trim();

    const extracted = this.extractSignals(`${message}\n${response}`);
    this.pushUnique(this.state.decisions, extracted.decisions, { castId, userId, timestamp });
    this.pushUnique(this.state.goals, extracted.goals, { castId, userId, timestamp });
    this.pushUnique(this.state.constraints, extracted.constraints, { castId, userId, timestamp });
    this.pushUnique(this.state.tasks, extracted.tasks, { castId, userId, timestamp });
    this.pushUnique(this.state.facts, extracted.facts, { castId, userId, timestamp });

    this.state.recentTurns.unshift({
      timestamp,
      castId,
      userId,
      message: message.slice(0, 500),
      responseSummary: response.slice(0, 500)
    });
    this.state.recentTurns = this.state.recentTurns.slice(0, this.maxItems);

    await this.appendEvent('turn', {
      timestamp,
      castId,
      userId,
      extractedCounts: {
        decisions: extracted.decisions.length,
        goals: extracted.goals.length,
        constraints: extracted.constraints.length,
        tasks: extracted.tasks.length,
        facts: extracted.facts.length
      }
    });

    if (this.contextStore) {
      await this.contextStore.addEpisodicEvent({
        type: 'turn',
        text: `${message}\n${response}`.trim(),
        castId,
        userId,
        source: 'system',
        metadata: {
          extracted
        }
      });
    }

    await this.persist();
    return {
      captured: true,
      extracted
    };
  }

  async captureSwitch(payload = {}) {
    const event = {
      timestamp: payload.timestamp || new Date().toISOString(),
      from: payload.from || null,
      to: payload.to || null,
      userId: payload.userId || null
    };
    this.state.switches.unshift(event);
    this.state.switches = this.state.switches.slice(0, this.maxItems);
    await this.appendEvent('switch', event);
    if (this.contextStore) {
      await this.contextStore.addEpisodicEvent({
        type: 'switch',
        text: `Switch: ${event.from || 'none'} -> ${event.to || 'none'}`,
        castId: event.to || event.from || null,
        userId: event.userId || null,
        source: 'system',
        metadata: event
      });
    }
    await this.persist();
    return event;
  }

  async absorbCastSnapshot(cast, options = {}) {
    if (!cast || !cast.path) return { absorbed: false };
    const scratchpadPath = path.join(cast.path, 'memory', 'scratchpad.md');
    let raw = '';
    try {
      raw = await fs.readFile(scratchpadPath, 'utf8');
    } catch {
      return { absorbed: false };
    }

    const signals = this.extractSignals(raw);
    const timestamp = new Date().toISOString();
    const castId = cast.id || options.fromCast || 'unknown';
    const sourceMeta = { castId, userId: 'system', timestamp };
    this.pushUnique(this.state.decisions, signals.decisions, sourceMeta);
    this.pushUnique(this.state.goals, signals.goals, sourceMeta);
    this.pushUnique(this.state.constraints, signals.constraints, sourceMeta);
    this.pushUnique(this.state.tasks, signals.tasks, sourceMeta);
    this.pushUnique(this.state.facts, signals.facts, sourceMeta);

    await this.appendEvent('snapshot', {
      timestamp,
      castId,
      source: options.reason || 'cast-switch',
      counts: {
        decisions: signals.decisions.length,
        goals: signals.goals.length,
        constraints: signals.constraints.length,
        tasks: signals.tasks.length,
        facts: signals.facts.length
      }
    });

    if (this.contextStore) {
      for (const task of signals.tasks) {
        await this.contextStore.addScratchpadEntry(`Task: ${task}`, {
          type: 'active_task',
          source: 'system',
          castId,
          userId: 'system',
          confidence: 0.7
        });
      }
      for (const decision of signals.decisions) {
        await this.contextStore.addSessionEntry(`Decision: ${decision}`, {
          type: 'decision',
          source: 'system',
          castId,
          userId: 'system',
          confidence: 0.8
        });
      }
    }

    await this.persist();
    return { absorbed: true, counts: signals };
  }

  async getContext(options = {}) {
    const limit = Number.isFinite(options.limit) ? Number(options.limit) : 8;
    const context = {
      updatedAt: this.state.updatedAt,
      decisions: this.state.decisions.slice(0, limit),
      goals: this.state.goals.slice(0, limit),
      constraints: this.state.constraints.slice(0, limit),
      tasks: this.state.tasks.slice(0, limit),
      facts: this.state.facts.slice(0, limit),
      recentTurns: this.state.recentTurns.slice(0, Math.min(limit, 12))
    };

    return {
      ...context,
      text: this.formatContext(context)
    };
  }

  async search(query, options = {}) {
    const terms = this.tokenize(query);
    if (terms.length === 0) {
      return { results: [], total: 0 };
    }

    const limit = Number.isFinite(options.limit) ? Number(options.limit) : 5;
    const pool = [
      ...this.state.decisions.map((item) => ({ type: 'decision', item })),
      ...this.state.goals.map((item) => ({ type: 'goal', item })),
      ...this.state.constraints.map((item) => ({ type: 'constraint', item })),
      ...this.state.tasks.map((item) => ({ type: 'task', item })),
      ...this.state.facts.map((item) => ({ type: 'fact', item }))
    ];

    const scored = pool
      .map((row) => {
        const haystack = this.tokenize(row.item.text).join(' ');
        let score = 0;
        for (const term of terms) {
          if (haystack.includes(term)) {
            score += 1;
          }
        }
        return {
          ...row,
          score: terms.length > 0 ? score / terms.length : 0
        };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score);

    const results = scored.slice(0, limit).map((row, idx) => ({
      id: `shared-conversation#${idx}`,
      type: row.type,
      text: row.item.text,
      score: row.score,
      timestamp: row.item.timestamp,
      castId: row.item.castId
    }));

    return {
      results,
      total: scored.length
    };
  }

  extractSignals(text) {
    const content = String(text || '');
    return {
      decisions: this.collect(content, [
        /\b(?:we|i)\s+(?:decided|decide|will)\s+to\s+([^.!?\n]+)/gi,
        /\bdecision\s*[:\-]\s*([^.!?\n]+)/gi
      ]),
      goals: this.collect(content, [
        /\b(?:goal|objective|aim)\s*(?:is|:)\s*([^.!?\n]+)/gi,
        /\b(?:we|i)\s+need\s+to\s+([^.!?\n]+)/gi
      ]),
      constraints: this.collect(content, [
        /\b(?:must|cannot|can't|should not|avoid)\s+([^.!?\n]+)/gi
      ]),
      tasks: this.collect(content, [
        /\b(?:next step|todo|to do)\s*[:\-]\s*([^.!?\n]+)/gi,
        /-\s*\[\s?\]\s*([^.\n]+)/gi
      ]),
      facts: this.collect(content, [
        /\b(?:important|note|remember)\s*[:\-]\s*([^.!?\n]+)/gi
      ])
    };
  }

  collect(content, patterns) {
    const rows = [];
    for (const pattern of patterns) {
      const matches = content.matchAll(pattern);
      for (const match of matches) {
        const text = String(match[1] || '').trim();
        if (text.length < 4) continue;
        rows.push(text);
      }
    }
    // Deduplicate while preserving order.
    const seen = new Set();
    const output = [];
    for (const row of rows) {
      const key = row.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(row);
    }
    return output;
  }

  pushUnique(target, values, meta) {
    if (!Array.isArray(values) || values.length === 0) return;
    for (const value of values) {
      const key = String(value || '').trim().toLowerCase();
      if (!key) continue;
      const exists = target.some((item) => item.key === key);
      if (exists) continue;
      target.unshift({
        key,
        text: value.trim(),
        castId: meta.castId,
        userId: meta.userId,
        timestamp: meta.timestamp
      });
    }
    if (target.length > this.maxItems) {
      target.length = this.maxItems;
    }
  }

  formatContext(context) {
    const lines = [];
    const pushSection = (title, rows) => {
      if (!rows || rows.length === 0) return;
      lines.push(`## ${title}`);
      for (const row of rows) {
        lines.push(`- ${row.text}`);
      }
      lines.push('');
    };

    pushSection('Decisions', context.decisions);
    pushSection('Goals', context.goals);
    pushSection('Constraints', context.constraints);
    pushSection('Tasks', context.tasks);
    pushSection('Facts', context.facts);

    if (context.recentTurns && context.recentTurns.length > 0) {
      lines.push('## Recent Conversation Signals');
      for (const turn of context.recentTurns.slice(0, 5)) {
        lines.push(`- [${turn.castId}] ${turn.message}`);
      }
      lines.push('');
    }

    return lines.join('\n').trim() || 'No shared conversation context yet.';
  }

  tokenize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((term) => term.length > 2);
  }

  async appendEvent(type, payload) {
    const line = JSON.stringify({ type, ...payload }) + '\n';
    await fs.appendFile(this.eventsPath, line, 'utf8');
  }

  async persist() {
    this.state.updatedAt = new Date().toISOString();
    await atomicWriteJson(this.summaryPath, this.state);
    const text = this.formatContext({
      decisions: this.state.decisions.slice(0, 20),
      goals: this.state.goals.slice(0, 20),
      constraints: this.state.constraints.slice(0, 20),
      tasks: this.state.tasks.slice(0, 20),
      facts: this.state.facts.slice(0, 20),
      recentTurns: this.state.recentTurns.slice(0, 20)
    });
    await fs.writeFile(this.contextPath, text + '\n', 'utf8');
  }
}

module.exports = SharedConversationContext;
