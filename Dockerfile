FROM node:22-alpine

WORKDIR /app

# 复制package.json和package-lock.json（如果存在）
COPY package*.json ./

# 安装依赖
RUN npm install

# 复制应用程序代码
COPY . .

# 暴露端口
EXPOSE 8080

# 设置环境变量（可以在docker run时覆盖）
ENV TARGET_HOST=xxx-xxx.hf.space
ENV PORT=8080
USER 10014
# 启动应用程序
CMD ["node", "index.js"]
