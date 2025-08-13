// index.js - 最终用于 Render 的 Router 版

// 1. 引入依赖
require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { URL } = require('url'); // 引入 URL 模块

// 2. 检查环境变量
const TARGET_HOST = process.env.TARGET_HOST;
if (!TARGET_HOST) {
  console.error('错误: 环境变量 TARGET_HOST 未设置。');
  process.exit(1);
}

// 3. 初始化 Express 应用
const app = express();
const PORT = process.env.PORT || 3000;

// 4. 设置代理中间件
const proxy = createProxyMiddleware({
  // target 在这里可以省略，因为 router 会提供最终目标
  
  // 核心：启用 WebSocket 和修改 Origin/Host 头
  ws: true,
  changeOrigin: true,

  // 终极武器：使用 router 手动构建完整的目标 URL
  router: (req) => {
    // 原始请求路径，例如 /_app/immutable/... 或 /ws/socket.io/...
    const originalPath = req.url;
    
    // 如果路径以 /ws 开头，则重写它
    const rewrittenPath = originalPath.startsWith('/ws') 
      ? originalPath.replace(/^\/ws/, '') 
      : originalPath;
      
    // 手动构建完整的目标 URL
    const newTarget = TARGET_HOST + rewrittenPath;
    
    console.log(`[Router] Routing "${originalPath}" to "${newTarget}"`);
    
    // 返回新的、完整的URL作为本次请求的目标
    return newTarget;
  },

  // 我们仍然需要在请求头中伪造 Origin
  onProxyReq: (proxyReq, req, res) => {
    proxyReq.setHeader('Origin', TARGET_HOST);
  },
  
  // 开启 debug 日志，便于观察
  logLevel: 'debug',
});

// 5. 应用中间件
app.use(proxy);

// 6. 启动服务器
const server = app.listen(PORT, () => {
  console.log(`代理服务器已在 Render 上启动，监听端口 ${PORT}`);
  console.log(`正在将所有请求代理到 -> ${TARGET_HOST}`);
});

// 优雅地处理服务器关闭
process.on('SIGTERM', () => {
    console.log('收到 SIGTERM，正在关闭服务器...');
    server.close(() => {
        console.log('服务器已关闭。');
    });
});
