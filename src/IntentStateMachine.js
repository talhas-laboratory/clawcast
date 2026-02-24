const STATES = ['discovery', 'planning', 'implementation', 'debugging', 'review', 'handoff'];

class IntentStateMachine {
  constructor() {
    this.window = [];
    this.maxWindow = 30;
  }

  infer(input = {}) {
    const text = String(input.text || '').toLowerCase();
    const command = String(input.command || '').toLowerCase();

    let inferred = 'implementation';
    if (/\b(why|what|how|explore|research|investigate|understand)\b/.test(text)) {
      inferred = 'discovery';
    }
    if (/\b(plan|roadmap|spec|design|architecture)\b/.test(text)) {
      inferred = 'planning';
    }
    if (/\b(bug|error|failing|failure|stack trace|fix)\b/.test(text) || /\/debug\b/.test(command)) {
      inferred = 'debugging';
    }
    if (/\b(review|audit|check|qa|verify|validation)\b/.test(text)) {
      inferred = 'review';
    }
    if (/\b(handoff|delegate|transfer|pass to)\b/.test(text)) {
      inferred = 'handoff';
    }
    if (/\b(implement|build|code|patch|refactor|deploy)\b/.test(text)) {
      inferred = 'implementation';
    }

    this.window.unshift(inferred);
    this.window = this.window.slice(0, this.maxWindow);

    return inferred;
  }

  dominantState() {
    if (!this.window.length) return 'implementation';
    const counts = new Map();
    for (const state of this.window) {
      counts.set(state, (counts.get(state) || 0) + 1);
    }
    let best = 'implementation';
    let max = -1;
    for (const state of STATES) {
      const n = counts.get(state) || 0;
      if (n > max) {
        max = n;
        best = state;
      }
    }
    return best;
  }
}

module.exports = {
  IntentStateMachine,
  STATES
};
