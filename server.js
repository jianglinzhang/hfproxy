const HF_SPACE_URL = process.env.TARGET_HOST || 'https://xxx-fastchat.hf.space';

const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);

// HTTP代理
app.use('/', createProxyMiddleware({
  target: HF_SPACE_URL,
  changeOrigin: true,
  ws: false, // WebSocket单独处理
  headers: {
    'Origin': HF_SPACE_URL,
    'Referer': HF_SPACE_URL
  }
}));

// WebSocket代理
const wss = new WebSocket.Server({ server });
wss.on('connection', (clientWs, req) => {
  const targetUrl = `wss://xxx-fastchat.hf.space${req.url}`;
  const targetWs = new WebSocket(targetUrl, {
    headers: {
      'Origin': HF_SPACE_URL,
      'Referer': HF_SPACE_URL
    }
  });

  // 双向消息转发
  clientWs.on('message', data => targetWs.send(data));
  targetWs.on('message', data => clientWs.send(data));
  
  // 连接管理
  clientWs.on('close', () => targetWs.close());
  targetWs.on('close', () => clientWs.close());
  targetWs.on('error', err => clientWs.close(1011, 'Target error'));
});

server.listen(3000);
