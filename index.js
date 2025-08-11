// index.js (Definitive Solution)

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

const proxy = createProxyMiddleware({
  target: target,
  changeOrigin: true, // 必须，自动处理 Host, Origin, Referer 头
  ws: true,           // 必须，启用 WebSocket 代理
  
  // 核心配置：我们自己处理响应流
  selfHandleResponse: true, 

  on: {
    // 请求转发前的回调，可以用来修改请求头
    proxyReq: (proxyReq, req, res) => {
        const isMobile = req.headers['sec-ch-ua-mobile'] === '?1';
        const userAgent = isMobile 
            ? "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
            : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
        
        proxyReq.setHeader('User-Agent', userAgent);
        log(`Proxying ${req.method} ${req.path} to ${target}`);
    },

    // 关键：当代理收到目标服务器的响应时
    proxyRes: (proxyRes, req, res) => {
        // proxyRes 是来自目标服务器的原始响应 (Node.js IncomingMessage stream)
        // res 是我们给客户端的响应 (Node.js ServerResponse)

        // 1. 将目标服务器的所有头信息原封不动地复制到我们的响应中
        Object.keys(proxyRes.headers).forEach((key) => {
            res.setHeader(key, proxyRes.headers[key]);
        });
        
        // 2. 添加/覆盖我们自己的头信息
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('X-Accel-Buffering', 'no'); // 再次强调不要缓冲
        res.setHeader('Cache-Control', 'no-cache, no-transform');

        // 3. 将目标服务器的状态码原封不动地设置到我们的响应中
        res.writeHead(proxyRes.statusCode);
        
        // 4. 将目标服务器的响应体（原始流）直接 pipe 到我们的响应中
        // 这就是解决所有问题的关键一步，它保证了SSE流的完整性
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

app.use(proxy);

app.listen(PORT, () => {
  log(`Proxy server started on port ${PORT}`);
  log(`Proxying requests to ${target}`);
});
