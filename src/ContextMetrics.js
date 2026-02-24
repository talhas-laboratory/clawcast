const fs = require('fs').promises;
const path = require('path');

class ContextMetrics {
  constructor(options = {}) {
    this.rootDir = path.resolve(options.rootDir || process.cwd());
    this.metricsPath = path.join(this.rootDir, 'metrics.jsonl');
    this.countersPath = path.join(this.rootDir, 'metrics-counters.json');
    this.logger = options.logger || console;
    this.counters = {
      writes: 0,
      reads: 0,
      conflicts: 0,
      redactions: 0,
      deniedWrites: 0,
      retrievalHits: 0
    };
  }

  async initialize() {
    await fs.mkdir(this.rootDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.countersPath, 'utf8');
      const parsed = JSON.parse(raw);
      this.counters = { ...this.counters, ...parsed };
    } catch {
      await this.flushCounters();
    }
  }

  async record(event, payload = {}) {
    const row = {
      timestamp: new Date().toISOString(),
      event,
      ...payload
    };
    await fs.appendFile(this.metricsPath, `${JSON.stringify(row)}\n`, 'utf8');

    switch (event) {
      case 'write':
        this.counters.writes += 1;
        break;
      case 'read':
        this.counters.reads += 1;
        break;
      case 'conflict':
        this.counters.conflicts += 1;
        break;
      case 'redaction':
        this.counters.redactions += 1;
        break;
      case 'denied_write':
        this.counters.deniedWrites += 1;
        break;
      case 'retrieval_hit':
        this.counters.retrievalHits += 1;
        break;
      default:
        break;
    }

    if ((this.counters.writes + this.counters.reads) % 10 === 0) {
      await this.flushCounters();
    }
  }

  async flushCounters() {
    await fs.writeFile(this.countersPath, JSON.stringify(this.counters, null, 2), 'utf8');
  }

  diagnostics() {
    return {
      counters: { ...this.counters }
    };
  }
}

module.exports = ContextMetrics;
