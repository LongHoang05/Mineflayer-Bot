// ============================================================
// Minecraft Combat Bot — Mineflayer + Pathfinder
// ============================================================
// Tính năng:
//   • PvP / PvE tự động
//   • Tuần tra bản đồ
//   • Tự hồi sinh khi chết
//   • Tự tìm giường ngủ khi trời tối
//   • Tự kết nối lại khi mất mạng
// ============================================================

import mineflayer from 'mineflayer';
import { pathfinder, Movements, goals } from 'mineflayer-pathfinder';
import { config } from 'dotenv';

config(); // Đọc file .env

// ─── Cấu hình (từ .env) ──────────────────────────────────────
const BOT_CONFIG = {
  host:     process.env.MC_HOST     || 'localhost',
  port:     parseInt(process.env.MC_PORT || '25565', 10),
  username: process.env.MC_USERNAME || 'CombatBot',
  version:  process.env.MC_VERSION  || undefined,
  auth:     process.env.MC_AUTH     || 'offline',
};

const RECONNECT_DELAY_MS = parseInt(process.env.RECONNECT_DELAY || '5000', 10);
const AUTO_RECONNECT     = process.env.AUTO_RECONNECT !== 'false';
const AUTO_RESPAWN       = process.env.AUTO_RESPAWN   !== 'false'; // tự hồi sinh
const AUTO_SLEEP         = process.env.AUTO_SLEEP     !== 'false'; // tự đi ngủ

const ATTACK_RANGE    = parseFloat(process.env.ATTACK_RANGE   || '4');
const PATROL_RADIUS   = parseFloat(process.env.PATROL_RADIUS  || '20');
const ATTACK_SPEED_MS = parseInt(process.env.ATTACK_SPEED     || '500', 10);

// Khoảng cách tối đa để tìm giường (blocks)
const BED_SEARCH_RADIUS = parseInt(process.env.BED_SEARCH_RADIUS || '32', 10);

// Thời gian Minecraft (ticks):
//   0     = bình minh
//   6000  = giữa trưa
//   12000 = hoàng hôn — bắt đầu tối
//   13000 = có thể ngủ
//   18000 = nửa đêm
//   24000 = bình minh mới
const SLEEP_TIME  = 12542; // tick tối thiểu để leo lên giường
const WAKE_TIME   = 23460; // tick bot tự thức nếu không ngủ được

// ─── Danh sách mob thù ───────────────────────────────────────
const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'spider', 'cave_spider', 'creeper', 'enderman',
  'witch', 'pillager', 'vindicator', 'ravager', 'blaze', 'ghast',
  'zombie_pigman', 'zombified_piglin', 'piglin_brute', 'hoglin',
  'drowned', 'husk', 'stray', 'phantom', 'slime', 'magma_cube',
  'wither_skeleton', 'guardian', 'elder_guardian', 'silverfish',
  'endermite', 'shulker', 'vex', 'evoker',
]);

// ─── Trạng thái ──────────────────────────────────────────────
let bot           = null;
let pvpMode       = false;
let pveMode       = false;
let patrolMode    = false;
let attackLoop    = null;
let patrolTimeout = null;
let sleepCheckInterval = null;
let isSleeping    = false;
let spawnPos      = null;

// ─── Helpers ─────────────────────────────────────────────────
function ts()     { return new Date().toLocaleTimeString(); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }

function statusMsg() {
  const parts = [];
  if (pvpMode)    parts.push('PvP✓');
  if (pveMode)    parts.push('PvE✓');
  if (patrolMode) parts.push('Patrol✓');
  if (isSleeping) parts.push('💤Ngủ');
  return parts.length ? `[${parts.join(' | ')}]` : '[Standby]';
}

function fmtPos(pos) {
  if (!pos) return '(unknown)';
  return `X:${pos.x.toFixed(1)} Y:${pos.y.toFixed(1)} Z:${pos.z.toFixed(1)}`;
}

// ─── TÌM MỤC TIÊU ────────────────────────────────────────────
function findTarget() {
  if (!bot?.entity) return null;
  const myPos = bot.entity.position;
  let closest = null, closestDist = Infinity;

  for (const entity of Object.values(bot.entities)) {
    if (!entity?.position) continue;
    if (entity.id === bot.entity.id) continue;
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
      (entity.type === 'mob'    && HOSTILE_MOBS.has(entity.name));
    if (!isEnemy) continue;
    const dist = myPos.distanceTo(entity.position);
    if (dist < closestDist && dist < ATTACK_RANGE * 2) {
      closestDist = dist; closest = entity;
    }
  }
  return closest;
}

// ─── VÒNG LẶP CHIẾN ĐẤU ─────────────────────────────────────
function startAttackLoop() {
  if (attackLoop) return;
  attackLoop = setInterval(async () => {
    if (!bot?.entity || isSleeping) return;
    if (!pvpMode && !pveMode) return;
    const target = findTarget();
    if (!target) return;
    const dist = bot.entity.position.distanceTo(target.position);
    await bot.lookAt(target.position.offset(0, target.height ?? 1.6, 0));
    if (dist <= ATTACK_RANGE) {
      bot.attack(target);
      const name = target.username || target.name || target.type;
      log(`⚔  Đánh ${name} (${dist.toFixed(1)} blocks)`);
    } else {
      try { bot.pathfinder.setGoal(new goals.GoalFollow(target, ATTACK_RANGE - 1), true); }
      catch (_) {}
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
      setTimeout(() => {
        try { bot.respawn(); } catch (e) { log(`Lỗi hồi sinh: ${e.message}`); }
      }, 1000);
    }
  });

  // Sau khi hồi sinh, spawn lại bình thường
  bot.on('spawn', () => {
    isSleeping = false;
  });
}

// ─── TỰ NGỦ KHI TỐI ─────────────────────────────────────────

/**
 * Tìm block giường gần nhất trong bán kính BED_SEARCH_RADIUS.
 * Mineflayer dùng tên block kết thúc bằng '_bed'.
 */
function findNearestBed() {
  if (!bot?.entity) return null;
  const pos = bot.entity.position;

  // Lấy tất cả block trong bán kính rồi lọc theo tên
  const bedBlock = bot.findBlock({
    matching: (block) => block && block.name && block.name.endsWith('_bed'),
    maxDistance: BED_SEARCH_RADIUS,
    count: 1,
  });

  return bedBlock || null;
}

/**
 * Cố gắng đến giường và ngủ.
 * Trả về true nếu thành công.
 */
async function tryGoToSleep() {
  if (!bot?.entity || isSleeping) return false;

  const bed = findNearestBed();
  if (!bed) {
    log('🛏  Không tìm thấy giường trong bán kính ' + BED_SEARCH_RADIUS + ' blocks.');
    return false;
  }

  log(`🛏  Tìm thấy giường tại ${fmtPos(bed.position)} — đang đến...`);

  // Di chuyển đến gần giường
  try {
    await bot.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2));
  } catch (e) {
    log(`Không đến được giường: ${e.message}`);
    return false;
  }

  // Thử leo lên giường
  try {
    await bot.sleep(bed);
    isSleeping = true;
    log('💤 Đang ngủ...');
    return true;
  } catch (e) {
    log(`Không ngủ được: ${e.message}`);
    return false;
  }
}

function setupAutoSleep() {
  if (!AUTO_SLEEP) return;

  // Lắng nghe event thức dậy
  bot.on('wake', () => {
    isSleeping = false;
    log('☀️  Đã thức dậy — trời sáng rồi!');
  });

  // Kiểm tra giờ giấc mỗi 10 giây (game time thay đổi liên tục)
  sleepCheckInterval = setInterval(async () => {
    if (!bot?.entity) return;
    const time = bot.time?.timeOfDay ?? 0;

    // Đến giờ ngủ và chưa ngủ
    if (time >= SLEEP_TIME && time < WAKE_TIME && !isSleeping) {
      log(`🌙 Trời tối (tick ${time}) — tìm giường...`);
      // Tạm dừng combat/patrol để đi ngủ
      const wasPvp    = pvpMode;
      const wasPve    = pveMode;
      const wasPatrol = patrolMode;
      pvpMode = pveMode = patrolMode = false;
      try { bot.pathfinder.stop(); } catch (_) {}

      const slept = await tryGoToSleep();

      // Nếu không ngủ được, khôi phục lại chế độ cũ
      if (!slept) {
        pvpMode    = wasPvp;
        pveMode    = wasPve;
        patrolMode = wasPatrol;
        if (patrolMode) doPatrolStep();
      }
    }
  }, 10_000);
}

// ─── TẠO BOT ─────────────────────────────────────────────────
function createBot() {
  log(`Đang kết nối → ${BOT_CONFIG.host}:${BOT_CONFIG.port} (${BOT_CONFIG.username})`);

  bot = mineflayer.createBot({
    host:     BOT_CONFIG.host,
    port:     BOT_CONFIG.port,
    username: BOT_CONFIG.username,
    version:  BOT_CONFIG.version,
    auth:     BOT_CONFIG.auth,
  });

  bot.loadPlugin(pathfinder);

  // ── Spawn ──────────────────────────────────────────────────
  bot.once('spawn', () => {
    spawnPos  = bot.entity.position.clone();
    isSleeping = false;

    // Cấu hình di chuyển
    const move = new Movements(bot);
    move.canDig              = false;
    move.allow1by1towers     = false;
    move.allowFreeMotion     = false;
    bot.pathfinder.setMovements(move);

    log(`✓ Đã vào thế giới tại ${fmtPos(spawnPos)}`);
    log('Sẵn sàng! Gõ !help trong chat để xem lệnh.');

    setupAutoRespawn();
    setupAutoSleep();
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
      if (patrolMode) {
        stopPatrol();
        bot.chat(`Dừng tuần tra. ${statusMsg()}`);
      } else {
        patrolMode = true;
        bot.chat(`Bắt đầu tuần tra! ${statusMsg()}`);
        doPatrolStep();
      }

    } else if (cmd === '!attack') {
      const name = parts[1];
      if (!name) { bot.chat('Dùng: !attack <tên người chơi>'); return; }
      const player = bot.players[name];
      if (!player?.entity) { bot.chat(`Không tìm thấy "${name}".`); return; }
      try {
        bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, ATTACK_RANGE - 1), true);
        bot.chat(`Đang đuổi đánh ${name}! ⚔`);
      } catch (e) { bot.chat(`Lỗi: ${e.message}`); }

    } else if (cmd === '!follow') {
      const name = parts[1];
      if (!name) { bot.chat('Dùng: !follow <tên>'); return; }
      const player = bot.players[name];
      if (!player?.entity) { bot.chat(`Không tìm thấy "${name}".`); return; }
      bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, 2), true);
      bot.chat(`Đang theo ${name}!`);

    } else if (cmd === '!sleep') {
      // Ngủ thủ công
      const slept = await tryGoToSleep();
      if (!slept) bot.chat('Không tìm thấy giường hoặc chưa đến giờ ngủ!');

    } else if (cmd === '!wake') {
      if (!isSleeping) { bot.chat('Mình không đang ngủ.'); return; }
      try { await bot.wake(); bot.chat('Đã thức dậy!'); }
      catch (e) { bot.chat(`Lỗi: ${e.message}`); }

    } else if (cmd === '!pos') {
      bot.chat(`📍 ${fmtPos(bot.entity.position)}`);

    } else if (cmd === '!status') {
      const hp   = (bot.health ?? 0).toFixed(1);
      const food = bot.food ?? 0;
      const time = bot.time?.timeOfDay ?? 0;
      const tod  = time < 12000 ? '☀️ Ban ngày' : '🌙 Ban đêm';
      bot.chat(`HP:${hp}❤ | Food:${food}🍗 | ${tod}(${time}) | ${statusMsg()}`);

    } else if (cmd === '!say') {
      const text = parts.slice(1).join(' ');
      if (!text) { bot.chat('Dùng: !say <tin nhắn>'); return; }
      bot.chat(text);

    } else if (cmd === '!stop') {
      stopAttackLoop(); stopPatrol();
      pvpMode = pveMode = false;
      bot.chat('Tắt hết rồi, tạm biệt! 👋');
      setTimeout(() => { bot.quit('stop'); process.exit(0); }, 500);

    } else if (cmd === '!help') {
      bot.chat(
        '!pvp !pve !patrol !attack<tên> !follow<tên> ' +
        '!sleep !wake !pos !status !say<msg> !stop'
      );
    }
  });

  // ── Đánh trả khi bị tấn công ──────────────────────────────
  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity || isSleeping) return;
    const attacker = findNearestAggressor();
    if (!attacker) return;
    const name = attacker.username || attacker.name || 'kẻ tấn công';
    log(`💢 Bị tấn công bởi ${name} → đánh trả!`);
    try { bot.pathfinder.setGoal(new goals.GoalFollow(attacker, ATTACK_RANGE - 1), true); }
    catch (_) {}
    bot.lookAt(attacker.position.offset(0, attacker.height ?? 1.6, 0));
    bot.attack(attacker);
  });

  // ── Rơi xuống hố ──────────────────────────────────────────
  bot.on('move', () => {
    if (bot?.entity?.position?.y < -60) {
      log('⚠  Y < -60, dừng di chuyển tránh rơi!');
      try { bot.pathfinder.stop(); } catch (_) {}
    }
  });

  // ── Kick / lỗi / mất kết nối ──────────────────────────────
  bot.on('kicked', (reason) => log(`✗ Bị kick: ${reason}`));
  bot.on('error',  (err)    => log(`✗ Lỗi: ${err.message}`));
  bot.on('end', (reason) => {
    log(`✗ Mất kết nối (${reason || 'không rõ'}).`);
    cleanupState();
    if (AUTO_RECONNECT) {
      log(`↻  Kết nối lại sau ${RECONNECT_DELAY_MS / 1000}s...`);
      setTimeout(createBot, RECONNECT_DELAY_MS);
    } else { process.exit(0); }
  });
}

// ─── Dọn dẹp state ───────────────────────────────────────────
function cleanupState() {
  stopAttackLoop(); stopPatrol();
  pvpMode = pveMode = patrolMode = isSleeping = false;
  if (sleepCheckInterval) { clearInterval(sleepCheckInterval); sleepCheckInterval = null; }
}

// ─── Thoát an toàn ───────────────────────────────────────────
function shutdown(sig) {
  log(`${sig} → đang thoát...`);
  cleanupState();
  try { bot?.quit('shutdown'); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Khởi động ───────────────────────────────────────────────
log('══════════════════════════════════════');
log('   Minecraft Combat Bot — Khởi động   ');
log('══════════════════════════════════════');
log(`Server  : ${BOT_CONFIG.host}:${BOT_CONFIG.port}`);
log(`Username: ${BOT_CONFIG.username}`);
log(`Version : ${BOT_CONFIG.version || 'auto-detect'}`);
log(`Auth    : ${BOT_CONFIG.auth}`);
log(`AutoRespawn: ${AUTO_RESPAWN} | AutoSleep: ${AUTO_SLEEP}`);
log('──────────────────────────────────────');
createBot();
