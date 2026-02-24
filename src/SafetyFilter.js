const SECRET_PATTERNS = [
  {
    name: 'openai_key',
    regex: /\bsk-[a-zA-Z0-9_-]{16,}\b/g,
    replacement: '[REDACTED_OPENAI_KEY]',
    deny: false
  },
  {
    name: 'google_api_key',
    regex: /\bAIza[0-9A-Za-z\-_]{20,}\b/g,
    replacement: '[REDACTED_GOOGLE_KEY]',
    deny: false
  },
  {
    name: 'bearer_token',
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/g,
    replacement: 'Bearer [REDACTED_TOKEN]',
    deny: false
  },
  {
    name: 'private_key',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[DENIED_PRIVATE_KEY_MATERIAL]',
    deny: true
  },
  {
    name: 'password_assignment',
    regex: /\b(password|passwd|pwd)\s*[:=]\s*[^\s]+/gi,
    replacement: '$1=[REDACTED]',
    deny: false
  }
];

class SafetyFilter {
  constructor(config = {}) {
    this.enabled = config.enabled !== false;
    this.redact = config.redact !== false;
  }

  sanitizeText(rawText) {
    const input = String(rawText || '');
    if (!this.enabled || !input.trim()) {
      return {
        allowed: true,
        text: input,
        safetyFlags: [],
        redacted: false
      };
    }

    let text = input;
    let denied = false;
    let redacted = false;
    const safetyFlags = [];

    for (const pattern of SECRET_PATTERNS) {
      if (!pattern.regex.test(text)) {
        pattern.regex.lastIndex = 0;
        continue;
      }
      pattern.regex.lastIndex = 0;
      safetyFlags.push(pattern.name);
      if (pattern.deny) {
        denied = true;
      }
      if (this.redact) {
        text = text.replace(pattern.regex, pattern.replacement);
        redacted = true;
      }
    }

    return {
      allowed: !denied,
      text,
      safetyFlags,
      redacted
    };
  }
}

module.exports = SafetyFilter;
