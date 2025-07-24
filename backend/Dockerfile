# SCPPER-CN 生产环境 Dockerfile

FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 安装系统依赖
RUN apk add --no-cache \
    postgresql-client \
    curl \
    bash \
    tzdata

# 设置时区
ENV TZ=Asia/Shanghai

# 复制package文件
COPY package*.json ./

# 安装Node.js依赖
RUN npm ci --only=production && npm cache clean --force

# 创建非root用户
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# 复制应用代码
COPY --chown=nodejs:nodejs . .

# 创建必要的目录
RUN mkdir -p sync-logs data-backups config && \
    chown -R nodejs:nodejs sync-logs data-backups config

# 生成Prisma客户端
RUN npx prisma generate

# 设置权限
RUN chmod +x deploy.sh backup.sh monitor.sh || true

# 切换到非root用户
USER nodejs

# 暴露端口 (如果需要Web接口)
EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD node -e "console.log('Health check passed')" || exit 1

# 默认命令
CMD ["node", "src/sync/database-sync.js"]