const crypto = require('crypto');

const NEGATIVE_WORDS = ['must not', "can't", 'cannot', 'never', 'avoid', 'forbidden', 'prohibited'];
const POSITIVE_WORDS = ['must', 'always', 'required', 'should', 'recommended'];

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value) {
  return normalizeText(value)
    .split(' ')
    .filter((term) => term.length > 2);
}

function jaccardSimilarity(a, b) {
  const aSet = new Set(tokenize(a));
  const bSet = new Set(tokenize(b));
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const item of aSet) {
    if (bSet.has(item)) inter += 1;
  }
  const union = new Set([...aSet, ...bSet]).size;
  return union > 0 ? inter / union : 0;
}

function polarityOf(text) {
  const normalized = normalizeText(text);
  const hasNeg = NEGATIVE_WORDS.some((item) => normalized.includes(item));
  const hasPos = POSITIVE_WORDS.some((item) => normalized.includes(item));
  if (hasNeg && !hasPos) return 'negative';
  if (!hasNeg && hasPos) return 'positive';
  return 'neutral';
}

class ConflictDetector {
  constructor(config = {}) {
    this.enabled = config.enabled !== false;
    this.similarityThreshold = Number.isFinite(config.similarityThreshold)
      ? Number(config.similarityThreshold)
      : 0.62;
  }

  detectAgainst(entry, existingEntries = []) {
    if (!this.enabled) return [];
    const nextText = String(entry && entry.text ? entry.text : '');
    if (!nextText.trim()) return [];
    const nextPolarity = polarityOf(nextText);

    const conflicts = [];
    for (const candidate of existingEntries) {
      if (!candidate || !candidate.text) continue;
      if (candidate.status === 'resolved') continue;
      const similarity = jaccardSimilarity(nextText, candidate.text);
      if (similarity < this.similarityThreshold) continue;

      const candidatePolarity = polarityOf(candidate.text);
      const samePolarity = nextPolarity === candidatePolarity;
      const oppositePolarity =
        (nextPolarity === 'negative' && candidatePolarity === 'positive') ||
        (nextPolarity === 'positive' && candidatePolarity === 'negative');
      if (!oppositePolarity && !(!samePolarity && similarity > 0.82)) {
        continue;
      }

      const id = crypto
        .createHash('sha1')
        .update(`${entry.id || 'new'}:${candidate.id || 'existing'}:${similarity.toFixed(3)}`)
        .digest('hex')
        .slice(0, 16);

      conflicts.push({
        id: `conf-${id}`,
        a: candidate.id || null,
        b: entry.id || null,
        reason: oppositePolarity ? 'polarity_inversion' : 'semantic_contradiction',
        similarity,
        createdAt: new Date().toISOString(),
        status: 'open'
      });
    }

    return conflicts;
  }
}

module.exports = {
  ConflictDetector,
  normalizeText,
  tokenize,
  jaccardSimilarity,
  polarityOf
};
