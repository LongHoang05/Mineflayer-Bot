// ============================================================
// Minecraft Combat Bot — Mineflayer + Pathfinder + ViaProxy
// ============================================================
// Luồng kết nối:
//   Bot (1.21.5) → ViaProxy localhost:25568 → Server (26.2)
//
// ViaProxy tự động dịch giữa version bot và server, cho phép
// Mineflayer nối tới server bất kỳ version nào.
// ============================================================

import mineflayer  from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { config }  from 'dotenv';
import { spawn }   from 'child_process';
import { createServer } from 'net';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import http from 'http';

const { pathfinder, Movements, goals } = pathfinderPkg;

config(); // Đọc .env

// ─── Đường dẫn ViaProxy JAR ──────────────────────────────────
const __dirname   = dirname(fileURLToPath(import.meta.url));
const VIAPROXY_JAR = join(__dirname, '..', 'viaproxy', 'ViaProxy.jar');

// ─── Cấu hình từ .env ────────────────────────────────────────
const SERVER_HOST    = process.env.MC_HOST          || 'localhost';
const SERVER_PORT    = parseInt(process.env.MC_PORT || '25565', 10);
const BOT_USERNAME   = process.env.MC_USERNAME      || 'CombatBot';
const SERVER_VERSION = process.env.MC_VERSION       || '26.2';   // version server thực
const BOT_VERSION    = process.env.BOT_VERSION      || '1.21.5'; // version bot nói chuyện với proxy
const MC_AUTH        = process.env.MC_AUTH          || 'offline';
const PROXY_PORT     = parseInt(process.env.PROXY_PORT || '25568', 10);

const RECONNECT_DELAY_MS = parseInt(process.env.RECONNECT_DELAY || '5000', 10);
const AUTO_RECONNECT     = process.env.AUTO_RECONNECT !== 'false';
const AUTO_RESPAWN       = process.env.AUTO_RESPAWN   !== 'false';
const AUTO_SLEEP         = process.env.AUTO_SLEEP     !== 'false';

const ATTACK_RANGE       = parseFloat(process.env.ATTACK_RANGE       || '4');
const PATROL_RADIUS      = parseFloat(process.env.PATROL_RADIUS      || '20');
const ATTACK_SPEED_MS    = parseInt(process.env.ATTACK_SPEED         || '500', 10);
const BED_SEARCH_RADIUS  = parseInt(process.env.BED_SEARCH_RADIUS    || '32', 10);

// Minecraft ticks: 12542 = trời tối có thể ngủ, 23460 = sắp sáng
const SLEEP_TIME = 12542;
const WAKE_TIME  = 23460;

// ─── Mob thù địch ────────────────────────────────────────────
const HOSTILE_MOBS = new Set([
  'zombie','skeleton','spider','cave_spider','creeper','enderman',
  'witch','pillager','vindicator','ravager','blaze','ghast',
  'zombie_pigman','zombified_piglin','piglin_brute','hoglin',
  'drowned','husk','stray','phantom','slime','magma_cube',
  'wither_skeleton','guardian','elder_guardian','silverfish',
  'endermite','shulker','vex','evoker',
]);

// ─── Trạng thái ──────────────────────────────────────────────
let bot                = null;
let viaProxyProcess    = null;
let viaProxyReady      = false;
let pvpMode            = false;
let pveMode            = false;
let patrolMode         = false;
let attackLoop         = null;
let patrolTimeout      = null;
let sleepCheckInterval = null;
let autoEatInterval    = null;
let autoArmorInterval  = null;
let antiAfkInterval    = null;
let isSleeping         = false;
let isEating           = false;
let spawnPos           = null;

// ─── Helpers ─────────────────────────────────────────────────
const ts      = () => new Date().toLocaleTimeString();
const log     = (msg) => console.log(`[${ts()}] ${msg}`);

function statusMsg() {
  const p = [];
  if (pvpMode)    p.push('PvP⚔');
  if (pveMode)    p.push('PvE🗡');
  if (patrolMode) p.push('Patrol🗺');
  if (isSleeping) p.push('💤');
  return p.length ? `[${p.join('|')}]` : '[Standby]';
}
const fmtPos = (pos) =>
  pos ? `X:${pos.x.toFixed(1)} Y:${pos.y.toFixed(1)} Z:${pos.z.toFixed(1)}` : '(unknown)';

// ─── Kiểm tra port có đang dùng không ────────────────────────
function isPortFree(port) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port);
  });
}

// ─── KHỞI ĐỘNG VIAPROXY ──────────────────────────────────────
async function startViaProxy() {
  // Nếu đã có tiến trình ViaProxy đang chạy thì bỏ qua
  if (viaProxyProcess && !viaProxyProcess.killed) {
    log('ViaProxy đã chạy rồi, bỏ qua.');
    return;
  }

  // Nếu port đã bị dùng (ViaProxy còn đó từ lần trước) thì dùng luôn
  const free = await isPortFree(PROXY_PORT);
  if (!free) {
    log(`ViaProxy đã chiếm port ${PROXY_PORT}, tiếp tục dùng.`);
    viaProxyReady = true;
    return;
  }

  log(`🔄 Khởi động ViaProxy trên port ${PROXY_PORT}...`);
  log(`   ${SERVER_HOST}:${SERVER_PORT} (${SERVER_VERSION}) ← proxy ← bot (${BOT_VERSION})`);

  viaProxyProcess = spawn('java', [
    '-jar', VIAPROXY_JAR,
    'cli',
    '--target-address',                   `${SERVER_HOST}:${SERVER_PORT}`,
    '--target-version',                   SERVER_VERSION,
    '--bind-address',                     `0.0.0.0:${PROXY_PORT}`,
    '--auth-method',                      'NONE',
    '--proxy-online-mode',                'false',
    '--ignore-protocol-translation-errors', 'true',
    '--suppress-client-protocol-errors',  'true',
    '--connect-timeout',                  '15000',
    '--log-ips',                          'false',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  // Pipe log ViaProxy ra console với prefix
  viaProxyProcess.stdout.on('data', (d) => {
    const line = d.toString().trim();
    if (line) console.log(`[ViaProxy] ${line}`);
    // Phát hiện khi ViaProxy sẵn sàng nhận kết nối
    if (!viaProxyReady && (line.includes('Listening on') || line.includes('started'))) {
      viaProxyReady = true;
    }
  });
  viaProxyProcess.stderr.on('data', (d) => {
    const line = d.toString().trim();
    if (line) console.log(`[ViaProxy] ${line}`);
    if (!viaProxyReady && (line.includes('Listening on') || line.includes('started'))) {
      viaProxyReady = true;
    }
  });
  viaProxyProcess.on('exit', (code) => {
    log(`⚠  ViaProxy thoát với code ${code}`);
    viaProxyReady  = false;
    viaProxyProcess = null;
  });

  // Chờ ViaProxy sẵn sàng (tối đa 30 giây)
  await new Promise((resolve, reject) => {
    const start    = Date.now();
    const interval = setInterval(() => {
      if (viaProxyReady) { clearInterval(interval); resolve(); return; }
      // Backup: poll port trực tiếp
      isPortFree(PROXY_PORT).then((free) => {
        if (!free) { viaProxyReady = true; clearInterval(interval); resolve(); }
      });
      if (Date.now() - start > 30000) {
        clearInterval(interval);
        reject(new Error('ViaProxy khởi động quá 30 giây.'));
      }
    }, 500);
  });

  log(`✓ ViaProxy sẵn sàng trên port ${PROXY_PORT}`);
}

// ─── TÌM MỤC TIÊU ────────────────────────────────────────────
function findTarget() {
  if (!bot?.entity) return null;
  const myPos = bot.entity.position;
  let closest = null, closestDist = Infinity;
  for (const entity of Object.values(bot.entities)) {
    if (!entity?.position || entity.id === bot.entity.id) continue;
    const dist = myPos.distanceTo(entity.position);
    if (dist > ATTACK_RANGE * 6) continue;
    const isPlayer = entity.type === 'player' && entity.username !== bot.username;
    const isMob    = entity.type === 'mob' && HOSTILE_MOBS.has(entity.name);
    if ((pvpMode && isPlayer) || (pveMode && isMob)) {
      if (dist < closestDist) { closestDist = dist; closest = entity; }
    }
  }
  return closest;
}

function findNearestAggressor() {
  if (!bot?.entity) return null;
  const myPos = bot.entity.position;
  let closest = null, closestDist = Infinity;
  for (const entity of Object.values(bot.entities)) {
    if (!entity?.position || entity.id === bot.entity.id) continue;
    const isEnemy =
      (entity.type === 'player' && entity.username !== bot.username) ||
      (entity.type === 'mob' && HOSTILE_MOBS.has(entity.name));
    if (!isEnemy) continue;
    const dist = myPos.distanceTo(entity.position);
    if (dist < closestDist && dist < ATTACK_RANGE * 2) { closestDist = dist; closest = entity; }
  }
  return closest;
}

// ─── VÒNG LẶP CHIẾN ĐẤU ─────────────────────────────────────
function startAttackLoop() {
  if (attackLoop) return;
  attackLoop = setInterval(async () => {
    if (!bot?.entity || isSleeping || (!pvpMode && !pveMode)) return;
    const target = findTarget();
    if (!target) return;
    const dist = bot.entity.position.distanceTo(target.position);
    await bot.lookAt(target.position.offset(0, target.height ?? 1.6, 0));
    if (dist <= ATTACK_RANGE) {
      bot.attack(target);
      log(`⚔  ${target.username || target.name} (${dist.toFixed(1)}m)`);
    } else {
      try { bot.pathfinder.setGoal(new goals.GoalFollow(target, ATTACK_RANGE - 1), true); } catch (_) {}
    }
  }, ATTACK_SPEED_MS);
}

function stopAttackLoop() {
  if (attackLoop) { clearInterval(attackLoop); attackLoop = null; }
  try { bot.pathfinder.stop(); } catch (_) {}
}

// ─── TUẦN TRA ────────────────────────────────────────────────
function scheduleNextPatrol() {
  if (patrolTimeout) clearTimeout(patrolTimeout);
  patrolTimeout = setTimeout(doPatrolStep, 3000 + Math.random() * 5000);
}
function doPatrolStep() {
  if (!patrolMode || !bot?.entity || isSleeping) return;
  if ((pvpMode || pveMode) && findTarget()) { scheduleNextPatrol(); return; }
  const base  = spawnPos || bot.entity.position;
  const angle = Math.random() * 2 * Math.PI;
  const r     = PATROL_RADIUS * (0.4 + Math.random() * 0.6);
  const dest  = base.offset(Math.cos(angle) * r, 0, Math.sin(angle) * r);
  log(`🗺  Tuần tra → ${fmtPos(dest)}`);
  try { bot.pathfinder.setGoal(new goals.GoalXZ(dest.x, dest.z)); } catch (_) {}
  scheduleNextPatrol();
}
function stopPatrol() {
  patrolMode = false;
  if (patrolTimeout) { clearTimeout(patrolTimeout); patrolTimeout = null; }
  try { bot.pathfinder.stop(); } catch (_) {}
}

// ─── TỰ HỒI SINH ─────────────────────────────────────────────
function setupAutoRespawn() {
  bot.on('death', () => {
    log('💀 Bot đã chết!');
    isSleeping = false;
    if (AUTO_RESPAWN) {
      log('↺  Đang hồi sinh...');
      setTimeout(() => { try { bot.respawn(); } catch (_) {} }, 1000);
    }
  });
}

// ─── TỰ NGỦ KHI TỐI ─────────────────────────────────────────
function findNearestBed() {
  return bot.findBlock({
    matching: (b) => b?.name?.endsWith('_bed'),
    maxDistance: BED_SEARCH_RADIUS,
    count: 1,
  }) || null;
}

async function tryGoToSleep() {
  if (!bot?.entity || isSleeping) return false;
  const bed = findNearestBed();
  if (!bed) { log(`🛏  Không thấy giường trong ${BED_SEARCH_RADIUS} blocks.`); return false; }
  log(`🛏  Giường tại ${fmtPos(bed.position)} — đang đến...`);
  try {
    await bot.pathfinder.goto(
      new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2)
    );
  } catch (e) { log(`Đến giường thất bại: ${e.message}`); return false; }
  try {
    await bot.sleep(bed);
    isSleeping = true;
    log('💤 Đang ngủ...');
    return true;
  } catch (e) { log(`Ngủ thất bại: ${e.message}`); return false; }
}

function setupAutoSleep() {
  if (!AUTO_SLEEP) return;
  bot.on('wake', () => { isSleeping = false; log('☀️  Trời sáng rồi, thức dậy!'); });
  sleepCheckInterval = setInterval(async () => {
    if (!bot?.entity) return;
    const time = bot.time?.timeOfDay ?? 0;
    if (time >= SLEEP_TIME && time < WAKE_TIME && !isSleeping) {
      log(`🌙 Tối rồi (tick ${time}) — tìm giường...`);
      const wasPvp = pvpMode, wasPve = pveMode, wasPat = patrolMode;
      pvpMode = pveMode = patrolMode = false;
      try { bot.pathfinder.stop(); } catch (_) {}
      const slept = await tryGoToSleep();
      if (!slept) {
        pvpMode = wasPvp; pveMode = wasPve; patrolMode = wasPat;
        if (patrolMode) doPatrolStep();
      }
    }
  }, 10_000);
}

// ─── TỰ ĐỘNG ĂN (AUTO-EAT) ────────────────────────────────────
const EDIBLE_FOODS = new Set([
  'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken',
  'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'baked_potato',
  'bread', 'golden_apple', 'golden_carrot', 'apple', 'carrot',
  'melon_slice', 'sweet_berries', 'glow_berries', 'steak'
]);

async function checkAndAutoEat() {
  if (!bot || !bot.entity || isSleeping || isEating) return;
  const hunger = bot.food ?? 20;
  if (hunger >= 16) return;

  const foodItem = bot.inventory.items().find(item => EDIBLE_FOODS.has(item.name));
  if (!foodItem) return;

  try {
    isEating = true;
    log(`🍖 Đang tự động ăn ${foodItem.name} (Hunger: ${hunger}/20)...`);
    await bot.equip(foodItem, 'hand');
    await bot.consume();
    log(`✓ Đã ăn xong ${foodItem.name} (Hunger hiện tại: ${bot.food}/20)`);
  } catch (err) {
    log(`⚠️ Lỗi khi tự ăn: ${err.message}`);
  } finally {
    isEating = false;
  }
}

function setupAutoEat() {
  if (autoEatInterval) clearInterval(autoEatInterval);
  autoEatInterval = setInterval(() => {
    checkAndAutoEat();
  }, 4_000);
}

// ─── TỰ ĐỘNG MẶC GIÁP & CẦM TOTEM/KHIÊN (AUTO-ARMOR & OFFHAND) 
const ARMOR_TIERS = {
  head: ['netherite_helmet', 'diamond_helmet', 'iron_helmet', 'golden_helmet', 'chainmail_helmet', 'leather_helmet'],
  torso: ['netherite_chestplate', 'diamond_chestplate', 'iron_chestplate', 'golden_chestplate', 'chainmail_chestplate', 'leather_chestplate'],
  legs: ['netherite_leggings', 'diamond_leggings', 'iron_leggings', 'golden_leggings', 'chainmail_leggings', 'leather_leggings'],
  feet: ['netherite_boots', 'diamond_boots', 'iron_boots', 'golden_boots', 'chainmail_boots', 'leather_boots']
};

async function checkAndEquipArmor() {
  if (!bot || !bot.entity || isSleeping || isEating) return;
  const items = bot.inventory.items();

  for (const [destSlot, tierList] of Object.entries(ARMOR_TIERS)) {
    const equipped = bot.inventory.slots[bot.getEquipmentDestSlot(destSlot)];
    let currentRank = equipped ? tierList.indexOf(equipped.name) : -1;

    for (let i = 0; i < tierList.length; i++) {
      const armorName = tierList[i];
      if (currentRank !== -1 && currentRank <= i) break;

      const candidate = items.find(item => item.name === armorName);
      if (candidate) {
        try {
          log(`🛡️ Tự động trang bị ${candidate.name}...`);
          await bot.equip(candidate, destSlot);
        } catch (_) {}
        break;
      }
    }
  }

  // Tự động cầm Totem of Undying hoặc Khiên ở tay phụ (offhand)
  const offhandSlot = 45;
  const currentOffhand = bot.inventory.slots[offhandSlot];
  if (!currentOffhand || (currentOffhand.name !== 'totem_of_undying' && currentOffhand.name !== 'shield')) {
    const totem = items.find(i => i.name === 'totem_of_undying');
    const shield = items.find(i => i.name === 'shield');
    const bestOffhand = totem || shield;

    if (bestOffhand) {
      try {
        log(`🛡️ Cầm ${bestOffhand.name} ở tay phụ (offhand)...`);
        await bot.equip(bestOffhand, 'off-hand');
      } catch (_) {}
    }
  }
}

function setupAutoArmor() {
  if (autoArmorInterval) clearInterval(autoArmorInterval);
  autoArmorInterval = setInterval(() => {
    checkAndEquipArmor();
  }, 8_000);
}

// ─── CHỐNG AFK THÔNG MINH (SMART ANTI-AFK) ───────────────────
function setupAntiAFK() {
  if (antiAfkInterval) clearInterval(antiAfkInterval);
  antiAfkInterval = setInterval(async () => {
    if (!bot || !bot.entity || isSleeping || isEating) return;
    if (patrolMode || pvpMode || pveMode) return;

    try {
      const actionType = Math.floor(Math.random() * 3);
      if (actionType === 0) {
        const yawShift = (Math.random() - 0.5) * 0.8;
        const pitchShift = (Math.random() - 0.5) * 0.4;
        await bot.look(bot.entity.yaw + yawShift, bot.entity.pitch + pitchShift, true);
      } else if (actionType === 1) {
        bot.swingArm('hand');
      } else if (actionType === 2) {
        if (Math.random() > 0.5) {
          bot.setControlState('jump', true);
          setTimeout(() => { try { bot.setControlState('jump', false); } catch (_) {} }, 150);
        } else {
          bot.setControlState('sneak', true);
          setTimeout(() => { try { bot.setControlState('sneak', false); } catch (_) {} }, 500);
        }
      }
    } catch (_) {}
  }, 25_000 + Math.floor(Math.random() * 15_000));
}

// ─── TẠO BOT (KẾT NỐI QUA PROXY) ────────────────────────────
function createBot() {
  log(`🤖 Kết nối: bot → proxy(localhost:${PROXY_PORT}) → ${SERVER_HOST}:${SERVER_PORT}`);

  bot = mineflayer.createBot({
    host:     '127.0.0.1',     // ← nối vào ViaProxy cục bộ
    port:     PROXY_PORT,
    username: BOT_USERNAME,
    version:  BOT_VERSION,     // version bot dùng để nói chuyện với proxy
    auth:     MC_AUTH,
  });

  bot.loadPlugin(pathfinder);

  bot.once('spawn', () => {
    spawnPos   = bot.entity.position.clone();
    isSleeping = false;
    const move = new Movements(bot);
    move.canDig          = false;
    move.allow1by1towers = false;
    bot.pathfinder.setMovements(move);
    log(`✓ Đã vào thế giới tại ${fmtPos(spawnPos)}`);
    log('Sẵn sàng! Chat: !pvp !pve !patrol !attack !follow !sleep !pos !status !stop !help');
    setupAutoRespawn();
    setupAutoSleep();
    setupAutoEat();
    setupAutoArmor();
    setupAntiAFK();
    startAttackLoop();
  });

  // ── Chat commands ──────────────────────────────────────────
  bot.on('chat', async (username, message) => {
    if (username === bot.username) return;
    log(`[Chat] <${username}> ${message}`);
    const parts = message.trim().split(/\s+/);
    const cmd   = parts[0].toLowerCase();

    if (cmd === '!pvp') {
      pvpMode = !pvpMode;
      bot.chat(`PvP ${pvpMode ? 'BẬT ⚔' : 'TẮT'} ${statusMsg()}`);

    } else if (cmd === '!pve') {
      pveMode = !pveMode;
      bot.chat(`PvE ${pveMode ? 'BẬT 🗡' : 'TẮT'} ${statusMsg()}`);

    } else if (cmd === '!patrol') {
      if (patrolMode) { stopPatrol(); bot.chat(`Dừng tuần tra. ${statusMsg()}`); }
      else { patrolMode = true; bot.chat(`Tuần tra bắt đầu! ${statusMsg()}`); doPatrolStep(); }

    } else if (cmd === '!attack') {
      const name = parts[1];
      if (!name) { bot.chat('Dùng: !attack <tên>'); return; }
      const p = bot.players[name];
      if (!p?.entity) { bot.chat(`Không thấy "${name}".`); return; }
      bot.pathfinder.setGoal(new goals.GoalFollow(p.entity, ATTACK_RANGE - 1), true);
      bot.chat(`Đang đuổi đánh ${name}! ⚔`);

    } else if (cmd === '!follow') {
      const name = parts[1];
      if (!name) { bot.chat('Dùng: !follow <tên>'); return; }
      const p = bot.players[name];
      if (!p?.entity) { bot.chat(`Không thấy "${name}".`); return; }
      bot.pathfinder.setGoal(new goals.GoalFollow(p.entity, 2), true);
      bot.chat(`Đang theo ${name}!`);

    } else if (cmd === '!sleep') {
      if (!(await tryGoToSleep())) bot.chat('Không tìm được giường hoặc chưa đến giờ!');

    } else if (cmd === '!wake') {
      if (!isSleeping) { bot.chat('Không đang ngủ.'); return; }
      try { await bot.wake(); bot.chat('Dậy rồi!'); } catch (e) { bot.chat(`Lỗi: ${e.message}`); }

    } else if (cmd === '!pos') {
      bot.chat(`📍 ${fmtPos(bot.entity.position)}`);

    } else if (cmd === '!status') {
      const hp   = (bot.health ?? 0).toFixed(1);
      const food = bot.food ?? 0;
      const time = bot.time?.timeOfDay ?? 0;
      const tod  = time < 12000 ? '☀️' : '🌙';
      bot.chat(`HP:${hp}❤ Food:${food}🍗 ${tod}(${time}) ${statusMsg()}`);

    } else if (cmd === '!say') {
      const text = parts.slice(1).join(' ');
      if (text) bot.chat(text); else bot.chat('Dùng: !say <tin nhắn>');

    } else if (cmd === '!stop') {
      stopAttackLoop(); stopPatrol();
      pvpMode = pveMode = false;
      bot.chat('Tắt hết rồi! 👋');
      setTimeout(() => { bot.quit('stop'); process.exit(0); }, 500);

    } else if (cmd === '!help') {
      bot.chat('!pvp !pve !patrol !attack<tên> !follow<tên> !sleep !wake !pos !status !say<msg> !stop');
    }
  });

  // ── Đánh trả khi bị tấn công ──────────────────────────────
  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity || isSleeping) return;
    const attacker = findNearestAggressor();
    if (!attacker) return;
    log(`💢 Bị ${attacker.username || attacker.name || 'ai đó'} tấn công → đánh trả!`);
    try { bot.pathfinder.setGoal(new goals.GoalFollow(attacker, ATTACK_RANGE - 1), true); } catch (_) {}
    bot.lookAt(attacker.position.offset(0, attacker.height ?? 1.6, 0));
    bot.attack(attacker);
  });

  // ── Tránh rơi ─────────────────────────────────────────────
  bot.on('move', () => {
    if ((bot?.entity?.position?.y ?? 0) < -60) {
      try { bot.pathfinder.stop(); } catch (_) {}
    }
  });

  // ── Kết nối lại ───────────────────────────────────────────
  bot.on('kicked',  (r) => { log(`✗ Bị kick: ${r}`); cleanupState(); });
  bot.on('error',   (e) => log(`✗ Lỗi: ${e.message}`));
  bot.on('end', async (reason) => {
    log(`✗ Mất kết nối (${reason || 'không rõ'}).`);
    cleanupState();
    if (AUTO_RECONNECT) {
      log(`↻  Kết nối lại sau ${RECONNECT_DELAY_MS / 1000}s...`);
      setTimeout(async () => {
        try { await startViaProxy(); } catch (e) { log(`ViaProxy lỗi: ${e.message}`); }
        createBot();
      }, RECONNECT_DELAY_MS);
    } else { process.exit(0); }
  });
}

// ─── Dọn dẹp state ───────────────────────────────────────────
function cleanupState() {
  stopAttackLoop(); stopPatrol();
  pvpMode = pveMode = patrolMode = isSleeping = isEating = false;
  if (sleepCheckInterval) { clearInterval(sleepCheckInterval); sleepCheckInterval = null; }
  if (autoEatInterval)    { clearInterval(autoEatInterval);    autoEatInterval = null; }
  if (autoArmorInterval)  { clearInterval(autoArmorInterval);  autoArmorInterval = null; }
  if (antiAfkInterval)    { clearInterval(antiAfkInterval);    antiAfkInterval = null; }
}

const healthServers = [];

// ─── HTTP Health Server (UptimeRobot Keep-Alive) ────────────
function startHealthServer() {
  const portsToTry = Array.from(new Set([
    parseInt(process.env.PORT || '0', 10),
    parseInt(process.env.WEB_PORT || '0', 10),
    5000,
    3000,
    8080
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
            isEating,
            pvp: pvpMode,
            pve: pveMode,
            patrol: patrolMode,
            sleeping: isSleeping,
            pos: bot?.entity?.position ? { x: Number(bot.entity.position.x.toFixed(1)), y: Number(bot.entity.position.y.toFixed(1)), z: Number(bot.entity.position.z.toFixed(1)) } : null
          }
        }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Not Found' }));
      }
    });

    server.on('error', (err) => {
      if (err.code !== 'EADDRINUSE') {
        log(`⚠️ Lỗi HTTP Health Server (Port ${port}): ${err.message}`);
      }
    });

    server.listen(port, '0.0.0.0', () => {
      log(`🌐 HTTP Health Server đang lắng nghe cổng ${port} (Endpoints: /health, /healthz, /)`);
    });

    healthServers.push(server);
  }
}

// ─── Thoát an toàn ───────────────────────────────────────────
function shutdown(sig) {
  log(`${sig} → đang thoát...`);
  cleanupState();
  healthServers.forEach(s => { try { s.close(); } catch (_) {} });
  try { bot?.quit('shutdown'); } catch (_) {}
  if (viaProxyProcess) { viaProxyProcess.kill(); }
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── KHỞI ĐỘNG ───────────────────────────────────────────────
async function main() {
  log('══════════════════════════════════════════');
  log('   Minecraft Combat Bot — Khởi động        ');
  log('══════════════════════════════════════════');
  log(`Server  : ${SERVER_HOST}:${SERVER_PORT} (v${SERVER_VERSION})`);
  log(`Bot     : ${BOT_USERNAME} (v${BOT_VERSION} qua ViaProxy)`);
  log(`Proxy   : localhost:${PROXY_PORT}`);
  log(`Auth    : ${MC_AUTH} | Respawn:${AUTO_RESPAWN} | Sleep:${AUTO_SLEEP}`);
  log('──────────────────────────────────────────');

  startHealthServer();

  try {
    await startViaProxy();
  } catch (e) {
    log(`❌ Không khởi động được ViaProxy: ${e.message}`);
    process.exit(1);
  }

  createBot();
}

main();
