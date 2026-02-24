#!/usr/bin/env node

/**
 * Telegram Bot Command Handler for Cast System
 * 
 * Handles /cast command with inline buttons
 * and manages cast switching for OpenClaw agent
 */

const fs = require('fs').promises;
const path = require('path');

class CastCommandHandler {
  constructor() {
    // API base can be overridden for deployments
    this.apiBase = process.env.CAST_SYSTEM_API_BASE || 'http://127.0.0.1:18789';
    this.workspaceRoot = process.env.OPENCLAW_WORKSPACE_DIR || process.cwd();
  }

  /**
   * Handle /cast command - show available casts with buttons
   */
  async handleCastCommand(chatId, userId) {
    try {
      // Fetch casts from API
      const response = await fetch(`${this.apiBase}/api/cast-manager`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'listCasts' })
      });
      
      const data = await response.json();
      
      if (!data.success) {
        return {
          text: '❌ Failed to fetch casts. Is the server running?',
          buttons: null
        };
      }

      // Build buttons array
      const buttons = data.casts.map(cast => ({
        text: `${cast.emoji || '🔹'} ${cast.name}`,
        callback_data: `cast:${cast.id}`
      }));

      // Format message
      const activeCast = data.activeCast;
      const activeText = activeCast ? `
✅ Currently active: ${activeCast.name}` : '';

      return {
        text: `🎭 **Available Casts**${activeText}

Click a cast to switch:`,
        buttons: this.chunkButtons(buttons, 2) // 2 buttons per row
      };
    } catch (error) {
      console.error('Cast command error:', error);
      return {
        text: '❌ Error connecting to Cast Manager',
        buttons: null
      };
    }
  }

  /**
   * Handle cast switch callback
   */
  async handleCastSwitch(castId, chatId, userId) {
    try {
      // Call API to switch cast
      const response = await fetch(`${this.apiBase}/api/cast-manager`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'switchCast', castId })
      });

      const data = await response.json();

      if (!data.success) {
        return {
          text: `❌ Failed to switch to cast: ${castId}`,
          success: false
        };
      }

      // Load cast profile for agent context
      const profileResponse = await fetch(`${this.apiBase}/api/cast-manager`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'getProfile', castId })
      });

      const profileData = await profileResponse.json();
      
      // Save active cast info for this chat
      await this.saveChatCast(chatId, castId, data.cast, profileData.profile);

      return {
        text: `✅ **Switched to ${data.cast.name}** ${data.cast.emoji || '🔹'}

${profileData.profile?.content?.substring(0, 200) || ''}...

_I will now respond as ${data.cast.name}_`,
        success: true,
        cast: data.cast
      };
    } catch (error) {
      console.error('Cast switch error:', error);
      return {
        text: '❌ Error switching cast',
        success: false
      };
    }
  }

  /**
   * Get active cast for a chat
   */
  async getActiveCast(chatId) {
    try {
      const statePath = path.join(this.workspaceRoot, 'casts', '.chat-state.json');
      const data = await fs.readFile(statePath, 'utf8');
      const state = JSON.parse(data);
      return state[chatId]?.cast || null;
    } catch {
      return null;
    }
  }

  /**
   * Save active cast for a chat
   */
  async saveChatCast(chatId, castId, castInfo, profile) {
    try {
      const statePath = path.join(this.workspaceRoot, 'casts', '.chat-state.json');
      let state = {};
      
      try {
        const data = await fs.readFile(statePath, 'utf8');
        state = JSON.parse(data);
      } catch {
        // File doesn't exist yet
      }

      state[chatId] = {
        castId,
        cast: castInfo,
        profile: profile?.content,
        switchedAt: new Date().toISOString()
      };

      await fs.writeFile(statePath, JSON.stringify(state, null, 2));
    } catch (error) {
      console.error('Failed to save chat cast:', error);
    }
  }

  /**
   * Chunk buttons into rows
   */
  chunkButtons(buttons, perRow) {
    const rows = [];
    for (let i = 0; i < buttons.length; i += perRow) {
      rows.push(buttons.slice(i, i + perRow));
    }
    return rows;
  }
}

// Export for use
module.exports = CastCommandHandler;

// CLI test
if (require.main === module) {
  const handler = new CastCommandHandler();
  
  // Test command
  handler.handleCastCommand('test-chat', 'user-123').then(result => {
    console.log('Cast command result:');
    console.log('Text:', result.text);
    console.log('Buttons:', JSON.stringify(result.buttons, null, 2));
  });
}
