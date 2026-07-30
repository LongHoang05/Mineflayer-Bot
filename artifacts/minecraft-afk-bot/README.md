# Minecraft AFK Bot

A configurable AFK bot for Minecraft Java Edition built with [Mineflayer](https://github.com/PrismarineJS/mineflayer).

---

## Features

- Connects to any Minecraft Java Edition server
- Holds its position — no random movement
- Auto-reconnects when disconnected
- Responds to in-game chat commands
- Fully configurable via `.env`

---

## Setup

### 1. Install dependencies

```bash
pnpm --filter @workspace/minecraft-afk-bot install
```

Or from the project root:

```bash
pnpm install
```

### 2. Create your `.env` file

Copy the example configuration:

```bash
cp artifacts/minecraft-afk-bot/.env.example artifacts/minecraft-afk-bot/.env
```

Then edit `artifacts/minecraft-afk-bot/.env` with your server details:

| Variable          | Description                                      | Default     |
|-------------------|--------------------------------------------------|-------------|
| `MC_HOST`         | Server IP or hostname                            | `localhost` |
| `MC_PORT`         | Server port                                      | `25565`     |
| `MC_USERNAME`     | Bot's Minecraft username                         | `AFKBot`    |
| `MC_VERSION`      | Minecraft version (e.g. `1.20.4`). Leave blank to auto-detect. | auto |
| `MC_AUTH`         | `offline` for cracked servers, `microsoft` for online-mode | `offline` |
| `RECONNECT_DELAY` | Milliseconds to wait before reconnecting         | `5000`      |
| `AUTO_RECONNECT`  | Set to `false` to disable auto-reconnect         | `true`      |

### 3. Run the bot

```bash
pnpm --filter @workspace/minecraft-afk-bot start
```

On Replit you can also use the **AFK Bot** workflow button to start it.

---

## In-game Commands

Any player can type these in the Minecraft chat:

| Command              | Description                                    |
|----------------------|------------------------------------------------|
| `!pos`               | Shows the bot's current coordinates            |
| `!say <message>`     | Makes the bot say something in chat            |
| `!follow <player>`   | Bot walks toward and follows a player          |
| `!stop`              | Safely disconnects the bot                     |

---

## Notes

### Offline vs Online mode
- Most private/local servers run in **offline mode** → use `MC_AUTH=offline`
- Servers like Hypixel run in **online mode** → use `MC_AUTH=microsoft` and provide a valid Microsoft account username. Mineflayer will open a browser URL for authentication on first run.

### Version matching
- The bot version must match the server. Set `MC_VERSION` explicitly if auto-detect fails (e.g. `MC_VERSION=1.20.4`).

### Auto-reconnect
- The bot reconnects automatically after kicks or crashes. Set `AUTO_RECONNECT=false` to disable this.

---

## Project Structure

```
artifacts/minecraft-afk-bot/
├── src/
│   └── bot.js          # Main bot logic
├── .env.example        # Configuration template
├── .env                # Your local config (git-ignored)
├── package.json
└── README.md
```
