/**
 * CastMemoryManager - Manages conversation memory for casts
 * 
 * Features:
 * - Save conversations when leaving a cast
 * - Extract topics and summaries
 * - Search through memories
 * - Retrieve recent conversations
 */

const fs = require('fs').promises;
const path = require('path');

class CastMemoryManager {
  constructor(cast) {
    this.cast = cast;
    this.memoryPath = path.join(cast.path, 'memory', 'conversations');
  }

  /**
   * Initialize - ensure memory directory exists
   */
  async initialize() {
    try {
      await fs.mkdir(this.memoryPath, { recursive: true });
    } catch (error) {
      console.error('Failed to initialize memory directory:', error);
    }
  }

  /**
   * Save a conversation when leaving a cast
   */
  async saveConversation(options = {}) {
    const {
      startTime,
      endTime,
      summary = '',
      topics = [],
      decisions = [],
      actionItems = [],
      keyPoints = [],
      conversation = []
    } = options;

    await this.initialize();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const topicSlug = topics[0]?.toLowerCase().replace(/\s+/g, '-') || 'general';
    const filename = `${timestamp}_${topicSlug}.md`;
    const filePath = path.join(this.memoryPath, filename);

    const duration = startTime && endTime 
      ? Math.round((new Date(endTime) - new Date(startTime)) / 60000) + ' minutes'
      : 'unknown';

    const content = this.buildMemoryContent({
      date: new Date().toISOString(),
      cast: this.cast.config.name,
      castId: this.cast.id,
      duration,
      topics,
      summary,
      decisions,
      actionItems,
      keyPoints,
      conversation
    });

    try {
      await fs.writeFile(filePath, content);
      console.log(`[MemoryManager] Saved conversation: ${filename}`);
      return {
        success: true,
        file: filename,
        path: filePath
      };
    } catch (error) {
      console.error('[MemoryManager] Failed to save conversation:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Build memory document content
   */
  buildMemoryContent(data) {
    const {
      date,
      cast,
      castId,
      duration,
      topics,
      summary,
      decisions,
      actionItems,
      keyPoints,
      conversation
    } = data;

    const topicsYaml = topics.map(t => `  - "${t}"`).join('\n');
    const decisionsList = decisions.map(d => `- ${d}`).join('\n') || '- None recorded';
    const actionItemsList = actionItems.map(a => `- [ ] ${a}`).join('\n') || '- None recorded';
    const keyPointsList = keyPoints.map(k => `- ${k}`).join('\n') || '- None recorded';

    // Build conversation excerpt (last 10 messages, truncated)
    let conversationExcerpt = '';
    if (conversation && conversation.length > 0) {
      const recentMessages = conversation.slice(-10);
      conversationExcerpt = recentMessages.map(msg => {
        const role = msg.role === 'user' ? '**User**' : `**${cast}**`;
        const content = msg.content?.substring(0, 500) || '';
        const truncated = msg.content?.length > 500 ? '...' : '';
        return `### ${role}\n${content}${truncated}\n`;
      }).join('\n');
    }

    return `---
date: "${date}"
cast: "${cast}"
castId: "${castId}"
type: "conversation"
duration: "${duration}"
topics:
${topicsYaml || '  - "general"'}
---

# Conversation with ${cast}

## Summary
${summary || 'A conversation with the ' + cast + ' persona.'}

## Duration
${duration}

## Key Points
${keyPointsList}

## Decisions Made
${decisionsList}

## Action Items
${actionItemsList}

## Conversation Excerpt

${conversationExcerpt || '_No conversation excerpt available_'}

---

*Auto-saved when leaving cast*
`;
  }

  /**
   * Get recent conversations
   */
  async getRecent(limit = 5) {
    try {
      await this.initialize();
      const files = await fs.readdir(this.memoryPath);
      
      const conversations = await Promise.all(
        files
          .filter(f => f.endsWith('.md'))
          .sort().reverse() // Most recent first
          .slice(0, limit)
          .map(async (file) => {
            const content = await fs.readFile(path.join(this.memoryPath, file), 'utf8');
            const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
            const metadata = frontmatterMatch ? this.parseFrontmatter(frontmatterMatch[1]) : {};
            return {
              file,
              date: metadata.date,
              topics: metadata.topics,
              summary: content.match(/## Summary\n([\s\S]*?)(?=\n##)/)?.[1]?.trim()
            };
          })
      );

      return conversations;
    } catch (error) {
      console.error('[MemoryManager] Failed to get recent conversations:', error);
      return [];
    }
  }

  /**
   * Search through memories
   */
  async search(query) {
    try {
      await this.initialize();
      const files = await fs.readdir(this.memoryPath);
      const results = [];

      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        
        const content = await fs.readFile(path.join(this.memoryPath, file), 'utf8');
        if (content.toLowerCase().includes(query.toLowerCase())) {
          const lines = content.split('\n');
          const summaryLine = lines.find(l => l.startsWith('## Summary'));
          const summary = summaryLine ? 
            lines[lines.indexOf(summaryLine) + 1] : 
            'No summary available';
          
          results.push({
            file,
            summary: summary.trim()
          });
        }
      }

      return results;
    } catch (error) {
      console.error('[MemoryManager] Search failed:', error);
      return [];
    }
  }

  /**
   * Parse YAML frontmatter
   */
  parseFrontmatter(yaml) {
    const metadata = {};
    const lines = yaml.split('\n');
    let currentKey = null;
    let currentArray = [];

    for (const line of lines) {
      const keyValueMatch = line.match(/^(\w+):\s*(.+)$/);
      const arrayItemMatch = line.match(/^\s+-\s*(.+)$/);

      if (keyValueMatch) {
        if (currentKey && currentArray.length > 0) {
          metadata[currentKey] = currentArray;
        }
        currentKey = keyValueMatch[1];
        currentArray = [];
        const value = keyValueMatch[2].replace(/^"|"$/g, '');
        if (!line.includes('-')) {
          metadata[currentKey] = value;
          currentKey = null;
        }
      } else if (arrayItemMatch && currentKey) {
        currentArray.push(arrayItemMatch[1].replace(/^"|"$/g, ''));
      }
    }

    if (currentKey && currentArray.length > 0) {
      metadata[currentKey] = currentArray;
    }

    return metadata;
  }
}

module.exports = CastMemoryManager;
