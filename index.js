// index.js

import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';

// 从环境变量读取配置
const PORT = process.env.PORT || 8080;
const TARGET_HOST = process.env.TARGET_HOST;

if (!TARGET_HOST) {
  console.error("Error: TARGET_HOST environment variable not set.");
  process.exit(1);
}

const target = `https://${TARGET_HOST}`;
const app = express();

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

const proxyOptions = {
  target: target,
  changeOrigin: true, // 关键：这会自动设置正确的 Host 和 Origin 头
  ws: true,           // 关键：启用 WebSocket 代理
  logLevel: 'info',
  on: {
    // 我们可以用这个事件来修改请求头，模拟你原来的 transformHeaders
    proxyReq: (proxyReq, req, res) => {
        const isMobile = req.headers['sec-ch-ua-mobile'] === '?1';
        const userAgent = isMobile 
            ? "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
            : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
        
        proxyReq.setHeader('User-Agent', userAgent);
        // changeOrigin:true 已经处理了 Host 和 Origin, 无需手动设置
        // proxyReq.setHeader('Host', TARGET_HOST);
        // proxyReq.setHeader('Origin', target);
    },
    proxyRes: (proxyRes, req, res) => {
        // 添加 CORS 头
        proxyRes.headers['Access-Control-Allow-Origin'] = '*';
    }
  },
};

// 创建代理
const proxy = createProxyMiddleware(proxyOptions);

// 将所有请求都应用代理
app.use('/', proxy);

app.listen(PORT, () => {
  log(`Proxy server started on port ${PORT}`);
  log(`Proxying requests to ${target}`);
});
