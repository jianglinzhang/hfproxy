// index.js
// 1. 引入依赖
require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https'); // 用于静态资源代理
const { Server } = require("socket.io");
const { io: Client } = require("socket.io-client");
const { URL } = require('url');

// 2. 检查环境变量
const TARGET_HOST = process.env.TARGET_HOST;
if (!TARGET_HOST) {
  console.error('错误: 环境变量 TARGET_HOST 未设置 (应为你的 CF 或 Deno 代理地址)。');
  process.exit(1);
}

// 3. 初始化 Express 和 HTTP 服务器
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// 4. --- 协议桥核心：配置我们自己的 Socket.IO 服务器 ---
// 客户端浏览器将会连接到这个服务器
const io = new Server(server, {
  // 关键：匹配客户端尝试连接的路径，例如 /ws/socket.io/
  // 如果客户端直接连接根路径，可以简化为 path: "/socket.io/"
  path: "/ws/socket.io/", 
  
  // 允许所有来源连接，并使用最兼容的协议
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ["polling", "websocket"] // 优先使用 polling，因为它最稳定
});

// 5. 当有客户端连接到我们的服务器时，为其建立一个到目标的连接
io.on('connection', (clientSocket) => {
  // console.log(`[Bridge] Client connected: ${clientSocket.id}`);

  // 为这个客户端，创建一个到目标服务器（CF/Deno代理）的连接
  // 注意：因为 CF/Deno 代理可能也需要 /ws 前缀，所以我们在这里构建路径
  const targetUrl = new URL(TARGET_HOST);
  const targetPath = clientSocket.request.url.startsWith('/ws') ? '/ws/socket.io/' : '/socket.io/';
  
  // console.log(`[Bridge] Connecting client ${clientSocket.id} to target ${TARGET_HOST} with path ${targetPath}`);

  const targetSocket = Client(TARGET_HOST, {
    path: targetPath,
    transports: ["websocket"] // 强制使用 WebSocket 连接到我们的可信代理
  });

  // --- 消息转发 ---
  // 使用 onAny 捕获所有事件并从客户端转发到目标
  clientSocket.onAny((event, ...args) => {
    // console.log(`[Client -> Target] Event: ${event}`);
    targetSocket.emit(event, ...args);
  });

  // 使用 onAny 捕获所有事件并从目标转发到客户端
  targetSocket.onAny((event, ...args) => {
    // console.log(`[Target -> Client] Event: ${event}`);
    clientSocket.emit(event, ...args);
  });

  // --- 生命周期和错误管理 ---
  targetSocket.on('connect', () => {
    // console.log(`[Bridge] Successfully connected to target for client ${clientSocket.id}`);
  });
  
  targetSocket.on('connect_error', (err) => {
    console.error(`[Bridge] Target connection error for client ${clientSocket.id}:`, err.message);
    clientSocket.disconnect();
  });

  clientSocket.on('disconnect', (reason) => {
    // console.log(`[Bridge] Client ${clientSocket.id} disconnected. Reason: ${reason}. Closing target connection.`);
    targetSocket.disconnect();
  });

  targetSocket.on('disconnect', (reason) => {
    // console.log(`[Bridge] Target for client ${clientSocket.id} disconnected. Reason: ${reason}. Closing client connection.`);
    clientSocket.disconnect();
  });
});

// 6. --- 静态资源代理 ---
// 所有非 Socket.IO 的请求都由这个手动 HTTP 代理处理，以加载网页本身
app.use((client_req, client_res) => {
  // 避免代理我们自己的 Socket.IO 路径
  if (client_req.url.startsWith('/ws/socket.io')) {
    // 这个请求应该由 Socket.IO 服务器处理，所以我们什么都不做
    return;
  }
  
  // console.log(`[HTTP Proxy] Forwarding: ${client_req.method} ${client_req.originalUrl}`);

  const targetUrlForHttp = new URL(TARGET_HOST);
  const options = {
    hostname: targetUrlForHttp.hostname,
    port: 443,
    path: client_req.originalUrl,
    method: client_req.method,
    headers: { ...client_req.headers, host: targetUrlForHttp.hostname },
  };

  const proxy_req = https.request(options, (proxy_res) => {
    client_res.writeHead(proxy_res.statusCode, {
      ...proxy_res.headers,
      'access-control-allow-origin': '*',
    });
    proxy_res.pipe(client_res, { end: true });
  });

  client_req.pipe(proxy_req, { end: true });
  proxy_req.on('error', (err) => {
    console.error('[HTTP Proxy] Error:', err);
    if (!client_res.headersSent) client_res.status(502).send('Bad Gateway');
  });
});


// 7. 启动服务器
server.listen(PORT, () => {
  console.log(`协议桥服务器已在 Render 上启动，监听端口 ${PORT}`);
  console.log(`正在桥接到 -> ${TARGET_HOST}`);
});
