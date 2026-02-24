const test = require('node:test');
const assert = require('node:assert/strict');

const { ConflictDetector } = require('../src/ConflictDetector');

test('detects polarity conflict for similar statements', () => {
  const detector = new ConflictDetector({ similarityThreshold: 0.4 });
  const next = {
    id: 'b',
    text: 'We must not deploy to production without unit tests.'
  };
  const existing = [{
    id: 'a',
    text: 'We must deploy to production without unit tests.',
    status: 'active'
  }];

  const conflicts = detector.detectAgainst(next, existing);
  assert.ok(conflicts.length >= 1);
  assert.equal(conflicts[0].a, 'a');
});
