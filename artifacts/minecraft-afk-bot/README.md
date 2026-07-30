# Minecraft Combat Bot

Bot Minecraft Java Edition tự động chiến đấu, xây dựng bằng [Mineflayer](https://github.com/PrismarineJS/mineflayer) + [Pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder).

---

## Tính năng

| Tính năng | Mô tả |
|---|---|
| **PvP** | Tự động phát hiện và tấn công người chơi gần nhất |
| **PvE** | Tự động tấn công mob thù địch (zombie, skeleton, creeper…) |
| **Tuần tra** | Đi loanh quanh bán kính cấu hình được xung quanh điểm spawn |
| **Đánh trả** | Tự động phản công khi bị tấn công |
| **Pathfinder** | Di chuyển thông minh, tránh vật cản, đuổi theo mục tiêu |
| **Auto-reconnect** | Tự kết nối lại khi bị ngắt |

---

## Cài đặt

### 1. Cài dependencies

```bash
pnpm --filter @workspace/minecraft-afk-bot install
```

### 2. Tạo file `.env`

```bash
cp artifacts/minecraft-afk-bot/.env.example artifacts/minecraft-afk-bot/.env
```

Chỉnh sửa `artifacts/minecraft-afk-bot/.env`:

| Biến | Mô tả | Mặc định |
|---|---|---|
| `MC_HOST` | IP hoặc hostname của server | `localhost` |
| `MC_PORT` | Cổng server | `25565` |
| `MC_USERNAME` | Tên bot | `CombatBot` |
| `MC_VERSION` | Phiên bản MC (vd: `1.20.4`). Để trống = tự nhận. | auto |
| `MC_AUTH` | `offline` hoặc `microsoft` | `offline` |
| `ATTACK_RANGE` | Tầm đánh (blocks) | `4` |
| `PATROL_RADIUS` | Bán kính tuần tra (blocks) | `20` |
| `ATTACK_SPEED` | Thời gian giữa mỗi cú đấm (ms) | `500` |
| `RECONNECT_DELAY` | Chờ bao lâu trước khi kết nối lại (ms) | `5000` |
| `AUTO_RECONNECT` | Tự kết nối lại | `true` |

### 3. Chạy bot

```bash
pnpm --filter @workspace/minecraft-afk-bot start
```

Hoặc nhấn nút **AFK Bot** trên Replit.

---

## Lệnh chat trong game

Gõ những lệnh này trong chat Minecraft để điều khiển bot:

| Lệnh | Tác dụng |
|---|---|
| `!pvp` | Bật/tắt chế độ tấn công người chơi |
| `!pve` | Bật/tắt chế độ tấn công mob |
| `!patrol` | Bật/tắt chế độ tuần tra loanh quanh |
| `!attack <tên>` | Đuổi theo và tấn công người chơi cụ thể |
| `!follow <tên>` | Đi theo người chơi (không đánh) |
| `!pos` | Hiển thị tọa độ hiện tại của bot |
| `!status` | Hiển thị HP, hunger và trạng thái chế độ |
| `!say <tin nhắn>` | Bot gửi tin nhắn trong chat |
| `!stop` | Tắt tất cả và ngắt kết nối |
| `!help` | Xem danh sách lệnh |

---

## Ví dụ sử dụng

```
# Bật PvP + tuần tra → bot tự chạy loanh quanh và tấn công người chơi
!pvp
!patrol

# Bật PvE → bot tiêu diệt mob xung quanh
!pve

# Bật cả hai → farm mob lẫn PvP
!pvp
!pve

# Tấn công người chơi cụ thể ngay lập tức
!attack Steve
```

---

## Ghi chú

- **Offline mode**: Server cracked/local → dùng `MC_AUTH=offline`
- **Online mode**: Server như Hypixel → dùng `MC_AUTH=microsoft` (cần tài khoản Microsoft thật)
- Bot **không đào block** khi di chuyển (`canDig = false`) để tránh phá map
- Bot tự **đánh trả** ngay cả khi PvP/PvE đang tắt

---

## Cấu trúc project

```
artifacts/minecraft-afk-bot/
├── src/
│   └── bot.js          # Logic chính
├── .env.example        # Mẫu cấu hình
├── .env                # Cấu hình của bạn (không commit)
├── package.json
└── README.md
```
