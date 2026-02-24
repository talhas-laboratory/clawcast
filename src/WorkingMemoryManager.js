/**
 * WorkingMemoryManager - Self-managing scratchpad and user memory
 * 
 * Philosophy: The agent manages its own memory automatically
 * - Captures what matters without user commands
 * - Surfaces context when relevant
 * - Cleans up what’s no longer needed
 */

const fs = require('fs').promises;
const path = require('path');

class WorkingMemoryManager {
  constructor(castRoot, options = {}) {
    this.castRoot = castRoot;
    this.memoryPath = path.join(castRoot, 'memory');
    this.scratchpadPath = path.join(this.memoryPath, 'scratchpad.md');
    this.usersPath = path.join(this.memoryPath, 'users');
    this.contextStore = options.contextStore || null;
    this.castId = options.castId || path.basename(castRoot || '');
  }

  /**
   * Initialize memory structure
   */
  async initialize() {
    await fs.mkdir(this.memoryPath, { recursive: true });
    await fs.mkdir(this.usersPath, { recursive: true });
    
    // Create scratchpad if doesn't exist
    try {
      await fs.access(this.scratchpadPath);
    } catch {
      await this.createScratchpad();
    }
  }

  /**
   * Create new scratchpad
   */
  async createScratchpad() {
    const now = new Date().toISOString();
    const fourHoursLater = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    const sessionId = Math.random().toString(36).substring(2, 15);
    
    const templatePath = path.join(__dirname, 'templates', 'scratchpad.md');
    let content;
    
    try {
      content = await fs.readFile(templatePath, 'utf8');
    } catch {
      content = this.getDefaultScratchpadTemplate();
    }
    
    content = content
      .replace(/{{timestamp}}/g, now)
      .replace(/{{clearTime}}/g, fourHoursLater)
      .replace(/{{sessionId}}/g, sessionId);
    
    await fs.writeFile(this.scratchpadPath, content);
    return { created: true, sessionId };
  }

  /**
   * Get current scratchpad content
   */
  async getScratchpad() {
    try {
      const content = await fs.readFile(this.scratchpadPath, 'utf8');
      return this.parseScratchpad(content);
    } catch {
      await this.createScratchpad();
      return this.getScratchpad();
    }
  }

  /**
   * Parse scratchpad into structured object
   */
  parseScratchpad(content) {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    
    let metadata = {};
    let body = content;
    
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      body = frontmatterMatch[2];
      
      // Parse simple YAML
      frontmatter.split('\n').forEach(line => {
        const match = line.match(/^(\w+):\s*(.+)$/);
        if (match) {
          let value = match[2].replace(/^"|"$/g, '');
          if (match[1] === 'messageCount') {
            value = parseInt(value) || 0;
          }
          metadata[match[1]] = value;
        }
      });
    }

    // Parse sections
    const sections = {};
    const sectionMatches = body.matchAll(/## ([^\n]+)\n([\s\S]*?)(?=\n## |$)/g);
    for (const match of sectionMatches) {
      const sectionName = match[1].trim();
      const sectionContent = match[2].trim();
      sections[sectionName] = sectionContent;
    }

    return { metadata, sections, raw: content };
  }

  /**
   * Update scratchpad section
   */
  async updateScratchpad(section, content, append = false) {
    const scratchpad = await this.getScratchpad();
    
    // Clean up template placeholders
    const cleanPlaceholder = (text) => {
      return text
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/^\s*$\n/g, '\n')
        .trim();
    };
    
    let existing = cleanPlaceholder(scratchpad.sections[section] || '');
    
    if (append && existing) {
      // Check if already exists to avoid duplicates
      if (!existing.includes(content)) {
        scratchpad.sections[section] = existing + '\n' + content;
      }
    } else {
      scratchpad.sections[section] = content;
    }

    // Update metadata
    scratchpad.metadata.lastUpdated = new Date().toISOString();
    scratchpad.metadata.messageCount = parseInt(scratchpad.metadata.messageCount || 0) + 1;

    // Rebuild content
    const newContent = this.buildScratchpad(scratchpad.metadata, scratchpad.sections);
    await fs.writeFile(this.scratchpadPath, newContent);

    if (this.contextStore) {
      const sectionTypeMap = {
        'Active Tasks': 'active_task',
        'Quick Notes': 'quick_note',
        'Drafts': 'draft',
        'Links to Revisit': 'reference_link'
      };
      await this.contextStore.addScratchpadEntry(content, {
        type: sectionTypeMap[section] || 'scratch_note',
        source: 'system',
        castId: this.castId,
        confidence: 0.6
      });
    }
    
    return { updated: true, section };
  }

  /**
   * Build scratchpad from metadata and sections
   */
  buildScratchpad(metadata, sections) {
    const frontmatter = Object.entries(metadata)
      .map(([key, value]) => `${key}: "${value}"`)
      .join('\n');

    const sectionsContent = Object.entries(sections)
      .map(([name, content]) => `## ${name}\n${content}`)
      .join('\n\n');

    return `---\n${frontmatter}\n---\n\n# Working Memory\n\n*This is your desk - temporary workspace for this session. Auto-clears after 4 hours of inactivity.*\n\n${sectionsContent}\n\n---\n\n*Last updated: ${metadata.lastUpdated}*`;
  }

  /**
   * Clear scratchpad (start fresh)
   */
  async clearScratchpad() {
    await this.createScratchpad();
    return { cleared: true };
  }

  /**
   * Auto-cleanup old scratchpad (check if expired)
   */
  async autoCleanup() {
    try {
      const scratchpad = await this.getScratchpad();
      const autoClear = new Date(scratchpad.metadata.autoClear);
      
      if (autoClear < new Date()) {
        await this.clearScratchpad();
        return { cleaned: true, reason: 'expired' };
      }
      
      return { cleaned: false, expiresIn: autoClear - new Date() };
    } catch {
      return { cleaned: false, error: 'Failed to check' };
    }
  }

  /**
   * Get or create user memory
   */
  async getUserMemory(userId) {
    const userPath = path.join(this.usersPath, `${userId}.md`);
    
    try {
      const content = await fs.readFile(userPath, 'utf8');
      return this.parseUserMemory(content, userId);
    } catch {
      // Create new user memory
      return this.createUserMemory(userId);
    }
  }

  /**
   * Create new user memory file
   */
  async createUserMemory(userId) {
    const userPath = path.join(this.usersPath, `${userId}.md`);
    const now = new Date().toISOString();
    
    const templatePath = path.join(__dirname, 'templates', 'user-memory.md');
    let content;
    
    try {
      content = await fs.readFile(templatePath, 'utf8');
    } catch {
      content = this.getDefaultUserTemplate();
    }
    
    content = content
      .replace(/{{userId}}/g, userId)
      .replace(/{{timestamp}}/g, now);
    
    await fs.writeFile(userPath, content);
    return this.parseUserMemory(content, userId);
  }

  /**
   * Parse user memory into structured object
   */
  parseUserMemory(content, userId) {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    
    let metadata = { userId };
    let body = content;
    
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      body = frontmatterMatch[2];
      
      frontmatter.split('\n').forEach(line => {
        const match = line.match(/^(\w+):\s*(.+)$/);
        if (match) {
          let value = match[2].replace(/^"|"$/g, '');
          if (value === 'null') value = null;
          if (match[1] === 'totalConversations') {
            value = parseInt(value) || 0;
          }
          metadata[match[1]] = value;
        }
      });
    }

    // Parse sections
    const sections = {};
    const sectionMatches = body.matchAll(/## ([^\n]+)\n([\s\S]*?)(?=\n## |$)/g);
    for (const match of sectionMatches) {
      const sectionName = match[1].trim();
      const sectionContent = match[2].trim();
      sections[sectionName] = sectionContent;
    }

    return { metadata, sections, raw: content };
  }

  /**
   * Update user memory section
   */
  async updateUserMemory(userId, section, content, append = false) {
    const userPath = path.join(this.usersPath, `${userId}.md`);
    const userMemory = await this.getUserMemory(userId);
    
    if (append && userMemory.sections[section]) {
      userMemory.sections[section] += '\n' + content;
    } else {
      userMemory.sections[section] = content;
    }

    // Update metadata
    userMemory.metadata.lastInteraction = new Date().toISOString();
    if (section === 'Conversation History Summary') {
      userMemory.metadata.totalConversations = (userMemory.metadata.totalConversations || 0) + 1;
    }

    // Rebuild content
    const newContent = this.buildUserMemory(userMemory.metadata, userMemory.sections);
    await fs.writeFile(userPath, newContent);
    
    return { updated: true, section };
  }

  /**
   * Build user memory from metadata and sections
   */
  buildUserMemory(metadata, sections) {
    const frontmatter = Object.entries(metadata)
      .map(([key, value]) => {
        if (value === null) return `${key}: null`;
        return `${key}: "${value}"`;
      })
      .join('\n');

    const sectionsContent = Object.entries(sections)
      .map(([name, content]) => `## ${name}\n${content}`)
      .join('\n\n');

    return `---\n${frontmatter}\n---\n\n# User Profile\n\n${sectionsContent}\n\n---\n\n*This profile auto-updates based on your interactions. Review periodically for accuracy.*`;
  }

  /**
   * Auto-capture from interaction
   * This is where the "intelligence" happens
   */
  async autoCapture(userId, message, response, context = {}) {
    const captures = [];
    
    // 1. Detect preferences (separate from tasks)
    const preferencePatterns = [
      { regex: /\b(?:i|we)\s+(?:like|prefer|love|enjoy|want)\s+([^\.]+)/i, type: 'preference' },
      { regex: /\b(?:i|we)\s+(?:don't like|dislike|hate|avoid)\s+([^\.]+)/i, type: 'avoidance' },
      { regex: /\b(?:actually|instead)\s+(?:i|we)\s+(?:want|prefer|like)\s+([^\.]+)/i, type: 'correction' },
      { regex: /\b(?:my|our)\s+(?:name|email|preference|style|approach)\s+(?:is|was)\s+([^\.]+)/i, type: 'preference' },
    ];
    
    for (const pattern of preferencePatterns) {
      const match = message.match(pattern.regex);
      if (match && match[1]) {
        const content = match[1].trim();
        if (content.length < 3) continue;
        
        await this.updateUserMemory(userId, 'Preferences Learned', 
          `- **${pattern.type}**: ${content}`, true);
        captures.push({ type: pattern.type, section: 'Preferences Learned', content });
      }
    }
    
    // 2. Detect tasks separately (go to scratchpad)
    const taskPatterns = [
      /\bi\s+(?:am|'m)\s+working\s+(?:on|with)\s+([^\.]+)/i,
      /\bi\s+need\s+to\s+([^\.]+)/i,
      /\b(?:we|let'?s)\s+(?:should|need to|will)\s+([^\.]+)/i,
      /\bmy\s+(?:project|goal)\s+(?:is|on|was)\s+([^\.]+)/i,
    ];
    
    for (const pattern of taskPatterns) {
      const match = message.match(pattern);
      if (match && match[1]) {
        const task = match[1].trim();
        if (task.length < 3) continue;
        
        await this.updateScratchpad('Active Tasks', `- [ ] ${task}`, true);
        captures.push({ type: 'task', section: 'Active Tasks', content: task });
      }
    }

    // 3. Note waiting items
    const waitingPatterns = [
      /\b(?:i'll|i will)\s+([^\.]+?)(?:\s+later|\s+tomorrow|\s+soon|\s+when|\s+than|\s*)/i,
      /\b(?:send|give|provide|share)\s+(?:you|me)\s+([^\.]+?)(?:\s+later|\s+tomorrow|\s+soon)/i,
      /\b(?:waiting|waiting for)\s+(?:you|for)\s+([^\.]+)/i,
    ];
    
    for (const pattern of waitingPatterns) {
      const match = message.match(pattern);
      if (match && match[1]) {
        const item = match[1].trim();
        if (item.length < 3) continue;
        await this.updateScratchpad(
          'Quick Notes',
          `- **Waiting for**: ${item}`,
          true
        );
        captures.push({ type: 'waiting', content: item });
      }
    }

    if (this.contextStore) {
      const routed = await this.contextStore.captureAuto({
        castId: this.castId,
        userId,
        message,
        response
      });
      return {
        captured: captures.length > 0 || !!routed.captured,
        captures: [...captures, ...(routed.captures || [])],
        intentState: routed.intentState || null
      };
    }

    return { captured: captures.length > 0, captures };
  }

  /**
   * Get context for injection into prompt
   */
  async getContextForPrompt(userId) {
    const [scratchpad, userMemory] = await Promise.all([
      this.getScratchpad(),
      this.getUserMemory(userId)
    ]);

    const context = {
      workingMemory: this.formatScratchpadForPrompt(scratchpad),
      userContext: this.formatUserMemoryForPrompt(userMemory)
    };

    if (this.contextStore) {
      const snapshot = await this.contextStore.getContextSnapshot({
        castId: this.castId,
        userId
      });
      context.contextV2 = snapshot;
    }

    return context;
  }

  /**
   * Format scratchpad for prompt injection
   */
  formatScratchpadForPrompt(scratchpad) {
    const lines = [];
    
    if (scratchpad.sections['Active Tasks']) {
      const tasks = scratchpad.sections['Active Tasks']
        .split('\n')
        .filter(l => l.trim() && !l.includes('<!--'));
      if (tasks.length > 0) {
        lines.push('**Active Tasks:**');
        tasks.slice(0, 5).forEach(t => lines.push(t));
      }
    }

    if (scratchpad.sections['Quick Notes']) {
      const notes = scratchpad.sections['Quick Notes']
        .split('\n')
        .filter(l => l.trim() && !l.includes('<!--'));
      if (notes.length > 0) {
        lines.push('\n**Notes:**');
        notes.slice(0, 3).forEach(n => lines.push(n.replace(/^- /, '')));
      }
    }

    return lines.join('\n') || 'None';
  }

  /**
   * Format user memory for prompt injection
   */
  formatUserMemoryForPrompt(userMemory) {
    const lines = [];
    const meta = userMemory.metadata;
    
    if (meta.preferredName) {
      lines.push(`**User**: ${meta.preferredName}`);
    }

    const prefs = userMemory.sections['Preferences Learned'];
    if (prefs) {
      const prefLines = prefs.split('\n')
        .filter(l => l.trim().startsWith('-'))
        .slice(0, 5);
      if (prefLines.length > 0) {
        lines.push('\n**Known Preferences:**');
        prefLines.forEach(p => lines.push(p));
      }
    }

    const projects = userMemory.sections['Goals & Projects'];
    if (projects && projects.includes('### Active')) {
      const activeMatch = projects.match(/### Active\n([\s\S]*?)(?=### |$)/);
      if (activeMatch) {
        const activeProjects = activeMatch[1].split('\n').filter(l => l.trim().startsWith('-')).slice(0, 3);
        if (activeProjects.length > 0) {
          lines.push('\n**Active Projects:**');
          activeProjects.forEach(p => lines.push(p));
        }
      }
    }

    return lines.length > 0 ? lines.join('\n') : 'None yet - building profile from conversation.';
  }

  getDefaultScratchpadTemplate() {
    return `---
lastUpdated: "{{timestamp}}"
autoClear: "{{clearTime}}"
sessionId: "{{sessionId}}"
messageCount: 0
---

# Working Memory

*This is your desk - temporary workspace for this session.*

## Active Tasks

## Quick Notes

## Drafts

## Links to Revisit
`;
  }

  getDefaultUserTemplate() {
    return `---
userId: "{{userId}}"
firstSeen: "{{timestamp}}"
lastInteraction: "{{timestamp}}"
totalConversations: 0
preferredName: null
---

# User Profile

## Communication Preferences
- **Detail level**: 
- **Style**: 
- **Pace**: 
- **Tone**: 

## Technical Context
- **Primary stack**: 
- **Current projects**: 

## Goals & Projects
### Active

### Completed

## Preferences Learned

## Interaction Patterns

## Successful Approaches

## Things to Remember
`;
  }
}

module.exports = WorkingMemoryManager;
