const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const ContextStore = require('../src/ContextStore');
const { migrateContextV2 } = require('../src/migrations/migrate-context-v2');

test('migrates legacy summary and scratchpad into context v2', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cast-migration-v2-'));
  const workspaceRoot = path.join(root, 'workspace');
  const castsPath = path.join(workspaceRoot, 'casts');
  const legacyConversation = path.join(workspaceRoot, 'cast-shared', 'conversation');
  const castScratch = path.join(castsPath, 'architect', 'memory');

  await fs.mkdir(legacyConversation, { recursive: true });
  await fs.mkdir(castScratch, { recursive: true });

  await fs.writeFile(path.join(legacyConversation, 'summary.json'), JSON.stringify({
    decisions: [{ text: 'must use linting gates', castId: 'architect', userId: 'u1' }],
    goals: [{ text: 'ship migration' }],
    tasks: [{ text: 'rewrite old context' }],
    recentTurns: [{ castId: 'architect', userId: 'u1', message: 'hello', responseSummary: 'world' }],
    switches: []
  }, null, 2), 'utf8');

  await fs.writeFile(path.join(castScratch, 'scratchpad.md'), '## Active Tasks\n- [ ] verify migration\n\n## Quick Notes\n- keep archive\n', 'utf8');

  const store = new ContextStore({ workspaceRoot });
  await store.initialize();

  const report = await migrateContextV2({ store, workspaceRoot, castsPath });

  assert.ok(report.converted.contract + report.converted.session + report.converted.scratchpad > 0);
  const rules = await store.listContractRules();
  assert.ok(rules.length >= 1);
});
