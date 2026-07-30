// ============================================================
// Minecraft Pure AFK Keep-Alive Bot — Mineflayer + ViaProxy Fallback
// ============================================================
import mineflayer from 'mineflayer';
import { config } from 'dotenv';
import { spawn } from 'child_process';
import { createServer } from 'net';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import http from 'http';

config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIAPROXY_JAR = join(__dirname, '..', 'viaproxy', 'ViaProxy.jar');

const SERVER_HOST = process.env.MC_HOST || 'CLgamingTV.aternos.me';
const SERVER_PORT = parseInt(process.env.MC_PORT || '36025', 10);
const BOT_USERNAME = process.env.MC_USERNAME || 'CombatBot';
const SERVER_VERSION = process.env.MC_VERSION || '26.2';
const BOT_VERSION = process.env.BOT_VERSION || '1.21.5';
const MC_AUTH = process.env.MC_AUTH || 'offline';
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '25568', 10);
const RECONNECT_DELAY_MS = parseInt(process.env.RECONNECT_DELAY || '5000', 10);

let bot = null;
let viaProxyProcess = null;
let viaProxyReady = false;
let isEating = false;
let antiAfkInterval = null;
let autoEatInterval = null;
let keepAlivePulseInterval = null;
let isProxyMode = false;

const ts = () => new Date().toLocaleTimeString();
const log = (msg) => console.log(`[${ts()}] ${msg}`);
const fmtPos = (pos) => pos ? `X:${pos.x.toFixed(1)} Y:${pos.y.toFixed(1)} Z:${pos.z.toFixed(1)}` : '(unknown)';

function isPortFree(port) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port);
  });
}

// ─── KHỞI ĐỘNG VIAPROXY (KHI CẦN) ───────────────────────────
async function startViaProxy() {
  if (viaProxyProcess && !viaProxyProcess.killed) return;
  const free = await isPortFree(PROXY_PORT);
  if (!free) {
    viaProxyReady = true;
    return;
  }

  log(`🔄 Khởi động ViaProxy nhẹ trên port ${PROXY_PORT}...`);
  viaProxyProcess = spawn('java', [
    '-Xms128m',
    '-Xmx320m',
    '-jar', VIAPROXY_JAR,
    'cli',
    '--target-address', `${SERVER_HOST}:${SERVER_PORT}`,
    '--target-version', SERVER_VERSION,
    '--bind-address', `0.0.0.0:${PROXY_PORT}`,
    '--auth-method', 'NONE',
    '--proxy-online-mode', 'false',
    '--ignore-protocol-translation-errors', 'true',
    '--suppress-client-protocol-errors', 'true',
    '--connect-timeout', '60000',
    '--log-ips', 'false',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const isQuietLog = (l) => l.includes('less than 512MB') || l.includes('newer plugin version available');

  viaProxyProcess.stdout.on('data', (d) => {
    const line = d.toString().trim();
    if (line && !isQuietLog(line)) console.log(`[ViaProxy] ${line}`);
    if (!viaProxyReady && (line.includes('Listening on') || line.includes('started') || line.includes('Binding proxy server'))) {
      viaProxyReady = true;
    }
  });
  viaProxyProcess.stderr.on('data', (d) => {
    const line = d.toString().trim();
    if (line && !isQuietLog(line)) console.log(`[ViaProxy] ${line}`);
    if (!viaProxyReady && (line.includes('Listening on') || line.includes('started') || line.includes('Binding proxy server'))) {
      viaProxyReady = true;
    }
  });
  viaProxyProcess.on('exit', (code) => {
    log(`⚠ ViaProxy thoát với code ${code}`);
    viaProxyReady = false;
    viaProxyProcess = null;
  });

  await new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (viaProxyReady) { clearInterval(interval); resolve(); return; }
      isPortFree(PROXY_PORT).then((free) => {
        if (!free) { viaProxyReady = true; clearInterval(interval); resolve(); }
      });
      if (Date.now() - start > 90000) {
        clearInterval(interval);
        reject(new Error('ViaProxy khởi động quá 90 giây.'));
      }
    }, 500);
  });
}

// ─── TỰ ĐỘNG ĂN (AUTO-EAT) ────────────────────────────────────
const EDIBLE_FOODS = new Set([
  'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken',
  'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'baked_potato',
  'bread', 'golden_apple', 'golden_carrot', 'apple', 'carrot',
  'melon_slice', 'sweet_berries', 'glow_berries', 'steak'
]);

async function checkAndAutoEat() {
  if (!bot || !bot.entity || isEating) return;
  const hunger = bot.food ?? 20;
  if (hunger >= 16) return;

  const foodItem = bot.inventory?.items()?.find(item => EDIBLE_FOODS.has(item.name));
  if (!foodItem) return;

  try {
    isEating = true;
    log(`🍖 Tự động ăn ${foodItem.name} (Hunger: ${hunger}/20)...`);
    await bot.equip(foodItem, 'hand');
    await bot.consume();
  } catch (_) { } finally {
    isEating = false;
  }
}

function setupAutoEat() {
  if (autoEatInterval) clearInterval(autoEatInterval);
  autoEatInterval = setInterval(() => checkAndAutoEat(), 5_000);
}

// ─── CHỐNG AFK THÔNG MINH (SMART ANTI-AFK) ───────────────────
function setupAntiAFK() {
  if (antiAfkInterval) clearInterval(antiAfkInterval);
  if (keepAlivePulseInterval) clearInterval(keepAlivePulseInterval);

  keepAlivePulseInterval = setInterval(() => {
    if (!bot || !bot.entity || isEating) return;
    try {
      bot.look(bot.entity.yaw + 0.0001, bot.entity.pitch, true);
    } catch (_) {}
  }, 3_000);

  antiAfkInterval = setInterval(async () => {
    if (!bot || !bot.entity || isEating) return;
    try {
      const act = Math.floor(Math.random() * 3);
      if (act === 0) {
        const yawShift = (Math.random() - 0.5) * 0.8;
        const pitchShift = (Math.random() - 0.5) * 0.4;
        await bot.look(bot.entity.yaw + yawShift, bot.entity.pitch + pitchShift, true);
      } else if (act === 1) {
        bot.swingArm('hand');
      } else {
        if (Math.random() > 0.5) {
          bot.setControlState('jump', true);
          setTimeout(() => { try { bot.setControlState('jump', false); } catch (_) { } }, 150);
        } else {
          bot.setControlState('sneak', true);
          setTimeout(() => { try { bot.setControlState('sneak', false); } catch (_) { } }, 500);
        }
      }
    } catch (_) { }
  }, 12_000 + Math.floor(Math.random() * 6_000));
}

// ─── KHỞI TẠO BOT DUAL-ENGINE ───────────────────────────────
function createBot(useProxy = false) {
  isProxyMode = useProxy;
  cleanupState();

  const botOptions = useProxy ? {
    host: '127.0.0.1',
    port: PROXY_PORT,
    username: BOT_USERNAME,
    version: BOT_VERSION,
    auth: MC_AUTH,
  } : {
    host: SERVER_HOST,
    port: SERVER_PORT,
    username: BOT_USERNAME,
    version: false,
    auth: MC_AUTH,
  };

  log(`🤖 Kết nối ${useProxy ? 'qua ViaProxy' : 'trực tiếp (Siêu nhẹ 40MB)'}: bot → ${botOptions.host}:${botOptions.port}`);

  let hasLoggedIn = false;

  try {
    bot = mineflayer.createBot(botOptions);
  } catch (e) {
    if (!useProxy) {
      log(`⚠️ Kết nối trực tiếp thất bại (${e.message}). Chuyển sang ViaProxy...`);
      connectWithViaProxy();
      return;
    }
  }

  bot.once('login', () => { hasLoggedIn = true; });

  bot.once('spawn', () => {
    log(`✓ Đã vào thế giới Aternos (${useProxy ? 'ViaProxy' : 'Direct'}) tại ${fmtPos(bot.entity.position)} — Treo AFK 24/7`);
    setupAutoEat();
    setupAntiAFK();
  });

  bot.on('death', () => {
    log('💀 Bot bị chết — tự động hồi sinh sau 1 giây...');
    setTimeout(() => { try { bot?.respawn(); } catch (_) { } }, 1000);
  });

  bot.on('chat', (username, message) => {
    if (username === bot?.username) return;
    const parts = message.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === '!pos') {
      bot?.chat(`📍 ${fmtPos(bot?.entity?.position)}`);
    } else if (cmd === '!status') {
      bot?.chat(`HP:${(bot?.health ?? 0).toFixed(1)}❤ Food:${bot?.food ?? 0}🍗 [AFK Active 24/7]`);
    } else if (cmd === '!say') {
      const text = parts.slice(1).join(' ');
      if (text) bot?.chat(text);
    } else if (cmd === '!help') {
      bot?.chat('Lệnh: !pos !status !say <msg>');
    }
  });

  bot.on('kicked', (r) => { log(`✗ Bị kick: ${r}`); cleanupState(); });

  bot.on('error', (e) => {
    if (e?.code === 'ECONNRESET' || e?.message?.includes('ECONNRESET')) {
      log('⚠️ Mạng Aternos ngắt kết nối tạm thời (ECONNRESET)');
    } else {
      log(`✗ Lỗi: ${e.message}`);
    }

    if (!hasLoggedIn && !useProxy) {
      log('⚠️ Kết nối trực tiếp chưa tương thích. Chuyển sang ViaProxy...');
      cleanupState();
      connectWithViaProxy();
    }
  });

  bot.on('end', (reason) => {
    log(`✗ Mất kết nối (${reason || 'socketClosed'}). Tự kết nối lại sau ${RECONNECT_DELAY_MS / 1000}s...`);
    cleanupState();
    setTimeout(async () => {
      if (isProxyMode) {
        try { await startViaProxy(); } catch (_) { }
        createBot(true);
      } else {
        createBot(false);
      }
    }, RECONNECT_DELAY_MS);
  });
}

async function connectWithViaProxy() {
  try {
    await startViaProxy();
    createBot(true);
  } catch (e) {
    log(`❌ Lỗi ViaProxy: ${e.message}`);
  }
}

function cleanupState() {
  if (autoEatInterval) { clearInterval(autoEatInterval); autoEatInterval = null; }
  if (antiAfkInterval) { clearInterval(antiAfkInterval); antiAfkInterval = null; }
  if (keepAlivePulseInterval) { clearInterval(keepAlivePulseInterval); keepAlivePulseInterval = null; }
  if (bot) {
    try { bot.removeAllListeners(); } catch (_) {}
    try { bot.end(); } catch (_) {}
    bot = null;
  }
}

const healthServers = [];

function startHealthServer() {
  const portsToTry = Array.from(new Set([
    parseInt(process.env.PORT || '0', 10),
    parseInt(process.env.WEB_PORT || '0', 10),
    5000, 3000, 8080
  ].filter(p => p > 0)));

  for (const port of portsToTry) {
    const server = http.createServer((req, res) => {
      const url = req.url || '/';
      if (url === '/health' || url === '/healthz' || url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          status: 'ok',
          uptime: Math.floor(process.uptime()),
          timestamp: new Date().toISOString(),
          bot: {
            username: BOT_USERNAME,
            connected: Boolean(bot && bot.entity),
            hp: bot?.health ?? 0,
            food: bot?.food ?? 0,
            pos: bot?.entity?.position ? { x: Number(bot.entity.position.x.toFixed(1)), y: Number(bot.entity.position.y.toFixed(1)), z: Number(bot.entity.position.z.toFixed(1)) } : null
          }
        }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Not Found' }));
      }
    });
    server.on('error', () => { });
    server.listen(port, '0.0.0.0', () => {
      log(`🌐 HTTP Health Server lắng nghe cổng ${port}`);
    });
    healthServers.push(server);
  }
}

function shutdown(sig) {
  log(`${sig} → đang thoát...`);
  cleanupState();
  healthServers.forEach(s => { try { s.close(); } catch (_) { } });
  try { bot?.quit('shutdown'); } catch (_) { }
  if (viaProxyProcess) { viaProxyProcess.kill(); }
  process.exit(0);
}
process.on('uncaughtException', (err) => {
  if (err?.code === 'ECONNRESET' || err?.message?.includes('ECONNRESET')) {
    log('⚠️ Mạng Aternos ngắt kết nối tạm thời (ECONNRESET)');
    return;
  }
  log(`⚠️ Lỗi hệ thống: ${err.message}`);
});
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function main() {
  log('══════════════════════════════════════════');
  log('   Minecraft AFK Bot 24/7 — Pure Keep-Alive');
  log('══════════════════════════════════════════');
  log(`Server : ${SERVER_HOST}:${SERVER_PORT}`);
  log(`Bot    : ${BOT_USERNAME}`);
  log('──────────────────────────────────────────');

  startHealthServer();
  // Thử kết nối trực tiếp (siêu nhẹ ~40MB RAM) trước
  createBot(false);
}

main();
