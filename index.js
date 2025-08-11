// index.js (Definitive Solution v2 - With Health Check)

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

// *** 关键改动：添加健康检查端点 ***
// 这个端点必须在代理中间件之前定义，否则请求也会被代理走
app.get('/health', (req, res) => {
  // 返回一个简单的 200 OK 响应
  // 这告诉 Choreo "我还活着，一切正常！"
  res.status(200).send('OK');
});


const proxy = createProxyMiddleware({
  // 我们只代理除了 /health 之外的所有请求
  // filter 函数返回 true 的请求才会被代理
  filter: (pathname, req) => {
    return pathname !== '/health';
  },

  target: target,
  changeOrigin: true,
  ws: true,
  selfHandleResponse: true,

  on: {
    proxyReq: (proxyReq, req, res) => {
        const isMobile = req.headers['sec-ch-ua-mobile'] === '?1';
        const userAgent = isMobile 
            ? "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
            : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
        
        proxyReq.setHeader('User-Agent', userAgent);
        log(`Proxying ${req.method} ${req.path} to ${target}`);
    },
    proxyRes: (proxyRes, req, res) => {
        Object.keys(proxyRes.headers).forEach((key) => {
            res.setHeader(key, proxyRes.headers[key]);
        });
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.writeHead(proxyRes.statusCode);
        proxyRes.pipe(res);
    },
    error: (err, req, res) => {
      log(`Proxy Error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      res.end(`Proxy error: ${err.message}`);
    }
  }
});

// 将代理中间件应用到所有路径
app.use(proxy);

app.listen(PORT, () => {
  log(`Proxy server started on port ${PORT}`);
  log(`Proxying requests to ${target}`);
});
