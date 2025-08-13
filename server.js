// index.js - 最终用于 Render 的手动代理

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

  // 构造发往目标服务器的请求选项
  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: client_req.originalUrl, // 直接使用原始路径
    method: client_req.method,
    headers: {
      ...client_req.headers,
      'host': targetUrl.hostname, // 必须修改 host
      'origin': TARGET_HOST,      // 必须修改 origin
      'referer': TARGET_HOST,     // 最好也修改 referer
    },
  };

  // 创建到目标服务器的请求
  const proxy_req = https.request(options, (proxy_res) => {
    console.log(`[HTTP Proxy] Response from target for ${client_req.originalUrl}: ${proxy_res.statusCode}`);
    
    // 将目标服务器的响应头写回客户端，并添加CORS头
    client_res.writeHead(proxy_res.statusCode, {
      ...proxy_res.headers,
      'access-control-allow-origin': '*',
    });

    // 将目标服务器的响应体通过管道流回客户端
    proxy_res.pipe(client_res, { end: true });
  });

  // 将客户端的请求体通过管道流到目标服务器
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
  
  // 如果路径以 /ws 开头，则重写它
  const targetPath = req.url.startsWith('/ws') 
    ? req.url.replace(/^\/ws/, '') 
    : req.url;

  const targetWsUrl = `wss://${targetUrl.hostname}${targetPath}`;
  
  console.log(`[WS Proxy] Connecting to target: ${targetWsUrl}`);

  // 创建到目标 WebSocket 服务器的连接
  const target_ws = new WebSocket(targetWsUrl, {
    origin: TARGET_HOST, // 设置正确的 Origin
    // 传递原始请求的头，但覆盖 host
    headers: { ...req.headers, host: targetUrl.hostname }
  });

  // 当与目标的连接建立后，再完成与客户端的握手
  target_ws.on('open', () => {
    console.log('[WS Proxy] Connection to target established.');
    // 这是一个技巧：我们创建一个临时的 WebSocket.Server 来完成握手
    const wss = new WebSocket.Server({ noServer: true });
    wss.handleUpgrade(req, client_socket, head, (client_ws) => {
      console.log('[WS Proxy] Connection with client established.');
      // 双向转发消息
      target_ws.on('message', (message) => client_ws.send(message));
      client_ws.on('message', (message) => target_ws.send(message));
      // 双向转发关闭事件
      target_ws.on('close', (code, reason) => client_ws.close(code, reason.toString()));
      client_ws.on('close', (code, reason) => target_ws.close(code, reason.toString()));
    });
  });

  // 处理与目标连接时的错误
  target_ws.on('error', (err) => {
    console.error('[WS Proxy] Target connection error:', err);
    client_socket.destroy(); // 销毁客户端连接
  });
});
