function estimateTokens(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.35);
}

function clampByTokens(rows, budgetTokens) {
  const kept = [];
  const dropped = [];
  let used = 0;
  for (const row of rows) {
    const text = String(row && row.text ? row.text : '');
    const cost = estimateTokens(text);
    if (used + cost <= budgetTokens) {
      kept.push(row);
      used += cost;
    } else {
      dropped.push(row);
    }
  }
  return { kept, dropped, used };
}

class ContextAssembler {
  constructor(config = {}) {
    this.tokenBudget = Number.isFinite(config.tokenBudget) ? Number(config.tokenBudget) : 1800;
    this.weights = {
      contract: 0.35,
      session: 0.30,
      references: 0.20,
      scratchpad: 0.15,
      ...(config.weights || {})
    };
  }

  assemble(snapshot = {}, options = {}) {
    const tokenBudget = Number.isFinite(options.tokenBudget) ? Number(options.tokenBudget) : this.tokenBudget;
    const bucketBudget = {
      contract: Math.max(120, Math.floor(tokenBudget * this.weights.contract)),
      session: Math.max(120, Math.floor(tokenBudget * this.weights.session)),
      references: Math.max(90, Math.floor(tokenBudget * this.weights.references)),
      scratchpad: Math.max(90, Math.floor(tokenBudget * this.weights.scratchpad))
    };

    const activeContract = (snapshot.contractRules || []).filter((item) => item && item.status !== 'conflicted');
    const sessionRows = (snapshot.sessionEntries || []).filter(Boolean);
    const referenceRows = (snapshot.references || []).filter(Boolean);
    const scratchRows = (snapshot.scratchpadEntries || []).filter(Boolean);

    const contractCut = clampByTokens(activeContract, bucketBudget.contract);
    const sessionCut = clampByTokens(sessionRows, bucketBudget.session);
    const referencesCut = clampByTokens(referenceRows, bucketBudget.references);
    const scratchCut = clampByTokens(scratchRows, bucketBudget.scratchpad);

    const lines = [];
    const renderSection = (title, rows) => {
      if (!rows.length) return;
      lines.push(`## ${title}`);
      for (const row of rows) {
        lines.push(`- ${String(row.text || '').trim()}`);
      }
      lines.push('');
    };

    renderSection('Contract Memory', contractCut.kept);
    renderSection('Session Frame', sessionCut.kept);
    renderSection('References', referencesCut.kept);
    renderSection('Working Scratchpad', scratchCut.kept);

    const assembledText = lines.join('\n').trim() || 'No context available.';
    const tokenEstimate = estimateTokens(assembledText);

    return {
      assembledText,
      sections: {
        contract: contractCut.kept,
        session: sessionCut.kept,
        references: referencesCut.kept,
        scratchpad: scratchCut.kept
      },
      dropped: {
        contract: contractCut.dropped,
        session: sessionCut.dropped,
        references: referencesCut.dropped,
        scratchpad: scratchCut.dropped
      },
      tokenEstimate,
      intentState: snapshot.intentState || 'implementation',
      conflicts: snapshot.conflicts || []
    };
  }
}

module.exports = {
  ContextAssembler,
  estimateTokens
};
