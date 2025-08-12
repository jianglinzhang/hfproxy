const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const TARGET_HOST = process.env.TARGET_HOST || 'https://xxx-fastchat.hf.space';

// 创建HTTP服务器
const server = http.createServer(app);

// 设置CORS中间件
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Socket.IO轮询请求的特殊处理
app.use('/socket.io/', createProxyMiddleware({
  target: TARGET_HOST,
  changeOrigin: true,
  ws: false,
  onProxyReq: (proxyReq, req, res) => {
    proxyReq.setHeader('Origin', TARGET_HOST);
    proxyReq.setHeader('Referer', TARGET_HOST);
  }
}));

// 创建代理中间件处理其他请求
const proxyMiddleware = createProxyMiddleware({
  target: TARGET_HOST,
  changeOrigin: true,
  ws: false,
  onProxyReq: (proxyReq, req, res) => {
    proxyReq.setHeader('Origin', TARGET_HOST);
    proxyReq.setHeader('Referer', TARGET_HOST);
  },
  onError: (err, req, res) => {
    console.error('代理错误:', err);
    res.status(500).send('代理错误: ' + err.message);
  }
});

// 使用代理中间件处理其他HTTP请求
app.use('/', proxyMiddleware);

// 创建WebSocket服务器
const wss = new WebSocket.WebSocketServer({ 
  server,
  path: '/socket.io/' // 只处理Socket.IO路径
});

wss.on('connection', (ws, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  console.log('WebSocket连接:', url.pathname + url.search);
  
  // 检查是否是Socket.IO WebSocket请求
  if (!url.pathname.startsWith('/socket.io/')) {
    ws.close(1002, '无效的路径');
    return;
  }
  
  // 构建目标WebSocket URL
  const targetWsUrl = TARGET_HOST.replace('https://', 'wss://') + url.pathname + url.search;
  console.log('连接目标:', targetWsUrl);
  
  // 创建到目标服务器的连接
  const targetWs = new WebSocket(targetWsUrl, [], {
    headers: {
      'Origin': TARGET_HOST,
      'User-Agent': request.headers['user-agent'] || 'Mozilla/5.0 (compatible)',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-WebSocket-Protocol': request.headers['sec-websocket-protocol'] || undefined
    },
    timeout: 30000
  });
  
  let isConnected = false;

  // 在targetWs创建后添加
  console.log('WebSocket请求头:', {
    'Origin': TARGET_HOST,
    'User-Agent': request.headers['user-agent'],
    'Sec-WebSocket-Protocol': request.headers['sec-websocket-protocol']
  });
  
  // 目标服务器连接成功
  targetWs.on('open', () => {
    console.log('目标WebSocket连接成功');
    isConnected = true;
  });
  
  // 从目标服务器接收消息
  targetWs.on('message', (data) => {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    } catch (error) {
      console.error('转发消息到客户端错误:', error);
    }
  });
  
  // 目标服务器连接关闭
  targetWs.on('close', (code, reason) => {
    console.log('目标WebSocket关闭:', code, reason.toString());
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(code, reason);
    }
  });
  
  // 目标服务器连接错误
  targetWs.on('error', (error) => {
    console.error('目标WebSocket错误:', error);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1011, '目标服务器错误');
    }
  });
  
  // 从客户端接收消息
  ws.on('message', (data) => {
    try {
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(data);
      }
    } catch (error) {
      console.error('转发消息到目标服务器错误:', error);
    }
  });
  
  // 客户端连接关闭
  ws.on('close', (code, reason) => {
    console.log('客户端WebSocket关闭:', code, reason);
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.close(code, reason);
    }
  });
  
  // 客户端连接错误
  ws.on('error', (error) => {
    console.error('客户端WebSocket错误:', error);
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.close(1011, '客户端错误');
    }
  });
  
  // 连接超时处理
  setTimeout(() => {
    if (!isConnected) {
      console.log('WebSocket连接超时');
      ws.close(1011, '连接超时');
      targetWs.terminate();
    }
  }, 10000);
});

// 启动服务器
server.listen(PORT, () => {
  console.log(`Socket.IO代理服务器运行在端口 ${PORT}`);
  console.log(`目标服务器: ${TARGET_HOST}`);
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('收到SIGTERM信号，正在关闭服务器...');
  wss.close(() => {
    server.close(() => {
      console.log('服务器已关闭');
      process.exit(0);
    });
  });
});

process.on('uncaughtException', (error) => {
  console.error('未捕获的异常:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的Promise拒绝:', reason);
});
