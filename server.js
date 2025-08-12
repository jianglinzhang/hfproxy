const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const WebSocket = require('ws');
const http = require('http');
const { URL } = require('url');

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 3000;

const HF_SPACE_URL = 'https://xxx-fastchat.hf.space';

// CORS 中间件
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// HTTP 代理中间件
app.use('/', createProxyMiddleware({
  target: HF_SPACE_URL,
  changeOrigin: true,
  ws: false, // 我们单独处理WebSocket
  onProxyReq: (proxyReq, req, res) => {
    proxyReq.setHeader('Origin', HF_SPACE_URL);
    proxyReq.setHeader('Referer', HF_SPACE_URL);
  },
  onError: (err, req, res) => {
    console.error('代理错误:', err);
    res.status(500).send('代理错误: ' + err.message);
  }
}));

// WebSocket 服务器
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (clientWs, request) => {
  console.log('客户端WebSocket连接建立');
  
  // 构建目标WebSocket URL
  const url = new URL(request.url, `http://${request.headers.host}`);
  const targetWsUrl = HF_SPACE_URL.replace('https://', 'wss://') + url.pathname + url.search;
  
  console.log('连接到目标:', targetWsUrl);
  
  // 连接到目标WebSocket服务器
  const targetWs = new WebSocket(targetWsUrl, {
    headers: {
      'Origin': HF_SPACE_URL,
      'User-Agent': request.headers['user-agent'] || 'Mozilla/5.0'
    }
  });
  
  // 目标服务器连接打开
  targetWs.on('open', () => {
    console.log('成功连接到目标WebSocket');
  });
  
  // 目标服务器消息处理
  targetWs.on('message', (data) => {
    try {
      let message = data.toString();
      
      // 处理 Socket.IO 的消息格式
      if (message.startsWith('data: ')) {
        message = message.substring(6); // 移除 "data: " 前缀
      }
      
      // 尝试解析并重新格式化消息
      try {
        const parsed = JSON.parse(message);
        message = JSON.stringify(parsed);
      } catch (parseError) {
        console.log('非JSON消息:', message);
      }
      
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(message);
      }
    } catch (error) {
      console.error('消息处理错误:', error);
    }
  });
  
  // 目标服务器连接关闭
  targetWs.on('close', (code, reason) => {
    console.log('目标WebSocket连接关闭:', code, reason.toString());
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(code, reason);
    }
  });
  
  // 目标服务器错误
  targetWs.on('error', (error) => {
    console.error('目标WebSocket错误:', error);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(1011, '目标连接错误');
    }
  });
  
  // 客户端消息处理
  clientWs.on('message', (data) => {
    try {
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(data);
      }
    } catch (error) {
      console.error('客户端消息错误:', error);
    }
  });
  
  // 客户端连接关闭
  clientWs.on('close', (code, reason) => {
    console.log('客户端WebSocket连接关闭:', code, reason);
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.close(code, reason);
    }
  });
  
  // 客户端连接错误
  clientWs.on('error', (error) => {
    console.error('客户端WebSocket错误:', error);
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.close(1011, '客户端错误');
    }
  });
});

server.listen(port, () => {
  console.log(`代理服务器运行在端口 ${port}`);
  console.log(`HTTP代理: http://localhost:${port}`);
  console.log(`WebSocket代理: ws://localhost:${port}/ws`);
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('收到SIGTERM信号，正在关闭服务器...');
  server.close(() => {
    console.log('服务器已关闭');
    process.exit(0);
  });
});
