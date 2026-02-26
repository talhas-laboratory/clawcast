#!/usr/bin/env node

/**
 * OpenClaw Agent Cast Integration
 * 
 * This script integrates the Cast System with OpenClaw agent.
 * When user types /cast, it shows clickable buttons.
 * When a button is clicked, the agent switches to that cast's persona.
 */

const fs = require('fs').promises;
const path = require('path');

class AgentCastIntegration {
  constructor(options = {}) {
    this.workspaceRoot = typeof options.workspaceRoot === 'string' && options.workspaceRoot.trim()
      ? options.workspaceRoot.trim()
      : process.cwd();
    this.castsDir = path.join(this.workspaceRoot, 'casts');
    this.stateFile = path.join(this.castsDir, '.agent-state.json');
  }

  /**
   * Get list of all casts with their info
   */
  async getCastsList() {
    try {
      const indexPath = path.join(this.castsDir, '.index.json');
      const data = await fs.readFile(indexPath, 'utf8');
      const index = JSON.parse(data);
      return index.casts || [];
    } catch (error) {
      console.error('Failed to load casts:', error);
      return [];
    }
  }

  /**
   * Load a cast's profile
   */
  async loadCastProfile(castId) {
    try {
      const profilePath = path.join(this.castsDir, castId, 'profile.md');
      const content = await fs.readFile(profilePath, 'utf8');
      
      // Parse YAML frontmatter
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (frontmatterMatch) {
        const frontmatter = frontmatterMatch[1];
        const body = frontmatterMatch[2].trim();
        
        // Parse simple YAML
        const config = {};
        frontmatter.split('\n').forEach(line => {
          const match = line.match(/^(\w+):\s*(.+)$/);
          if (match) {
            config[match[1]] = match[2].replace(/^"|"$/g, '');
          }
        });
        
        return { config, body };
      }
      
      return { config: { name: castId }, body: content };
    } catch (error) {
      console.error(`Failed to load cast ${castId}:`, error);
      return null;
    }
  }

  /**
   * Get current active cast
   */
  async getActiveCast() {
    try {
      const data = await fs.readFile(this.stateFile, 'utf8');
      const state = JSON.parse(data);
      return state.activeCast || null;
    } catch {
      return null;
    }
  }

  /**
   * Set active cast
   */
  async setActiveCast(castId) {
    try {
      let state = {};
      try {
        const data = await fs.readFile(this.stateFile, 'utf8');
        state = JSON.parse(data);
      } catch {}
      
      state.activeCast = castId;
      state.switchedAt = new Date().toISOString();
      
      await fs.writeFile(this.stateFile, JSON.stringify(state, null, 2));
      return true;
    } catch (error) {
      console.error('Failed to set active cast:', error);
      return false;
    }
  }

  /**
   * Leave current cast and save conversation to memory
   */
  async leaveCast(conversationData = {}) {
    try {
      const activeCast = await this.getActiveCast();
      
      if (!activeCast) {
        return {
          success: false,
          message: 'No active cast to leave'
        };
      }

      // Load cast info
      const profile = await this.loadCastProfile(activeCast);
      const cast = { 
        id: activeCast, 
        config: profile?.config || { name: activeCast },
        path: path.join(this.castsDir, activeCast)
      };

      // Save conversation to memory
      const CastMemoryManager = require('./CastMemoryManager');
      const memoryManager = new CastMemoryManager(cast);
      
      const memoryResult = await memoryManager.saveConversation({
        startTime: conversationData.startTime || new Date(Date.now() - 15 * 60000).toISOString(),
        endTime: new Date().toISOString(),
        summary: conversationData.summary || `Conversation with ${cast.config.name}`,
        topics: conversationData.topics || [],
        decisions: conversationData.decisions || [],
        actionItems: conversationData.actionItems || [],
        keyPoints: conversationData.keyPoints || [],
        conversation: conversationData.messages || []
      });
      
      // Also update user memory if userId provided
      if (conversationData.userId) {
        try {
          const WorkingMemoryManager = require('./WorkingMemoryManager');
          const workingMemory = new WorkingMemoryManager(cast.path);
          await workingMemory.initialize();
          
          // Update conversation count and last interaction
          await workingMemory.updateUserMemory(
            conversationData.userId,
            'Conversation History Summary',
            `- **${new Date().toISOString().split('T')[0]}**: ${conversationData.summary || 'Conversation'}`,
            true
          );
        } catch (error) {
          console.error('[AgentCastIntegration] Failed to update user memory:', error);
        }
      }

      // Clear active cast
      let state = {};
      try {
        const data = await fs.readFile(this.stateFile, 'utf8');
        state = JSON.parse(data);
      } catch {}
      
      state.previousCast = activeCast;
      state.activeCast = null;
      state.leftAt = new Date().toISOString();
      
      await fs.writeFile(this.stateFile, JSON.stringify(state, null, 2));

      return {
        success: true,
        cast: activeCast,
        memorySaved: memoryResult.success,
        memoryFile: memoryResult.file,
        message: `✅ Left ${cast.config.name}. Conversation saved to memory.`
      };
    } catch (error) {
      console.error('Failed to leave cast:', error);
      return {
        success: false,
        message: 'Error leaving cast: ' + error.message
      };
    }
  }

  /**
   * Generate the /cast command response with buttons
   */
  async generateCastCommandResponse() {
    const casts = await this.getCastsList();
    const activeCast = await this.getActiveCast();
    
    if (casts.length === 0) {
      return {
        text: '❌ No casts found. Create a cast first.',
        buttons: null
      };
    }

    // Format cast list with emojis
    const activeText = activeCast 
      ? `\n✅ Currently acting as: ${activeCast}` 
      : '';

    // Create buttons (2 per row)
    const buttons = [];
    const row = [];
    
    for (const cast of casts) {
      const emoji = cast.emoji || '🔹';
      const isActive = cast.id === activeCast;
      
      row.push({
        text: `${isActive ? '✅ ' : ''}${emoji} ${cast.name}`,
        callback_data: `switch_cast:${cast.id}`
      });
      
      if (row.length === 2) {
        buttons.push([...row]);
        row.length = 0;
      }
    }
    
    if (row.length > 0) {
      buttons.push([...row]);
    }

    return {
      text: `🎭 **Available Casts**${activeText}\n\nClick to switch persona:`,
      buttons
    };
  }

  /**
   * Switch to a cast and return the persona instructions
   */
  async switchToCast(castId, userId = null) {
    const profile = await this.loadCastProfile(castId);
    
    if (!profile) {
      return {
        success: false,
        message: `❌ Failed to load cast: ${castId}`
      };
    }

    // Save active cast
    await this.setActiveCast(castId);

    // Load working memory and user context
    let workingMemory = '';
    let userContext = '';
    
    if (userId) {
      try {
        const WorkingMemoryManager = require('./WorkingMemoryManager');
        const memoryManager = new WorkingMemoryManager(path.join(this.castsDir, castId));
        await memoryManager.initialize();
        
        // Auto-cleanup old scratchpad
        await memoryManager.autoCleanup();
        
        const context = await memoryManager.getContextForPrompt(userId);
        workingMemory = context.workingMemory;
        userContext = context.userContext;
      } catch (error) {
        console.error('[AgentCastIntegration] Failed to load memory:', error);
      }
    }

    // Build enhanced persona with memory context
    let enhancedPersona = profile.body;
    
    if (workingMemory || userContext) {
      enhancedPersona += `\n\n---\n\n## Your Memory Context\n\n`;
      
      if (workingMemory && workingMemory !== 'No active working memory.') {
        enhancedPersona += `### Working Memory (Your Desk)\n${workingMemory}\n\n`;
      }
      
      if (userContext && userContext !== 'New user - no memory yet.') {
        enhancedPersona += `### User Context\n${userContext}\n\n`;
      }
      
      enhancedPersona += `*Use this context naturally - reference it when relevant, ignore if not needed.*`;
    }

    // Return persona switch info
    return {
      success: true,
      castId,
      name: profile.config.name || castId,
      emoji: profile.config.emoji || '🔹',
      color: profile.config.color,
      persona: enhancedPersona,
      message: `✅ **Switched to ${profile.config.name || castId}** ${profile.config.emoji || '🔹'}\n\n_You are now speaking as ${profile.config.name || castId}_`
    };
  }

  /**
   * Check if a message is a cast switch callback
   */
  isCastSwitchCallback(text) {
    return text && text.startsWith('switch_cast:');
  }

  /**
   * Extract cast ID from callback
   */
  extractCastIdFromCallback(text) {
    if (this.isCastSwitchCallback(text)) {
      return text.replace('switch_cast:', '');
    }
    return null;
  }
}

// Export for use
module.exports = AgentCastIntegration;

// If run directly, test
if (require.main === module) {
  const integration = new AgentCastIntegration();
  
  integration.generateCastCommandResponse().then(result => {
    console.log('Test /cast command:');
    console.log('Text:', result.text);
    console.log('Buttons:', JSON.stringify(result.buttons, null, 2));
  });
}
