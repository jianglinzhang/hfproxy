// index.js (v2 - Optimized for SSE Streaming)

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
  changeOrigin: true, // 自动重写 Host 和 Origin 头，对于HF Space很重要
  ws: true,           // 保持 WebSocket 支持
  
  // --- 新增和优化的部分 ---
  
  // 1. 增加超时时间，防止AI思考时连接被代理切断
  timeout: 600000, // 10分钟超时
  proxyTimeout: 600000, // 同上

  on: {
    // 修改请求头，与你Deno版本逻辑保持一致
    proxyReq: (proxyReq, req, res) => {
        const isMobile = req.headers['sec-ch-ua-mobile'] === '?1';
        const userAgent = isMobile 
            ? "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
            : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
        
        proxyReq.setHeader('User-Agent', userAgent);
        log(`Proxying ${req.method} ${req.path} to ${target}`);
    },

    // 2. 关键：处理代理的响应头，确保流式传输的头信息被正确传回客户端
    proxyRes: (proxyRes, req, res) => {
      // 允许跨域
      res.setHeader('Access-Control-Allow-Origin', '*');
      
      // HF Space的流式响应会返回 'text/event-stream'
      // 我们必须确保这个头被原样传递给浏览器，否则浏览器不会把它当作SSE流处理
      const contentType = proxyRes.headers['content-type'];
      if (contentType && contentType.includes('text/event-stream')) {
        log('SSE stream detected. Ensuring no-cache headers.');
        // 对于SSE流，禁用任何形式的缓存
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        // 'X-Accel-Buffering' 是给Nginx等反向代理看的，告诉它不要缓冲响应体
        res.setHeader('X-Accel-Buffering', 'no');
      }
    },

    error: (err, req, res) => {
        log(`Proxy Error: ${err.message}`);
        if (!res.headersSent) {
            res.writeHead(500, {
                'Content-Type': 'application/json'
            });
        }
        res.end(JSON.stringify({ message: 'Proxy Error', error: err.message }));
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
