// index.js

// 1. 引入依赖
require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const { URL } = require('url');

// 2. 检查环境变量
const TARGET_HOST = process.env.TARGET_HOST;
if (!TARGET_HOST) {
  console.error('错误: 环境变量 TARGET_HOST 未设置。');
  process.exit(1);
}
const targetUrl = new URL(TARGET_HOST);

// 3. 初始化 Express 应用和 HTTP 服务器
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// 4. 手动处理所有 HTTP/HTTPS 请求
app.use((client_req, client_res) => {
  console.log(`[HTTP Proxy] Intercepting: ${client_req.method} ${client_req.originalUrl}`);

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: client_req.originalUrl,
    method: client_req.method,
    headers: {
      ...client_req.headers,
      'host': targetUrl.hostname,
      'origin': TARGET_HOST,
      'referer': TARGET_HOST,
    },
  };

  const proxy_req = https.request(options, (proxy_res) => {
    console.log(`[HTTP Proxy] Response from target for ${client_req.originalUrl}: ${proxy_res.statusCode}`);
    client_res.writeHead(proxy_res.statusCode, {
      ...proxy_res.headers,
      'access-control-allow-origin': '*',
    });
    proxy_res.pipe(client_res, { end: true });
  });

  client_req.pipe(proxy_req, { end: true });
  proxy_req.on('error', (err) => {
    console.error(`[HTTP Proxy] Request Error for ${client_req.originalUrl}:`, err);
    if (!client_res.headersSent) {
      client_res.status(502).send('Bad Gateway');
    }
  });
});

// 5. 启动服务器
server.listen(PORT, () => {
  console.log(`手动代理服务器已在 Render 上启动，监听端口 ${PORT}`);
  console.log(`正在代理到 -> ${TARGET_HOST}`);
});

// 6. 手动处理 WebSocket 升级请求
server.on('upgrade', (req, client_socket, head) => {
  console.log(`[WS Proxy] Intercepting upgrade request for: ${req.url}`);
  
  const targetPath = req.url.startsWith('/ws') ? req.url.replace(/^\/ws/, '') : req.url;
  const targetWsUrl = `wss://${targetUrl.hostname}${targetPath}`;
  
  console.log(`[WS Proxy] Connecting to target: ${targetWsUrl}`);

  // --- 关键修复：完美伪装 ---
  // 创建一个几乎与浏览器请求一模一样的头
  const forward_headers = { ...req.headers };
  // 覆盖 host 和 origin，这是代理的核心
  forward_headers.host = targetUrl.hostname;
  forward_headers.origin = TARGET_HOST;
  // 删除一些 Node.js 可能会自动添加或导致冲突的头
  delete forward_headers['connection']; 
  delete forward_headers['upgrade'];

  // 创建到目标 WebSocket 服务器的连接
  const target_ws = new WebSocket(targetWsUrl, {
    // 使用我们精心构造的头
    headers: forward_headers,
  });

  target_ws.on('open', () => {
    console.log('[WS Proxy] Connection to target established.');
    const wss = new WebSocket.Server({ noServer: true });
    wss.handleUpgrade(req, client_socket, head, (client_ws) => {
      console.log('[WS Proxy] Connection with client established.');
      target_ws.on('message', (message) => client_ws.send(message));
      client_ws.on('message', (message) => target_ws.send(message));
      target_ws.on('close', (code, reason) => client_ws.close(code, reason.toString()));
      client_ws.on('close', (code, reason) => target_ws.close(code, reason.toString()));
    });
  });

  target_ws.on('unexpected-response', (request, response) => {
    // 增加这个事件监听器，可以更详细地看到服务器返回了什么
    console.error(`[WS Proxy] Target returned an unexpected response: ${response.statusCode}`);
    console.error('[WS Proxy] Response Headers:', response.headers);
    client_socket.destroy();
  });

  target_ws.on('error', (err) => {
    console.error('[WS Proxy] Target connection error:', err.message);
    client_socket.destroy();
  });
});
