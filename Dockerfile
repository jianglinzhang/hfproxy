# 使用更稳定的Node.js版本
FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 创建非root用户
RUN addgroup -S appgroup -g 10014 && adduser -S appuser -u 10014 -G appgroup

# 复制package.json并安装依赖
COPY package*.json ./
RUN npm install --omit=dev

# 复制应用代码
COPY . .

# 设置权限
RUN chown -R appuser:appgroup /app && chmod -R 755 /app

# 添加调试命令 - 列出文件内容
RUN ls -la /app && whoami

# 暴露端口
EXPOSE 8080

# 设置环境变量
ENV TARGET_HOST=xxx-xxx.hf.space
ENV PORT=8080
ENV NODE_ENV=production

# 切换用户
USER appuser

# 启动应用，添加错误处理
CMD ["sh", "-c", "node index.js || echo 'Container failed to start'"]
