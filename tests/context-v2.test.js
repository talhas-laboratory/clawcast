const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const ContextStore = require('../src/ContextStore');
const { ContextAssembler } = require('../src/ContextAssembler');

test('stores contract/session/scratch entries and assembles prompt', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cast-context-v2-'));
  const store = new ContextStore({ workspaceRoot: root, config: { tokenBudget: 500 } });
  await store.initialize();

  await store.addContractRule('Policy: always run tests before deploy.', {
    source: 'user_explicit_nl',
    confidence: 0.95
  });
  await store.setSessionFrame({
    objective: 'Ship context v2 safely',
    acceptanceCriteria: ['No regressions', 'Migration report generated']
  }, { source: 'system' });
  await store.addScratchpadEntry('Task: validate /api/cast-manager responses', {
    type: 'active_task',
    source: 'auto_capture'
  });

  const snapshot = await store.getContextSnapshot({ query: 'deploy tests' });
  const assembler = new ContextAssembler({ tokenBudget: 500 });
  const assembled = assembler.assemble(snapshot);

  assert.ok(assembled.assembledText.includes('Contract Memory'));
  assert.ok(assembled.assembledText.includes('Policy: always run tests before deploy.'));
  assert.ok(assembled.tokenEstimate > 0);
});
