// ============================================================
// Minecraft AFK Bot — powered by Mineflayer
// ============================================================
// Loads configuration from a .env file, connects to a server,
// holds position, auto-reconnects, and responds to chat commands.
// ============================================================

import mineflayer from 'mineflayer';
import { config } from 'dotenv';

// Load environment variables from .env file
config();

// ─── Configuration ───────────────────────────────────────────
// All sensitive/configurable values come from .env (with sane defaults)
const BOT_CONFIG = {
  host:     process.env.MC_HOST     || 'localhost',
  port:     parseInt(process.env.MC_PORT || '25565', 10),
  username: process.env.MC_USERNAME || 'AFKBot',
  version:  process.env.MC_VERSION  || false, // false = auto-detect
  auth:     process.env.MC_AUTH     || 'offline', // 'offline' | 'microsoft'
};

// How long to wait before reconnecting after a disconnect (ms)
const RECONNECT_DELAY_MS = parseInt(process.env.RECONNECT_DELAY || '5000', 10);

// Whether the bot should attempt to reconnect automatically
const AUTO_RECONNECT = process.env.AUTO_RECONNECT !== 'false';

// ─── State ───────────────────────────────────────────────────
let bot = null;
let followTarget = null;   // player name the bot is currently following
let followInterval = null; // interval handle for the follow loop

// ─── Helpers ─────────────────────────────────────────────────

/** Formatted timestamp for log lines */
function timestamp() {
  return new Date().toLocaleTimeString();
}

/** Consistent console logger with timestamp prefix */
function log(msg) {
  console.log(`[${timestamp()}] ${msg}`);
}

/** Stop the follow loop if one is running */
function stopFollowing() {
  if (followInterval) {
    clearInterval(followInterval);
    followInterval = null;
  }
  followTarget = null;
}

// ─── Bot factory ─────────────────────────────────────────────

/**
 * Creates and wires up the Mineflayer bot.
 * Called on first launch and on every reconnect.
 */
function createBot() {
  log(`Connecting to ${BOT_CONFIG.host}:${BOT_CONFIG.port} as "${BOT_CONFIG.username}"...`);

  bot = mineflayer.createBot({
    host:     BOT_CONFIG.host,
    port:     BOT_CONFIG.port,
    username: BOT_CONFIG.username,
    version:  BOT_CONFIG.version || undefined,
    auth:     BOT_CONFIG.auth,
  });

  // ── Event: spawned ────────────────────────────────────────
  bot.once('spawn', () => {
    log(`✓ Spawned in the world at ${fmtPos(bot.entity.position)}`);
    log('Bot is now AFK. Listening for chat commands (!pos, !say, !follow, !stop).');

    // Immediately stop any movement to hold position
    bot.setControlState('forward',  false);
    bot.setControlState('back',     false);
    bot.setControlState('left',     false);
    bot.setControlState('right',    false);
    bot.setControlState('jump',     false);
    bot.setControlState('sneak',    false);
    bot.setControlState('sprint',   false);
  });

  // ── Event: chat ───────────────────────────────────────────
  bot.on('chat', (username, message) => {
    // Ignore messages from the bot itself
    if (username === bot.username) return;

    log(`[Chat] <${username}> ${message}`);

    const parts = message.trim().split(/\s+/);
    const cmd   = parts[0].toLowerCase();

    // ── !pos ─────────────────────────────────────────────────
    if (cmd === '!pos') {
      const pos = bot.entity.position;
      bot.chat(`My position: ${fmtPos(pos)}`);
    }

    // ── !say <message> ────────────────────────────────────────
    else if (cmd === '!say') {
      const text = parts.slice(1).join(' ');
      if (!text) {
        bot.chat('Usage: !say <message>');
        return;
      }
      bot.chat(text);
      log(`[Say] Sent: "${text}"`);
    }

    // ── !follow <player> ─────────────────────────────────────
    else if (cmd === '!follow') {
      const playerName = parts[1];
      if (!playerName) {
        bot.chat('Usage: !follow <player>');
        return;
      }

      const target = bot.players[playerName];
      if (!target || !target.entity) {
        bot.chat(`Cannot see player "${playerName}".`);
        return;
      }

      stopFollowing(); // cancel any previous follow
      followTarget = playerName;
      log(`[Follow] Now following ${playerName}`);
      bot.chat(`Following ${playerName}!`);

      // Poll every 500 ms and walk toward the target
      followInterval = setInterval(() => {
        const player = bot.players[followTarget];
        if (!player || !player.entity) {
          bot.chat(`Lost sight of ${followTarget}.`);
          stopFollowing();
          return;
        }
        // Look at and move toward the player
        bot.lookAt(player.entity.position.offset(0, player.entity.height, 0));
        const dist = bot.entity.position.distanceTo(player.entity.position);
        if (dist > 3) {
          bot.setControlState('forward', true);
        } else {
          bot.setControlState('forward', false);
        }
      }, 500);
    }

    // ── !stop ─────────────────────────────────────────────────
    else if (cmd === '!stop') {
      log('[Stop] Disconnect requested via chat.');
      bot.chat('Disconnecting. Goodbye!');
      stopFollowing();
      // Give chat a moment to send before quitting
      setTimeout(() => {
        bot.quit('stop command');
        process.exit(0);
      }, 500);
    }
  });

  // ── Event: kicked ─────────────────────────────────────────
  bot.on('kicked', (reason) => {
    log(`✗ Kicked from server: ${reason}`);
    stopFollowing();
  });

  // ── Event: error ──────────────────────────────────────────
  bot.on('error', (err) => {
    log(`✗ Error: ${err.message}`);
  });

  // ── Event: end ────────────────────────────────────────────
  bot.on('end', (reason) => {
    log(`✗ Disconnected (${reason || 'unknown reason'}).`);
    stopFollowing();

    if (AUTO_RECONNECT) {
      log(`↻  Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
      setTimeout(createBot, RECONNECT_DELAY_MS);
    } else {
      log('Auto-reconnect disabled. Exiting.');
      process.exit(0);
    }
  });

  // ── Prevent unwanted physics drift ────────────────────────
  // Mineflayer's physics can cause micro-movements; reset controls periodically.
  setInterval(() => {
    if (!bot || !bot.entity) return;
    if (!followTarget) {
      // Only reset movement when NOT following someone
      bot.setControlState('forward',  false);
      bot.setControlState('back',     false);
      bot.setControlState('left',     false);
      bot.setControlState('right',    false);
      bot.setControlState('jump',     false);
      bot.setControlState('sprint',   false);
    }
  }, 1000);
}

// ─── Utility ─────────────────────────────────────────────────

/** Format a Vec3 position to a readable string */
function fmtPos(pos) {
  if (!pos) return '(unknown)';
  return `X:${pos.x.toFixed(1)}  Y:${pos.y.toFixed(1)}  Z:${pos.z.toFixed(1)}`;
}

// ─── Process signals ─────────────────────────────────────────
// Graceful shutdown on Ctrl+C / SIGTERM
function shutdown(signal) {
  log(`Received ${signal}. Disconnecting…`);
  stopFollowing();
  if (bot) {
    try { bot.quit('shutdown'); } catch (_) { /* already gone */ }
  }
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Start ───────────────────────────────────────────────────
log('=== Minecraft AFK Bot starting ===');
log(`Config: host=${BOT_CONFIG.host}  port=${BOT_CONFIG.port}  user=${BOT_CONFIG.username}  version=${BOT_CONFIG.version || 'auto'}`);
createBot();
