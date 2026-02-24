const fs = require('fs').promises;
const path = require('path');

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function safeCopy(source, destination) {
  if (!(await exists(source))) {
    return false;
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: true });
  return true;
}

function parseScratchpadSections(raw) {
  const text = String(raw || '');
  const sections = {};
  const matches = text.matchAll(/##\s+([^\n]+)\n([\s\S]*?)(?=\n##\s+|$)/g);
  for (const match of matches) {
    sections[String(match[1] || '').trim()] = String(match[2] || '').trim();
  }
  return sections;
}

async function readJsonSafe(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function migrateContextV2(options = {}) {
  const store = options.store;
  if (!store) {
    throw new Error('store is required');
  }

  const workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
  const castsPath = path.resolve(options.castsPath || path.join(workspaceRoot, 'casts'));
  const now = new Date().toISOString();
  const stamp = now.replace(/[:.]/g, '-');
  const archiveDir = path.join(store.rootDir, 'archives', stamp);

  const report = {
    version: '2.0.0',
    migratedAt: now,
    archiveDir,
    copied: {
      conversation: false,
      sharedMemory: false,
      scratchpads: 0
    },
    converted: {
      contract: 0,
      session: 0,
      scratchpad: 0,
      episodic: 0
    },
    skipped: 0,
    conflicts: 0,
    notes: []
  };

  const legacyConversation = path.join(workspaceRoot, 'cast-shared', 'conversation');
  const legacySharedMemory = path.join(workspaceRoot, 'cast-shared', 'memory');

  report.copied.conversation = await safeCopy(legacyConversation, path.join(archiveDir, 'conversation'));
  report.copied.sharedMemory = await safeCopy(legacySharedMemory, path.join(archiveDir, 'memory'));

  const summary = await readJsonSafe(path.join(legacyConversation, 'summary.json'), null);
  if (summary) {
    const decisions = Array.isArray(summary.decisions) ? summary.decisions : [];
    const constraints = Array.isArray(summary.constraints) ? summary.constraints : [];
    const facts = Array.isArray(summary.facts) ? summary.facts : [];
    const goals = Array.isArray(summary.goals) ? summary.goals : [];
    const tasks = Array.isArray(summary.tasks) ? summary.tasks : [];
    const recentTurns = Array.isArray(summary.recentTurns) ? summary.recentTurns : [];
    const switches = Array.isArray(summary.switches) ? summary.switches : [];

    const contractLike = (text) => /\b(always|never|must|must not|policy|constraint|rule)\b/i.test(String(text || ''));

    for (const row of [...decisions, ...constraints, ...facts]) {
      const text = row && row.text ? String(row.text).trim() : '';
      if (!text) {
        report.skipped += 1;
        continue;
      }
      if (contractLike(text)) {
        const result = await store.addContractRule(text, {
          source: 'migration',
          castId: row.castId || null,
          userId: row.userId || null,
          confidence: 0.91
        });
        report.converted.contract += 1;
        report.conflicts += Array.isArray(result.conflicts) ? result.conflicts.length : 0;
      } else {
        await store.addSessionEntry(text, {
          source: 'migration',
          type: 'legacy_signal',
          castId: row.castId || null,
          userId: row.userId || null,
          confidence: 0.82
        });
        report.converted.session += 1;
      }
    }

    for (const row of goals) {
      const text = row && row.text ? String(row.text).trim() : '';
      if (!text) continue;
      await store.addSessionEntry(`Objective: ${text}`, {
        source: 'migration',
        type: 'objective',
        castId: row.castId || null,
        userId: row.userId || null,
        confidence: 0.83
      });
      report.converted.session += 1;
    }

    for (const row of tasks) {
      const text = row && row.text ? String(row.text).trim() : '';
      if (!text) continue;
      await store.addScratchpadEntry(`Task: ${text}`, {
        source: 'migration',
        type: 'active_task',
        castId: row.castId || null,
        userId: row.userId || null,
        confidence: 0.7
      });
      report.converted.scratchpad += 1;
    }

    for (const row of recentTurns) {
      await store.addEpisodicEvent({
        type: 'legacy_turn',
        text: `${row.message || ''}\n${row.responseSummary || ''}`.trim(),
        castId: row.castId || null,
        userId: row.userId || null,
        source: 'migration',
        metadata: {
          timestamp: row.timestamp || null
        }
      });
      report.converted.episodic += 1;
    }

    for (const row of switches) {
      await store.addEpisodicEvent({
        type: 'switch',
        text: `Switch: ${row.from || 'none'} -> ${row.to || 'none'}`,
        castId: row.to || row.from || null,
        userId: row.userId || null,
        source: 'migration',
        metadata: {
          timestamp: row.timestamp || null,
          from: row.from || null,
          to: row.to || null
        }
      });
      report.converted.episodic += 1;
    }
  } else {
    report.notes.push('No legacy summary.json found.');
  }

  const eventsPath = path.join(legacyConversation, 'events.jsonl');
  if (await exists(eventsPath)) {
    const raw = await fs.readFile(eventsPath, 'utf8');
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        await store.addEpisodicEvent({
          type: `legacy_${row.type || 'event'}`,
          text: JSON.stringify(row),
          castId: row.castId || null,
          userId: row.userId || null,
          source: 'migration',
          metadata: row
        });
        report.converted.episodic += 1;
      } catch {
        report.skipped += 1;
      }
    }
  }

  if (await exists(castsPath)) {
    const entries = await fs.readdir(castsPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      const castId = entry.name;
      const scratchPath = path.join(castsPath, castId, 'memory', 'scratchpad.md');
      if (!(await exists(scratchPath))) continue;

      const archiveScratchPath = path.join(archiveDir, 'scratchpads', castId, 'scratchpad.md');
      await safeCopy(scratchPath, archiveScratchPath);
      report.copied.scratchpads += 1;

      const scratchRaw = await fs.readFile(scratchPath, 'utf8');
      const sections = parseScratchpadSections(scratchRaw);
      const activeTasks = String(sections['Active Tasks'] || '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('-'));
      const quickNotes = String(sections['Quick Notes'] || '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('<!--'));

      for (const task of activeTasks) {
        await store.addScratchpadEntry(task.replace(/^-\s*/, 'Task: '), {
          source: 'migration',
          type: 'active_task',
          castId,
          userId: null,
          confidence: 0.68
        });
        report.converted.scratchpad += 1;
      }

      for (const note of quickNotes) {
        await store.addScratchpadEntry(`Note: ${note.replace(/^-\s*/, '')}`, {
          source: 'migration',
          type: 'quick_note',
          castId,
          userId: null,
          confidence: 0.66
        });
        report.converted.scratchpad += 1;
      }
    }
  }

  await store.writeMigrationReport(report);
  return report;
}

module.exports = {
  migrateContextV2
};
