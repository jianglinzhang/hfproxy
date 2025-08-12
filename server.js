const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { WebSocketServer } = require('ws');
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

// 手动处理WebSocket升级请求
server.on('upgrade', (request, socket, head) => {
  console.log('收到WebSocket升级请求:', request.url);
  
  // 解析请求URL
  const parsedUrl = url.parse(request.url, true);
  const targetWsUrl = TARGET_HOST.replace('https://', 'wss://') + parsedUrl.pathname + (parsedUrl.search || '');
  
  console.log('连接到目标WebSocket:', targetWsUrl);
  
  // 创建到目标服务器的WebSocket连接
  const targetWs = new WebSocket(targetWsUrl, {
    headers: {
      'Origin': TARGET_HOST,
      'User-Agent': request.headers['user-agent'] || 'Mozilla/5.0',
      'Accept-Encoding': request.headers['accept-encoding'] || '',
      'Accept-Language': request.headers['accept-language'] || 'en-US,en;q=0.9'
    }
  });
  
  // 等待目标连接建立
  targetWs.on('open', () => {
    console.log('目标WebSocket连接已建立，开始升级客户端连接');
    
    // 创建WebSocket服务器实例来处理这个连接
    const wss = new WebSocketServer({ noServer: true });
    
    // 升级客户端连接
    wss.handleUpgrade(request, socket, head, (ws) => {
      console.log('客户端WebSocket连接已建立');
      
      // 建立双向数据转发
      setupBidirectionalForwarding(ws, targetWs);
    });
  });
  
  // 如果目标连接失败，关闭客户端连接
  targetWs.on('error', (error) => {
    console.error('目标WebSocket连接错误:', error);
    socket.destroy();
  });
  
  targetWs.on('close', (code, reason) => {
    console.log('目标WebSocket连接关闭:', code, reason.toString());
    if (!socket.destroyed) {
      socket.destroy();
    }
  });
  
  // 处理客户端连接错误
  socket.on('error', (error) => {
    console.error('客户端socket错误:', error);
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.close();
    }
  });
});

// 设置双向数据转发
function setupBidirectionalForwarding(clientWs, targetWs) {
  // 处理目标服务器消息
  targetWs.on('message', (data) => {
    try {
      let message = data.toString();
      
      // 处理 Socket.IO 的消息格式
      if (message.startsWith('data: ')) {
        message = message.substring(6); // 移除 "data: " 前缀
      }
      
      // 尝试解析JSON（但不强制）
      try {
        const parsed = JSON.parse(message);
        message = JSON.stringify(parsed);
      } catch (parseError) {
        // 如果不是JSON，保持原样
        console.log('非JSON消息:', message.substring(0, 100));
      }
      
      // 转发给客户端
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(message);
      }
    } catch (error) {
      console.error('消息处理错误:', error);
    }
  });
  
  // 处理目标服务器连接关闭
  targetWs.on('close', (code, reason) => {
    console.log('目标WebSocket连接关闭:', code, reason.toString());
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(code, reason);
    }
  });
  
  // 处理目标服务器错误
  targetWs.on('error', (error) => {
    console.error('目标WebSocket错误:', error);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(1011, '目标连接错误');
    }
  });
  
  // 处理客户端消息
  clientWs.on('message', (data) => {
    try {
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(data);
      }
    } catch (error) {
      console.error('客户端消息错误:', error);
    }
  });
  
  // 处理客户端连接关闭
  clientWs.on('close', (code, reason) => {
    console.log('客户端WebSocket连接关闭:', code, reason);
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
}

// 启动服务器
server.listen(PORT, () => {
  console.log(`代理服务器运行在端口 ${PORT}`);
  console.log(`目标服务器: ${TARGET_HOST}`);
  console.log(`WebSocket代理已启用`);
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('收到SIGTERM信号，正在关闭服务器...');
  server.close(() => {
    console.log('服务器已关闭');
    process.exit(0);
  });
});

// 错误处理
process.on('uncaughtException', (error) => {
  console.error('未捕获的异常:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的Promise拒绝:', reason);
});
