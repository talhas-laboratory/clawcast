#!/usr/bin/env node

/**
 * Cast Auto-Population System
 * 
 * Automatically creates and maintains cast profiles, context, and memory.
 * Runs whenever a new cast is created or an existing cast needs updating.
 */

const fs = require('fs').promises;
const path = require('path');

class CastAutoPopulator {
  constructor(workspaceRoot) {
    // If workspaceRoot not provided, calculate from this file's location
    // This file is in cast-system/lib/, so go up two levels to get workspace root
    this.workspaceRoot = workspaceRoot || path.join(__dirname, '..', '..');
    this.castsDir = path.join(this.workspaceRoot, 'casts');
    this.templatesDir = path.join(this.castsDir, '_templates');
    console.log(`[AutoPopulate] Workspace root: ${this.workspaceRoot}`);
    console.log(`[AutoPopulate] Casts dir: ${this.castsDir}`);
  }

  /**
   * Main entry point - populate or update a cast
   */
  async populate(castId, options = {}) {
    console.log(`[AutoPopulate] Processing cast: ${castId}`);
    
    const castPath = path.join(this.castsDir, castId);
    
    // Ensure directory structure exists
    await this.ensureStructure(castPath);
    
    // Load or create cast.json
    const config = await this.loadOrCreateConfig(castId, castPath, options);
    
    // Generate profile if missing or empty
    await this.generateProfile(castId, castPath, config);
    
    // Generate system files
    await this.generateSystemFiles(castId, castPath, config);
    
    // Create context examples
    await this.generateContextExamples(castId, castPath, config);
    
    // Create memory templates
    await this.generateMemoryTemplates(castId, castPath, config);
    
    // Initialize index
    await this.initializeIndex(castPath);
    
    // Update cast index
    await this.updateCastIndex(castId, config);
    
    console.log(`[AutoPopulate] Complete for ${castId}`);
    return { success: true, castId, config };
  }

  /**
   * Ensure all required directories exist
   */
  async ensureStructure(castPath) {
    const dirs = ['system', 'context', 'memory', 'logs', 'index', 'documents'];
    for (const dir of dirs) {
      const dirPath = path.join(castPath, dir);
      try {
        await fs.mkdir(dirPath, { recursive: true });
      } catch (e) {
        // Directory may already exist
      }
    }
    
    // Create documents/README.md
    const documentsReadmePath = path.join(castPath, 'documents', 'README.md');
    try {
      await fs.access(documentsReadmePath);
    } catch {
      const readme = `# Documents

This is your personal file storage for this cast.

## Usage
- Upload files via the Files tab in the Mini App
- Organize with folders
- Access files for context in conversations
- Search through all your documents

## Supported Files
- Text files (.md, .txt, .json, code files)
- PDFs (for reference)
- Images (for visual context)
- Any other files you need

## Tips
- Create folders to organize by topic
- Name files descriptively
- Regular files are automatically indexed for search
- Use this space for notes, references, templates, etc.

---

*Auto-generated for ${path.basename(castPath)}*`;
      await fs.writeFile(documentsReadmePath, readme);
      console.log(`[AutoPopulate] Created documents/README.md`);
    }
  }

  /**
   * Load existing config or create new one
   */
  async loadOrCreateConfig(castId, castPath, options) {
    const configPath = path.join(castPath, 'cast.json');
    
    try {
      const existing = await fs.readFile(configPath, 'utf8');
      const config = JSON.parse(existing);
      console.log(`[AutoPopulate] Loaded existing config for ${castId}`);
      return config;
    } catch {
      // Create new config
      const config = {
        id: castId,
        name: options.name || this.generateName(castId),
        emoji: options.emoji || '🔹',
        color: options.color || this.generateColor(castId),
        description: options.description || this.generateDescription(castId),
        activation_patterns: options.activationPatterns || this.generatePatterns(castId),
        capabilities: options.capabilities || this.generateCapabilities(castId),
        preferred_output_formats: ['markdown', 'json', 'code'],
        related_casts: [],
        created: new Date().toISOString(),
        version: '1.0.0',
        auto_populated: true
      };
      
      await fs.writeFile(configPath, JSON.stringify(config, null, 2));
      console.log(`[AutoPopulate] Created new config for ${castId}`);
      return config;
    }
  }

  /**
   * Generate profile.md content
   */
  async generateProfile(castId, castPath, config) {
    const profilePath = path.join(castPath, 'profile.md');
    
    try {
      await fs.access(profilePath);
      const content = await fs.readFile(profilePath, 'utf8');
      // Check if it's just the default "No profile yet" template
      if (content.includes('No profile yet') || content.length < 500) {
        console.log(`[AutoPopulate] Profile exists but is empty, generating...`);
        // Continue to generate
      } else {
        console.log(`[AutoPopulate] Profile already populated for ${castId}`);
        return;
      }
    } catch {
      // File doesn't exist, continue to generate
    }
    
    const profile = this.buildProfileContent(castId, config);
    await fs.writeFile(profilePath, profile);
    console.log(`[AutoPopulate] Generated profile for ${castId}`);
  }

  /**
   * Build comprehensive profile content
   */
  buildProfileContent(castId, config) {
    return `---
id: ${castId}
name: ${config.name}
emoji: ${config.emoji}
color: "${config.color}"
created: "${config.created}"
version: "${config.version}"
---

# ${config.name}

## Core Identity

${config.description}

## Philosophy

${this.generatePhilosophy(castId)}

## Capabilities

${this.generateCapabilitiesList(config.capabilities)}

## Activation Patterns

This cast activates when you:
${config.activation_patterns.map(p => `- ${p}`).join('\n')}

## Output Format

When responding, I provide:
- Clear reasoning for decisions
- Structured output (markdown/JSON/code as appropriate)
- Actionable next steps
- References to relevant patterns or examples

## Related Casts

${config.related_casts.length > 0 
  ? config.related_casts.map(r => `- ${r}`).join('\n')
  : '- Can work with any cast'}

## Communication Style

- Concise but thorough
- Explicit about assumptions
- Practical and actionable
- Asks clarifying questions when needed

---

*Auto-populated on ${new Date().toISOString().split('T')[0]}*
`;
  }

  /**
   * Generate system files (prompts, quick-ref)
   */
  async generateSystemFiles(castId, castPath, config) {
    const systemDir = path.join(castPath, 'system');
    
    // Quick reference
    const quickRefPath = path.join(systemDir, 'quick-reference.md');
    try {
      await fs.access(quickRefPath);
    } catch {
      const quickRef = this.buildQuickReference(castId, config);
      await fs.writeFile(quickRefPath, quickRef);
      console.log(`[AutoPopulate] Generated quick-reference for ${castId}`);
    }
    
    // System prompts
    const promptsPath = path.join(systemDir, 'prompts.md');
    try {
      await fs.access(promptsPath);
    } catch {
      const prompts = this.buildSystemPrompts(castId, config);
      await fs.writeFile(promptsPath, prompts);
      console.log(`[AutoPopulate] Generated system prompts for ${castId}`);
    }
  }

  /**
   * Generate context examples
   */
  async generateContextExamples(castId, castPath, config) {
    const contextDir = path.join(castPath, 'context');
    
    // README for context
    const readmePath = path.join(contextDir, 'README.md');
    try {
      await fs.access(readmePath);
    } catch {
      const readme = `# Context Documents

Upload reference materials here to give ${config.name} context.

## Supported Formats
- Markdown (.md)
- PDF (.pdf)
- Text (.txt)
- JSON (.json)

## How to Use
1. Upload relevant documents
2. The cast can search and reference them
3. Update as needed

*Auto-generated*
`;
      await fs.writeFile(readmePath, readme);
    }
  }

  /**
   * Generate memory templates
   */
  async generateMemoryTemplates(castId, castPath, config) {
    const memoryDir = path.join(castPath, 'memory');
    
    // README for memory
    const readmePath = path.join(memoryDir, 'README.md');
    try {
      await fs.access(readmePath);
    } catch {
      const readme = `# Cast Memory

Important memories, decisions, and learnings for ${config.name}.

## Format
Create markdown files with frontmatter:

\`\`\`yaml
---
date: "2026-02-19"
importance: high|medium|low
category: decision|learning|context
---

# Title

Content...
\`\`\`

*Auto-generated*
`;
      await fs.writeFile(readmePath, readme);
    }
  }

  /**
   * Initialize index for context search
   */
  async initializeIndex(castPath) {
    const indexDir = path.join(castPath, 'index');
    const indexPath = path.join(indexDir, 'inverted.json');
    
    try {
      await fs.access(indexPath);
    } catch {
      const initialIndex = {
        documents: [],
        index: {},
        stats: {
          totalDocuments: 0,
          totalTerms: 0,
          indexSize: 0
        },
        created: new Date().toISOString()
      };
      await fs.writeFile(indexPath, JSON.stringify(initialIndex, null, 2));
      console.log(`[AutoPopulate] Initialized index`);
    }
  }

  /**
   * Update the main cast index file
   */
  async updateCastIndex(castId, config) {
    const indexPath = path.join(this.castsDir, '.index.json');
    
    let index = { casts: [], activeCast: castId, lastUpdated: new Date().toISOString() };
    
    try {
      const existing = await fs.readFile(indexPath, 'utf8');
      index = JSON.parse(existing);
    } catch {
      // Create new index
    }
    
    // Update or add cast
    const existingIdx = index.casts.findIndex(c => c.id === castId);
    const castEntry = {
      id: castId,
      name: config.name,
      emoji: config.emoji,
      color: config.color,
      active: index.activeCast === castId,
      metadata: {
        description: config.description,
        capabilities: config.capabilities,
        created: config.created,
        version: config.version
      }
    };
    
    if (existingIdx >= 0) {
      index.casts[existingIdx] = castEntry;
    } else {
      index.casts.push(castEntry);
    }
    
    index.lastUpdated = new Date().toISOString();
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
    console.log(`[AutoPopulate] Updated cast index`);
  }

  // Helper methods

  generateName(castId) {
    return castId
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  generateColor(castId) {
    // Generate consistent color from castId
    const colors = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444'];
    let hash = 0;
    for (let i = 0; i < castId.length; i++) {
      hash = castId.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  }

  generateDescription(castId) {
    return `An expert ${castId.replace(/-/g, ' ')} assistant ready to help with specialized tasks.`;
  }

  generatePatterns(castId) {
    const baseName = castId.replace(/-/g, ' ');
    return [
      `.*${baseName}.*`,
      `help.*${baseName}`,
      `${baseName}.*assist`,
      `need.*${baseName}`
    ];
  }

  generateCapabilities(castId) {
    return [
      'specialized_reasoning',
      'context_awareness',
      'memory_management'
    ];
  }

  generatePhilosophy(castId) {
    return `I approach every task with expertise in ${castId.replace(/-/g, ' ')}. 

Key principles:
- **Evidence-based**: Ground decisions in facts and best practices
- **Context-aware**: Adapt to your specific situation
- **Collaborative**: Work with you, not just for you
- **Continuous learning**: Improve from each interaction`;
  }

  generateCapabilitiesList(capabilities) {
    if (!capabilities || capabilities.length === 0) {
      return '- General assistance\n- Problem solving\n- Context awareness';
    }
    return capabilities.map(c => `- ${c.replace(/_/g, ' ')}`).join('\n');
  }

  buildQuickReference(castId, config) {
    const capabilities = config.capabilities || ['specialized assistance', 'context awareness'];
    return `# ${config.name} - Quick Reference

## Activation
- "${castId.replace(/-/g, ' ')} help"
- "Need ${castId.replace(/-/g, ' ')} assistance"

## Capabilities
${capabilities.map(c => `- ${c.replace(/_/g, ' ')}`).join('\n')}

## Communication Style
- Concise and practical
- Asks clarifying questions
- Provides actionable output

---

*Auto-generated*
`;
  }

  buildSystemPrompts(castId, config) {
    return `# ${config.name} System Prompts

## Base System Prompt

You are the **${config.name}** cast - ${config.description}

Your core principles:
${this.generatePhilosophy(castId).split('\n').slice(1).join('\n')}

## Task Prompts

### General Assistance
When asked for help:
1. Understand the context and constraints
2. Provide expert guidance
3. Ask clarifying questions if needed
4. Deliver actionable output

### Analysis Task
When analyzing:
1. Break down the problem
2. Consider multiple angles
3. Provide structured output
4. Include recommendations

---

*Auto-generated*
`;
  }
}

// CLI interface
if (require.main === module) {
  const castId = process.argv[2];
  if (!castId) {
    console.error('Usage: node populate-cast.js <cast-id>');
    console.error('Example: node populate-cast.js ui-engineer');
    process.exit(1);
  }
  
  const populator = new CastAutoPopulator();
  populator.populate(castId).catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}

module.exports = CastAutoPopulator;
