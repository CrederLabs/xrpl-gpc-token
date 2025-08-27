// Discord webhook alarm utility
import fetch from 'node-fetch';

const DISCORD_WEBHOOKS = {
  INFO: process.env.DISCORD_WEBHOOKS_INFO,
  WARN: process.env.DISCORD_WEBHOOKS_WARN,
  ERROR: process.env.DISCORD_WEBHOOKS_ERROR
};

/**
 * Send a Discord alarm message
 * @param {'INFO'|'WARN'|'ERROR'} level - Alarm level
 * @param {string} message - Message to send
 * @param {object} [options] - Optional embed or extra fields
 */
export const sendDiscordAlarm = async (level, message, options = {}) => {
    if (process.env.DEV_MODE) return;

    const webhook = DISCORD_WEBHOOKS[level];
    if (!webhook) return;
    const body = {
        content: message,
        ...options
    };
    try {
        await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
        });
    } catch (err) {
        console.error(`[DiscordAlarm] Failed to send ${level} alarm:`, err);
    }
};