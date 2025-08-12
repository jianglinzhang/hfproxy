const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const WebSocket = require('ws');
const http = require('http');
const httpProxy = require('http-proxy');

const app = express();
const PORT = process.env.PORT || 3000;
const TARGET_HOST = process.env.TARGET_HOST || 'https://xxx-fastchat.hf.space';

// 创建HTTP代理实例
const proxy = httpProxy.createProxyServer({});

// 创建HTTP服务器
const server = http.createServer();

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

// HTTP请求处理
server.on('request', (req, res) => {
  // 设置CORS头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // 修改请求头
  req.headers.origin = TARGET_HOST;
  req.headers.referer = TARGET_HOST;
  
  // 代理HTTP请求
  proxy.web(req, res, {
    target: TARGET_HOST,
    changeOrigin: true,
    secure: true
  }, (error) => {
    console.error('HTTP代理错误:', error);
    res.writeHead(500);
    res.end('代理错误: ' + error.message);
  });
});

// WebSocket升级请求处理
server.on('upgrade', (req, socket, head) => {
  console.log('收到WebSocket升级请求:', req.url);
  
  // 构建目标WebSocket URL
  const targetWsUrl = TARGET_HOST.replace('https://', 'wss://') + req.url;
  console.log('目标WebSocket URL:', targetWsUrl);
  
  // 修改请求头
  req.headers.origin = TARGET_HOST;
  req.headers.host = new URL(TARGET_HOST).host;
  
  try {
    // 使用http-proxy代理WebSocket升级请求
    proxy.ws(req, socket, head, {
      target: TARGET_HOST.replace('https://', 'wss://'),
      ws: true,
      changeOrigin: true,
      secure: true
    }, (error) => {
      console.error('WebSocket代理错误:', error);
      socket.destroy();
    });
  } catch (error) {
    console.error('WebSocket升级处理错误:', error);
    socket.destroy();
  }
});

// 处理代理错误
proxy.on('error', (error, req, res) => {
  console.error('代理错误:', error);
  if (res && res.writeHead) {
    res.writeHead(500);
    res.end('代理错误');
  }
});

// 处理WebSocket代理错误
proxy.on('proxyReqWs', (proxyReq, req, socket) => {
  console.log('WebSocket代理请求:', req.url);
});

proxy.on('proxyRes', (proxyRes, req, res) => {
  // 添加CORS头到响应
  proxyRes.headers['Access-Control-Allow-Origin'] = '*';
  proxyRes.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
  proxyRes.headers['Access-Control-Allow-Headers'] = '*';
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

process.on('uncaughtException', (error) => {
  console.error('未捕获的异常:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的Promise拒绝:', reason);
});
