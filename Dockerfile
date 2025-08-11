# 使用官方的Node.js 22 Alpine镜像作为基础
FROM node:22-alpine

# 设置工作目录
WORKDIR /app

# 为了安全和最佳实践，我们创建一个非root用户和组
# Alpine系统下使用 addgroup 和 adduser
# -S: 创建一个系统用户/组（没有密码，不能登录）
# -u 10014: 指定用户ID
# -g 10014: 指定组ID
RUN addgroup -S appgroup -g 10014 && adduser -S appuser -u 10014 -G appgroup

# --- Docker缓存优化 ---
# 1. 仅复制package.json相关文件
# 这样只有在依赖更新时，下面的npm install才会重新执行
COPY package*.json ./

# 2. 安装生产环境依赖
# --omit=dev 会跳过devDependencies
RUN npm install --omit=dev

# 3. 复制应用程序的其余代码
# 这一步放在npm install之后，这样代码修改不会导致依赖重新安装
COPY . .

# --- 权限设置（关键修复） ---
# 以root身份，将/app目录的所有权和权限都设置好
# chown: 更改所有者为我们创建的appuser
# chmod: 赋予目录755权限（所有者可读写执行，其他人可读可执行），文件默认会是644
RUN chown -R appuser:appgroup /app && chmod -R 755 /app

# 暴露应用程序将要监听的端口
EXPOSE 8080

# 设置环境变量，可以在 docker run 时覆盖
ENV TARGET_HOST=xxx-xxx.hf.space
ENV PORT=8080

# 切换到我们创建的非root用户来运行应用
USER appuser

# 定义容器启动时要执行的命令
CMD ["node", "index.js"]
