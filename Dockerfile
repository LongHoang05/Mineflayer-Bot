FROM node:20-slim

# Cài đặt OpenJDK (Java 17) cho ViaProxy & pnpm
RUN apt-get update && \
    apt-get install -y openjdk-17-jre-headless && \
    npm install -g pnpm && \
    rm -rf /var/lib/apt-get/lists/*

WORKDIR /app

# Copy source code
COPY . .

# Cài đặt dependencies
RUN pnpm install

# Giới hạn RAM Node.js tối đa 128MB
ENV NODE_OPTIONS="--max-old-space-size=128"

# Biến môi trường mặc định cho Server Aternos
ENV MC_HOST=CLgamingTV.aternos.me
ENV MC_PORT=36025
ENV MC_USERNAME=CombatBot
ENV MC_VERSION=26.2
ENV BOT_VERSION=1.21.5
ENV MC_AUTH=offline

# Expose port cho Render HTTP Health Check
EXPOSE 10000
ENV PORT=10000

# Khởi động Bot
CMD ["pnpm", "--filter", "@workspace/minecraft-afk-bot", "start"]
