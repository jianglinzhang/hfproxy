# 使用一个非常小的基础镜像
FROM alpine:latest

# 定义 Xray 的版本和下载地址
ARG XRAY_VERSION=25.8.31
ENV XRAY_URL=https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}/Xray-linux-64.zip

# 安装必要的工具，下载并解压 Xray
RUN apk add --no-cache curl unzip \
    && curl -L -s -o /tmp/xray.zip ${XRAY_URL} \
    && unzip /tmp/xray.zip -d /usr/bin/ \
    && rm /tmp/xray.zip \
    && chmod +x /usr/bin/xray


# 1. 创建并设置工作目录为 /app
WORKDIR /app

# 2. 将配置文件复制到当前工作目录 (/app)
#    这里的 "." 代表当前工作目录，即 /app
# COPY config.json .

# 暴露内部端口（仅为说明，Choreo 会自动处理）
EXPOSE 8181

USER 10014

# 3. 容器启动时，使用 /app 目录下的配置文件
CMD ["/usr/bin/xray", "run", "-config", "/app/config.json"]
