const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const WebSocket = require('ws');
const http = require('http');
const url = require('url');

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

// 创建代理中间件
const proxyMiddleware = createProxyMiddleware({
  target: TARGET_HOST,
  changeOrigin: true,
  ws: false, // 我们单独处理WebSocket
  onProxyReq: (proxyReq, req, res) => {
    proxyReq.setHeader('Origin', TARGET_HOST);
    proxyReq.setHeader('Referer', TARGET_HOST);
  },
  onError: (err, req, res) => {
    console.error('代理错误:', err);
    res.status(500).send('代理错误: ' + err.message);
  }
});

// 使用代理中间件处理所有HTTP请求
app.use('/', proxyMiddleware);

// 处理WebSocket升级请求
server.on('upgrade', (request, socket, head) => {
  console.log('收到WebSocket升级请求:', request.url);
  
  // 解析请求URL
  const parsedUrl = url.parse(request.url, true);
  const targetWsUrl = TARGET_HOST.replace('https://', 'wss://') + request.url;
  
  console.log('连接到目标WebSocket:', targetWsUrl);
  
  // 创建到目标服务器的WebSocket连接
  const targetWs = new WebSocket(targetWsUrl, {
    headers: {
      'Origin': TARGET_HOST,
      'User-Agent': request.headers['user-agent'] || 'Mozilla/5.0',
      'Accept-Encoding': request.headers['accept-encoding'] || '',
      'Accept-Language': request.headers['accept-language'] || '',
      'Cache-Control': request.headers['cache-control'] || '',
      'Pragma': request.headers['pragma'] || '',
      'Sec-WebSocket-Extensions': request.headers['sec-websocket-extensions'] || '',
      'Sec-WebSocket-Key': request.headers['sec-websocket-key'] || '',
      'Sec-WebSocket-Version': request.headers['sec-websocket-version'] || '13'
    }
  });

  let clientWs = null;

  // 目标服务器连接打开
  targetWs.on('open', () => {
    console.log('已连接到目标WebSocket服务器');
    
    // 创建客户端WebSocket连接
    const wsServer = new WebSocket.WebSocketServer({ noServer: true });
    
    wsServer.handleUpgrade(request, socket, head, (ws) => {
      clientWs = ws;
      console.log('客户端WebSocket连接已建立');
      
      // 处理客户端消息
      clientWs.on('message', (data) => {
        try {
          if (targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(data);
          }
        } catch (error) {
          console.error('转发客户端消息错误:', error);
        }
      });
      
      // 处理客户端连接关闭
      clientWs.on('close', (code, reason) => {
        console.log('客户端WebSocket连接关闭:', code, reason.toString());
        if (targetWs.readyState === WebSocket.OPEN) {
          targetWs.close(code, reason);
        }
      });
      
      // 处理客户端错误
      clientWs.on('error', (error) => {
        console.error('客户端WebSocket错误:', error);
        if (targetWs.readyState === WebSocket.OPEN) {
          targetWs.close(1011, '客户端连接错误');
        }
      });
    });
  });
  
  // 处理目标服务器消息
  targetWs.on('message', (data) => {
    try {
      let message = data.toString();
      
      // 处理 Socket.IO 的消息格式
      if (message.startsWith('data: ')) {
        message = message.substring(6); // 移除 "data: " 前缀
      }
      
      // 尝试解析JSON
      try {
        const parsed = JSON.parse(message);
        message = JSON.stringify(parsed);
      } catch (parseError) {
        // 如果不是JSON，保持原样
        console.log('非JSON消息:', message);
      }
      
      // 转发给客户端
      if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(message);
      }
    } catch (error) {
      console.error('消息处理错误:', error);
    }
  });
  
  // 处理目标服务器连接关闭
  targetWs.on('close', (code, reason) => {
    console.log('目标WebSocket连接关闭:', code, reason.toString());
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(code, reason);
    }
  });
  
  // 处理目标服务器错误
  targetWs.on('error', (error) => {
    console.error('目标WebSocket错误:', error);
    socket.destroy();
  });
});

// 启动服务器
server.listen(PORT, () => {
  console.log(`代理服务器运行在端口 ${PORT}`);
  console.log(`目标服务器: ${TARGET_HOST}`);
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('收到SIGTERM信号，正在关闭服务器...');
  server.close(() => {
    console.log('服务器已关闭');
    process.exit(0);
  });
});
