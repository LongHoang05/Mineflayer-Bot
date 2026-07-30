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

# Expose port cho Render HTTP Health Check
EXPOSE 10000
ENV PORT=10000

# Khởi động Bot
CMD ["pnpm", "--filter", "@workspace/minecraft-afk-bot", "start"]
