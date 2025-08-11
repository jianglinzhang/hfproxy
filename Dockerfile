# 使用更稳定的Node.js版本
FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 创建非root用户，确保ID在10000-20000范围内
RUN addgroup -S appgroup -g 10014 && \
    adduser -S appuser -u 10014 -G appgroup

# 复制package.json并安装依赖
COPY package*.json ./
RUN npm install --omit=dev

# 复制应用代码
COPY . .

# 设置权限
RUN chown -R appuser:appgroup /app && \
    chmod -R 755 /app

# 暴露端口
EXPOSE 8080

# 设置环境变量
ENV TARGET_HOST=xxx-xxx.hf.space
ENV PORT=8080
ENV NODE_ENV=production

# 明确切换到非root用户，ID在10000-20000范围内
USER 10014

# 启动应用
CMD ["node", "index.js"]
