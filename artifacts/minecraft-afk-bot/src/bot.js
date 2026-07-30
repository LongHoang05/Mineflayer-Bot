// ============================================================
// Minecraft Combat Bot — Mineflayer + Pathfinder
// ============================================================
// Bot tự động chạy loanh quanh, tìm kiếm và tấn công
// người chơi / mob gần nhất. Hỗ trợ PvP, PvE và tuần tra.
// ============================================================

import mineflayer from 'mineflayer';
import { pathfinder, Movements, goals } from 'mineflayer-pathfinder';
import { config } from 'dotenv';

config();

// ─── Cấu hình từ .env ────────────────────────────────────────
const BOT_CONFIG = {
  host:     process.env.MC_HOST     || 'localhost',
  port:     parseInt(process.env.MC_PORT || '25565', 10),
  username: process.env.MC_USERNAME || 'CombatBot',
  version:  process.env.MC_VERSION  || undefined,
  auth:     process.env.MC_AUTH     || 'offline',
};

const RECONNECT_DELAY_MS = parseInt(process.env.RECONNECT_DELAY || '5000', 10);
const AUTO_RECONNECT     = process.env.AUTO_RECONNECT !== 'false';

// Khoảng cách (blocks) để phát hiện và tấn công mục tiêu
const ATTACK_RANGE   = parseFloat(process.env.ATTACK_RANGE   || '4');
// Khoảng cách (blocks) bán kính tuần tra
const PATROL_RADIUS  = parseFloat(process.env.PATROL_RADIUS  || '20');
// Tốc độ đánh (ms giữa mỗi cú đấm)
const ATTACK_SPEED_MS = parseInt(process.env.ATTACK_SPEED || '500', 10);

// ─── Trạng thái bot ──────────────────────────────────────────
let bot           = null;
let pvpMode       = false;   // tấn công người chơi
let pveMode       = false;   // tấn công mob thù địch
let patrolMode    = false;   // tự đi loanh quanh
let attackLoop    = null;    // setInterval cho combat
let patrolTimeout = null;    // setTimeout cho patrol
let spawnPos      = null;    // vị trí spawn ban đầu

// Danh sách mob thù địch thường gặp
const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'spider', 'creeper', 'enderman',
  'witch', 'pillager', 'vindicator', 'ravager', 'blaze',
  'ghast', 'zombie_pigman', 'piglin_brute', 'hoglin',
  'drowned', 'husk', 'stray', 'phantom', 'slime',
  'magma_cube', 'wither_skeleton', 'guardian', 'elder_guardian',
]);

// ─── Helpers ─────────────────────────────────────────────────

function ts()       { return new Date().toLocaleTimeString(); }
function log(msg)   { console.log(`[${ts()}] ${msg}`); }

function statusMsg() {
  const modes = [];
  if (pvpMode)    modes.push('PvP✓');
  if (pveMode)    modes.push('PvE✓');
  if (patrolMode) modes.push('Tuần tra✓');
  return modes.length ? `[${modes.join(' | ')}]` : '[AFK]';
}

function fmtPos(pos) {
  if (!pos) return '(không biết)';
  return `X:${pos.x.toFixed(1)} Y:${pos.y.toFixed(1)} Z:${pos.z.toFixed(1)}`;
}

// ─── Tìm mục tiêu gần nhất ───────────────────────────────────

/**
 * Trả về entity gần nhất phù hợp với chế độ hiện tại.
 * PvP → người chơi gần nhất (trừ bot mình)
 * PvE → mob thù địch gần nhất
 */
function findTarget() {
  if (!bot || !bot.entity) return null;
  const myPos = bot.entity.position;
  let closest = null;
  let closestDist = Infinity;

  for (const entity of Object.values(bot.entities)) {
    if (!entity || !entity.position) continue;
    if (entity.id === bot.entity.id) continue;

    const dist = myPos.distanceTo(entity.position);
    if (dist > ATTACK_RANGE * 6) continue; // bỏ qua nếu quá xa

    const isPlayer = entity.type === 'player' && entity.username !== bot.username;
    const isMob    = entity.type === 'mob' && HOSTILE_MOBS.has(entity.name);

    if ((pvpMode && isPlayer) || (pveMode && isMob)) {
      if (dist < closestDist) {
        closestDist = dist;
        closest = entity;
      }
    }
  }
  return closest;
}

// ─── Vòng lặp chiến đấu ──────────────────────────────────────

function startAttackLoop() {
  if (attackLoop) return; // đã chạy rồi

  attackLoop = setInterval(async () => {
    if (!bot || !bot.entity) return;
    if (!pvpMode && !pveMode) return;

    const target = findTarget();
    if (!target) return;

    const dist = bot.entity.position.distanceTo(target.position);

    // Nhìn về phía mục tiêu
    await bot.lookAt(target.position.offset(0, target.height ?? 1.6, 0));

    if (dist <= ATTACK_RANGE) {
      // Trong tầm → ĐÁNH
      bot.attack(target);
      const name = target.username || target.name || target.type;
      log(`⚔  Đánh ${name} (cách ${dist.toFixed(1)} blocks)`);
    } else {
      // Ngoài tầm → TIẾN ĐẾN
      try {
        const goal = new goals.GoalFollow(target, ATTACK_RANGE - 1);
        bot.pathfinder.setGoal(goal, true);
      } catch (_) { /* pathfinder chưa sẵn sàng */ }
    }
  }, ATTACK_SPEED_MS);
}

function stopAttackLoop() {
  if (attackLoop) {
    clearInterval(attackLoop);
    attackLoop = null;
  }
  // Dừng di chuyển
  try { bot.pathfinder.stop(); } catch (_) {}
}

// ─── Chế độ tuần tra ─────────────────────────────────────────

function scheduleNextPatrol() {
  if (patrolTimeout) clearTimeout(patrolTimeout);
  // Nghỉ 3-8 giây giữa các bước tuần tra
  const delay = 3000 + Math.random() * 5000;
  patrolTimeout = setTimeout(doPatrolStep, delay);
}

function doPatrolStep() {
  if (!patrolMode || !bot || !bot.entity) return;
  if ((pvpMode || pveMode) && findTarget()) {
    // Có mục tiêu → bỏ qua bước tuần tra, thử lại sau
    scheduleNextPatrol();
    return;
  }

  // Chọn điểm ngẫu nhiên gần vị trí spawn
  const base = spawnPos || bot.entity.position;
  const angle = Math.random() * 2 * Math.PI;
  const r     = PATROL_RADIUS * (0.4 + Math.random() * 0.6);
  const dest  = base.offset(
    Math.cos(angle) * r,
    0,
    Math.sin(angle) * r
  );

  log(`🗺  Tuần tra → ${fmtPos(dest)}`);

  try {
    bot.pathfinder.setGoal(new goals.GoalXZ(dest.x, dest.z));
  } catch (_) {}

  scheduleNextPatrol();
}

function stopPatrol() {
  patrolMode = false;
  if (patrolTimeout) {
    clearTimeout(patrolTimeout);
    patrolTimeout = null;
  }
  try { bot.pathfinder.stop(); } catch (_) {}
}

// ─── Khởi tạo bot ────────────────────────────────────────────

function createBot() {
  log(`Đang kết nối đến ${BOT_CONFIG.host}:${BOT_CONFIG.port} với tên "${BOT_CONFIG.username}"...`);

  bot = mineflayer.createBot({
    host:     BOT_CONFIG.host,
    port:     BOT_CONFIG.port,
    username: BOT_CONFIG.username,
    version:  BOT_CONFIG.version,
    auth:     BOT_CONFIG.auth,
  });

  // Nạp plugin pathfinder
  bot.loadPlugin(pathfinder);

  // ── Spawn ──────────────────────────────────────────────────
  bot.once('spawn', () => {
    spawnPos = bot.entity.position.clone();
    log(`✓ Đã vào thế giới tại ${fmtPos(spawnPos)}`);
    log('Bot sẵn sàng! Dùng chat: !pvp, !pve, !patrol, !attack, !stop, !status');

    // Cấu hình pathfinder
    const defaultMove = new Movements(bot);
    defaultMove.canDig   = false; // không đào block
    defaultMove.allow1by1towers = false;
    bot.pathfinder.setMovements(defaultMove);

    // Bắt đầu vòng lặp combat (idle cho đến khi bật mode)
    startAttackLoop();
  });

  // ── Chat commands ──────────────────────────────────────────
  bot.on('chat', async (username, message) => {
    if (username === bot.username) return;
    log(`[Chat] <${username}> ${message}`);

    const parts = message.trim().split(/\s+/);
    const cmd   = parts[0].toLowerCase();

    // ── !pvp ────────────────────────────────────────────────
    if (cmd === '!pvp') {
      pvpMode = !pvpMode;
      const state = pvpMode ? 'BẬT' : 'TẮT';
      bot.chat(`PvP ${state}! ${statusMsg()}`);
      log(`PvP → ${state}`);
    }

    // ── !pve ────────────────────────────────────────────────
    else if (cmd === '!pve') {
      pveMode = !pveMode;
      const state = pveMode ? 'BẬT' : 'TẮT';
      bot.chat(`PvE ${state}! ${statusMsg()}`);
      log(`PvE → ${state}`);
    }

    // ── !patrol ─────────────────────────────────────────────
    else if (cmd === '!patrol') {
      if (patrolMode) {
        stopPatrol();
        bot.chat(`Đã dừng tuần tra. ${statusMsg()}`);
        log('Patrol → TẮT');
      } else {
        patrolMode = true;
        bot.chat(`Bắt đầu tuần tra bán kính ${PATROL_RADIUS} blocks! ${statusMsg()}`);
        log('Patrol → BẬT');
        doPatrolStep();
      }
    }

    // ── !attack <player> — tấn công người cụ thể ────────────
    else if (cmd === '!attack') {
      const targetName = parts[1];
      if (!targetName) { bot.chat('Dùng: !attack <tên người chơi>'); return; }

      const player = bot.players[targetName];
      if (!player || !player.entity) {
        bot.chat(`Không tìm thấy "${targetName}" gần đây.`);
        return;
      }

      try {
        bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, ATTACK_RANGE - 1), true);
        bot.chat(`Đang đuổi theo và tấn công ${targetName}!`);
        log(`Manual attack → ${targetName}`);
      } catch (e) {
        bot.chat(`Lỗi: ${e.message}`);
      }
    }

    // ── !pos ────────────────────────────────────────────────
    else if (cmd === '!pos') {
      bot.chat(`Vị trí của mình: ${fmtPos(bot.entity.position)}`);
    }

    // ── !status ─────────────────────────────────────────────
    else if (cmd === '!status') {
      const hp  = bot.health?.toFixed(1) ?? '?';
      const food = bot.food ?? '?';
      bot.chat(`HP:${hp} | Food:${food} | ${statusMsg()} | ${fmtPos(bot.entity.position)}`);
    }

    // ── !say <tin nhắn> ─────────────────────────────────────
    else if (cmd === '!say') {
      const text = parts.slice(1).join(' ');
      if (!text) { bot.chat('Dùng: !say <tin nhắn>'); return; }
      bot.chat(text);
    }

    // ── !follow <player> ────────────────────────────────────
    else if (cmd === '!follow') {
      const playerName = parts[1];
      if (!playerName) { bot.chat('Dùng: !follow <tên người chơi>'); return; }
      const player = bot.players[playerName];
      if (!player || !player.entity) {
        bot.chat(`Không tìm thấy "${playerName}".`);
        return;
      }
      bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, 2), true);
      bot.chat(`Đang theo ${playerName}!`);
    }

    // ── !stop ───────────────────────────────────────────────
    else if (cmd === '!stop') {
      stopAttackLoop();
      stopPatrol();
      pvpMode = false;
      pveMode = false;
      bot.chat('Đã tắt tất cả chế độ. Tạm biệt!');
      log('Stop command → thoát.');
      setTimeout(() => { bot.quit('stop'); process.exit(0); }, 500);
    }

    // ── !help ───────────────────────────────────────────────
    else if (cmd === '!help') {
      bot.chat('Lệnh: !pvp !pve !patrol !attack <tên> !follow <tên> !pos !status !say <msg> !stop');
    }
  });

  // ── Bị tấn công → đánh trả ────────────────────────────────
  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return;
    // Tìm kẻ gây sát thương (entity gần nhất)
    const attacker = findNearestAggressor();
    if (!attacker) return;
    const name = attacker.username || attacker.name || 'kẻ tấn công';
    log(`💢 Bị tấn công bởi ${name} → đánh trả!`);
    try {
      bot.pathfinder.setGoal(new goals.GoalFollow(attacker, ATTACK_RANGE - 1), true);
    } catch (_) {}
    bot.lookAt(attacker.position.offset(0, attacker.height ?? 1.6, 0));
    bot.attack(attacker);
  });

  // ── Kicked / lỗi / ngắt kết nối ──────────────────────────
  bot.on('kicked', (reason) => {
    log(`✗ Bị kick: ${reason}`);
    cleanupState();
  });

  bot.on('error', (err) => {
    log(`✗ Lỗi: ${err.message}`);
  });

  bot.on('end', (reason) => {
    log(`✗ Mất kết nối (${reason || 'không rõ'}).`);
    cleanupState();
    if (AUTO_RECONNECT) {
      log(`↻  Kết nối lại sau ${RECONNECT_DELAY_MS / 1000}s...`);
      setTimeout(createBot, RECONNECT_DELAY_MS);
    } else {
      process.exit(0);
    }
  });

  // ── Phòng thủ khỏi vực thẳm ──────────────────────────────
  // Dừng nếu sắp rơi xuống hố sâu
  bot.on('move', () => {
    if (!bot.entity) return;
    if (bot.entity.position.y < -60) {
      log('⚠  Y < -60, có thể đang rơi → dừng di chuyển');
      try { bot.pathfinder.stop(); } catch (_) {}
    }
  });
}

// ─── Tìm kẻ tấn công gần nhất ───────────────────────────────
function findNearestAggressor() {
  if (!bot || !bot.entity) return null;
  const myPos = bot.entity.position;
  let closest = null;
  let closestDist = Infinity;

  for (const entity of Object.values(bot.entities)) {
    if (!entity?.position) continue;
    if (entity.id === bot.entity.id) continue;
    const isEnemy =
      (entity.type === 'player' && entity.username !== bot.username) ||
      (entity.type === 'mob' && HOSTILE_MOBS.has(entity.name));
    if (!isEnemy) continue;
    const dist = myPos.distanceTo(entity.position);
    if (dist < closestDist && dist < ATTACK_RANGE * 2) {
      closestDist = dist;
      closest = entity;
    }
  }
  return closest;
}

// ─── Dọn dẹp state khi ngắt kết nối ─────────────────────────
function cleanupState() {
  stopAttackLoop();
  if (patrolTimeout) { clearTimeout(patrolTimeout); patrolTimeout = null; }
  pvpMode = pveMode = patrolMode = false;
}

// ─── Thoát nhẹ nhàng ─────────────────────────────────────────
function shutdown(signal) {
  log(`Nhận ${signal}. Đang ngắt kết nối...`);
  cleanupState();
  try { bot?.quit('shutdown'); } catch (_) {}
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Khởi động ───────────────────────────────────────────────
log('=== Minecraft Combat Bot đang khởi động ===');
log(`Config: ${BOT_CONFIG.host}:${BOT_CONFIG.port} | user=${BOT_CONFIG.username} | version=${BOT_CONFIG.version || 'auto'}`);
log('Lệnh chat: !pvp | !pve | !patrol | !attack <tên> | !follow <tên> | !pos | !status | !say | !stop | !help');
createBot();
