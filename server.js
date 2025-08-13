// 1. 引入依赖
require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require("socket.io");
const { io: Client } = require("socket.io-client");

// 2. 检查环境变量
const TARGET_HOST = process.env.TARGET_HOST;
if (!TARGET_HOST) {
  console.error('错误: 环境变量 TARGET_HOST 未设置。');
  process.exit(1);
}

// 3. 初始化 Express 和 HTTP 服务器
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// 4. --- 协议桥核心：配置我们自己的 Socket.IO 服务器 ---
// 客户端会连接到这个服务器
const io = new Server(server, {
  // 关键：匹配客户端尝试连接的路径
  path: "/ws/socket.io/", 
  // 允许所有来源连接，并只使用最兼容的协议
  cors: {
    origin: "*",
  },
  transports: ["polling", "websocket"] // 允许 polling 和 websocket
});

// 5. 当有客户端连接到我们的服务器时
io.on('connection', (clientSocket) => {
  console.log(`[Bridge] Client connected: ${clientSocket.id}`);

  // 为这个客户端，创建一个到目标服务器的连接
  const targetSocket = Client(TARGET_HOST, {
    // 目标服务器的路径通常是 /socket.io/
    path: "/socket.io/",
    transports: ["websocket"] // 强制使用 WebSocket 连接到目标
  });

  console.log(`[Bridge] Connecting client ${clientSocket.id} to target ${TARGET_HOST}`);

  // --- 消息转发 ---
  // 使用 onAny 捕获所有事件并转发
  clientSocket.onAny((event, ...args) => {
    console.log(`[Client -> Target] Event: ${event}`);
    targetSocket.emit(event, ...args);
  });

  targetSocket.onAny((event, ...args) => {
    console.log(`[Target -> Client] Event: ${event}`);
    clientSocket.emit(event, ...args);
  });

  // --- 生命周期管理 ---
  targetSocket.on('connect_error', (err) => {
    console.error(`[Bridge] Target connection error for client ${clientSocket.id}:`, err.message);
    clientSocket.disconnect();
  });

  clientSocket.on('disconnect', (reason) => {
    console.log(`[Bridge] Client ${clientSocket.id} disconnected. Reason: ${reason}. Closing target connection.`);
    targetSocket.disconnect();
  });

  targetSocket.on('disconnect', (reason) => {
    console.log(`[Bridge] Target disconnected for client ${clientSocket.id}. Reason: ${reason}. Closing client connection.`);
    clientSocket.disconnect();
  });
});

// 6. --- 静态资源代理 ---
// 所有非 Socket.IO 的请求都由这个手动 HTTP 代理处理
app.use((client_req, client_res) => {
  // 避免代理我们自己的 Socket.IO 路径
  if (client_req.url.startsWith('/ws/socket.io')) {
    return;
  }
  
  console.log(`[HTTP Proxy] Forwarding: ${client_req.method} ${client_req.originalUrl}`);

  const options = {
    hostname: new URL(TARGET_HOST).hostname,
    port: 443,
    path: client_req.originalUrl,
    method: client_req.method,
    headers: { ...client_req.headers, host: new URL(TARGET_HOST).hostname },
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
  console.log(`协议桥服务器已启动，监听端口 ${PORT}`);
  console.log(`正在桥接到 -> ${TARGET_HOST}`);
});


// const express = require('express');
// const { createProxyMiddleware } = require('http-proxy-middleware');
// const WebSocket = require('ws');
// const http = require('http');
// const https = require('https');
// const url = require('url');

// const app = express();
// const PORT = process.env.PORT || 3000;
// const TARGET_HOST = process.env.TARGET_HOST;

// if (!TARGET_HOST) {
//   console.error('❌ 错误: TARGET_HOST 环境变量未设置');
//   process.exit(1);
// }

// console.log(`�� 目标服务器: ${TARGET_HOST}`);

// // 创建HTTP服务器
// const server = http.createServer(app);

// // 解析目标主机URL
// const targetUrl = new URL(TARGET_HOST);

// // 中间件配置
// app.use(express.json({ limit: '10mb' }));
// app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// // CORS配置
// app.use((req, res, next) => {
//   res.header('Access-Control-Allow-Origin', '*');
//   res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
//   res.header('Access-Control-Allow-Headers', '*');
//   res.header('Access-Control-Allow-Credentials', 'true');
  
//   if (req.method === 'OPTIONS') {
//     res.sendStatus(200);
//   } else {
//     next();
//   }
// });

// // 健康检查端点
// app.get('/health', (req, res) => {
//   res.json({
//     status: 'ok',
//     timestamp: new Date().toISOString(),
//     target: TARGET_HOST
//   });
// });

// // Socket.IO轮询请求的特殊处理
// app.use('/socket.io/*', createProxyMiddleware({
//   target: TARGET_HOST,
//   changeOrigin: true,
//   ws: false,
//   timeout: 30000,
  
//   onProxyReq: (proxyReq, req, res) => {
//     proxyReq.setHeader('Host', targetUrl.host);
//     proxyReq.setHeader('Origin', TARGET_HOST);
//     proxyReq.setHeader('Referer', TARGET_HOST);
//     console.log(`�� Socket.IO轮询: ${req.method} ${req.path}`);
//   },
  
//   onProxyRes: (proxyRes, req, res) => {
//     proxyRes.headers['access-control-allow-origin'] = '*';
//     proxyRes.headers['access-control-allow-credentials'] = 'true';
//     console.log(`✅ Socket.IO响应: ${proxyRes.statusCode}`);
//   },
  
//   onError: (err, req, res) => {
//     console.error(`❌ Socket.IO代理错误:`, err.message);
//     if (!res.headersSent) {
//       res.status(502).json({ error: 'Socket.IO proxy error' });
//     }
//   }
// }));

// // 通用HTTP代理
// const httpProxy = createProxyMiddleware({
//   target: TARGET_HOST,
//   changeOrigin: true,
//   ws: false,
//   timeout: 30000,
  
//   onProxyReq: (proxyReq, req, res) => {
//     proxyReq.setHeader('Host', targetUrl.host);
//     proxyReq.setHeader('Origin', TARGET_HOST);
//     proxyReq.setHeader('Referer', TARGET_HOST);
//   },
  
//   onProxyRes: (proxyRes, req, res) => {
//     proxyRes.headers['access-control-allow-origin'] = '*';
//     proxyRes.headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS, PATCH';
//     proxyRes.headers['access-control-allow-headers'] = '*';
//   },
  
//   onError: (err, req, res) => {
//     console.error(`❌ HTTP代理错误:`, err.message);
//     if (!res.headersSent) {
//       res.status(502).json({ error: 'HTTP proxy error' });
//     }
//   }
// });

// // 应用HTTP代理（排除已处理的路由）
// app.use((req, res, next) => {
//   if (req.path === '/health' || req.path.startsWith('/socket.io/')) {
//     next();
//   } else {
//     httpProxy(req, res, next);
//   }
// });

// // WebSocket升级处理 - 专门针对Socket.IO
// server.on('upgrade', (request, socket, head) => {
//   const pathname = url.parse(request.url).pathname;
  
//   console.log(`�� WebSocket升级请求: ${pathname}`);
//   console.log(`�� 完整URL: ${request.url}`);
//   console.log(`�� 请求头:`, {
//     upgrade: request.headers.upgrade,
//     connection: request.headers.connection,
//     'sec-websocket-key': request.headers['sec-websocket-key'],
//     'sec-websocket-version': request.headers['sec-websocket-version']
//   });

//   // 检查是否是WebSocket升级请求
//   if (request.headers.upgrade !== 'websocket') {
//     socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
//     return;
//   }

//   // 构建目标WebSocket URL
//   const wsTarget = TARGET_HOST.replace('https://', 'wss://').replace('http://', 'ws://');
//   const targetWsUrl = wsTarget + request.url;
  
//   console.log(`�� 连接目标: ${targetWsUrl}`);

//   try {
//     // 创建到目标服务器的WebSocket连接
//     const targetWs = new WebSocket(targetWsUrl, {
//       headers: {
//         'Host': targetUrl.host,
//         'Origin': TARGET_HOST,
//         'Referer': TARGET_HOST,
//         'User-Agent': request.headers['user-agent'] || 'WebSocket-Proxy/1.0',
//         'Sec-WebSocket-Protocol': request.headers['sec-websocket-protocol'],
//         'Sec-WebSocket-Extensions': request.headers['sec-websocket-extensions']
//       },
//       handshakeTimeout: 10000
//     });

//     let clientWs;

//     targetWs.on('open', () => {
//       console.log('�� 目标WebSocket连接成功，开始握手');
      
//       // 创建WebSocket服务器实例来处理客户端连接
//       const wss = new WebSocket.Server({
//         noServer: true,
//         perMessageDeflate: false
//       });

//       // 完成WebSocket握手
//       wss.handleUpgrade(request, socket, head, (ws) => {
//         clientWs = ws;
//         console.log('✅ 客户端WebSocket握手完成');

//         // 设置消息转发
//         setupMessageForwarding(clientWs, targetWs);
//       });
//     });

//     targetWs.on('error', (error) => {
//       console.error('❌ 目标WebSocket连接失败:', error.message);
//       socket.write('HTTP/1.1 502 Bad Gateway\r\n' +
//                   'Content-Type: text/plain\r\n' +
//                   '\r\n' +
//                   'WebSocket proxy connection failed\r\n');
//       socket.end();
//     });

//     // 超时处理
//     const timeout = setTimeout(() => {
//       console.error('⏰ 目标WebSocket连接超时');
//       if (targetWs.readyState === WebSocket.CONNECTING) {
//         targetWs.terminate();
//       }
//       socket.end();
//     }, 10000);

//     targetWs.on('open', () => {
//       clearTimeout(timeout);
//     });

//   } catch (error) {
//     console.error('❌ WebSocket升级处理错误:', error.message);
//     socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
//     socket.end();
//   }
// });

// // 消息转发设置函数
// function setupMessageForwarding(clientWs, targetWs) {
//   // 目标 -> 客户端
//   targetWs.on('message', (data, isBinary) => {
//     try {
//       if (clientWs.readyState === WebSocket.OPEN) {
//         // Socket.IO消息格式处理
//         let processedData = data;
        
//         if (!isBinary && typeof data === 'object') {
//           processedData = data.toString();
//         }
        
//         if (typeof processedData === 'string') {
//           console.log(`�� 目标->客户端: ${processedData.substring(0, 200)}...`);
//         }
        
//         clientWs.send(processedData, { binary: isBinary });
//       }
//     } catch (error) {
//       console.error('❌ 目标->客户端消息转发错误:', error.message);
//     }
//   });

//   // 客户端 -> 目标
//   clientWs.on('message', (data, isBinary) => {
//     try {
//       if (targetWs.readyState === WebSocket.OPEN) {
//         let processedData = data;
        
//         if (!isBinary && typeof data === 'object') {
//           processedData = data.toString();
//         }
        
//         if (typeof processedData === 'string') {
//           console.log(`�� 客户端->目标: ${processedData.substring(0, 200)}...`);
//         }
        
//         targetWs.send(processedData, { binary: isBinary });
//       } else {
//         console.warn('⚠️ 目标WebSocket未就绪，消息丢弃');
//       }
//     } catch (error) {
//       console.error('❌ 客户端->目标消息转发错误:', error.message);
//     }
//   });

//   // 连接关闭处理
//   targetWs.on('close', (code, reason) => {
//     console.log(`�� 目标WebSocket关闭: ${code} ${reason}`);
//     if (clientWs.readyState === WebSocket.OPEN) {
//       clientWs.close(code, reason);
//     }
//   });

//   clientWs.on('close', (code, reason) => {
//     console.log(`�� 客户端WebSocket关闭: ${code} ${reason}`);
//     if (targetWs.readyState === WebSocket.OPEN) {
//       targetWs.close(code, reason);
//     }
//   });

//   // 错误处理
//   targetWs.on('error', (error) => {
//     console.error('❌ 目标WebSocket错误:', error.message);
//     if (clientWs.readyState === WebSocket.OPEN) {
//       clientWs.close(1011, 'Target error');
//     }
//   });

//   clientWs.on('error', (error) => {
//     console.error('❌ 客户端WebSocket错误:', error.message);
//     if (targetWs.readyState === WebSocket.OPEN) {
//       targetWs.close(1011, 'Client error');
//     }
//   });

//   // Ping/Pong保持连接
//   const pingInterval = setInterval(() => {
//     if (clientWs.readyState === WebSocket.OPEN && targetWs.readyState === WebSocket.OPEN) {
//       try {
//         clientWs.ping();
//       } catch (error) {
//         console.warn('⚠️ Ping发送失败:', error.message);
//         clearInterval(pingInterval);
//       }
//     } else {
//       clearInterval(pingInterval);
//     }
//   }, 30000);

//   clientWs.on('close', () => {
//     clearInterval(pingInterval);
//   });
  
//   targetWs.on('close', () => {
//     clearInterval(pingInterval);
//   });
// }

// // 启动服务器
// server.listen(PORT, '0.0.0.0', () => {
//   console.log('�� Socket.IO WebSocket代理服务器启动成功!');
//   console.log(`�� 监听端口: ${PORT}`);
//   console.log(`�� 代理目标: ${TARGET_HOST}`);
//   console.log(`�� 健康检查: http://localhost:${PORT}/health`);
//   console.log(`�� WebSocket支持: Socket.IO v4+ 兼容`);
// });

// // 优雅关闭
// function gracefulShutdown(signal) {
//   console.log(`�� 收到${signal}信号，正在关闭服务器...`);
  
//   server.close((err) => {
//     if (err) {
//       console.error('❌ 服务器关闭错误:', err);
//       process.exit(1);
//     }
//     console.log('✅ 服务器已关闭');
//     process.exit(0);
//   });

//   setTimeout(() => {
//     console.error('⏰ 强制关闭服务器');
//     process.exit(1);
//   }, 5000);
// }

// process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
// process.on('SIGINT', () => gracefulShutdown('SIGINT'));
