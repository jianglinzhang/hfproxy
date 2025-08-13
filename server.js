require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const httpProxy = require('http-proxy');
const cors = require('cors');

const TARGET_HOST = process.env.TARGET_HOST;
if (!TARGET_HOST) {
  console.error('错误: 环境变量 TARGET_HOST 未设置。');
  process.exit(1);
}

console.log(`目标主机: ${TARGET_HOST}`);

const app = express();
const PORT = process.env.PORT || 3000;

// CORS 设置
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['*'],
  credentials: false
}));

// 创建 HTTP 代理实例
const proxy = httpProxy.createProxyServer({
  target: TARGET_HOST,
  changeOrigin: true,
  ws: true,
  timeout: 60000,
  proxyTimeout: 60000,
  headers: {
    'Connection': 'keep-alive'
  }
});

// 处理代理错误
proxy.on('error', (err, req, res) => {
  console.error('[Proxy Error]', err.message);
  if (res && !res.headersSent) {
    res.writeHead(500, {
      'Content-Type': 'text/plain',
      'Access-Control-Allow-Origin': '*'
    });
    res.end('代理错误: ' + err.message);
  }
});

// 处理 HTTP 请求的代理响应
proxy.on('proxyRes', (proxyRes, req, res) => {
  console.log(`[HTTP] ${req.method} ${req.url} -> ${proxyRes.statusCode}`);
  
  // 添加 CORS 头
  proxyRes.headers['Access-Control-Allow-Origin'] = '*';
  proxyRes.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
  proxyRes.headers['Access-Control-Allow-Headers'] = '*';
});

// 处理 WebSocket 代理
proxy.on('proxyReqWs', (proxyReq, req, socket, options, head) => {
  console.log(`[WebSocket] 升级请求: ${req.url}`);
  
  // 设置正确的请求头
  proxyReq.setHeader('Origin', TARGET_HOST);
  proxyReq.setHeader('Referer', TARGET_HOST);
});

proxy.on('open', (proxySocket) => {
  console.log('[WebSocket] 代理连接已建立');
  proxySocket.on('data', (data) => {
    console.log('[WebSocket] 收到数据:', data.length, '字节');
  });
});

proxy.on('close', (res, socket, head) => {
  console.log('[WebSocket] 代理连接已关闭');
});

// 所有 HTTP 请求通过代理
app.use('/', (req, res) => {
  console.log(`[HTTP Request] ${req.method} ${req.url}`);
  proxy.web(req, res);
});

// 创建服务器
const server = createServer(app);

// 重要：手动处理 WebSocket 升级
server.on('upgrade', (request, socket, head) => {
  console.log(`[Server Upgrade] ${request.url}`);
  console.log('[Server Upgrade] Headers:', request.headers);
  
  // 检查是否是 WebSocket 升级请求
  const isWebSocket = request.headers.upgrade && 
                     request.headers.upgrade.toLowerCase() === 'websocket';
  
  if (!isWebSocket) {
    console.log('[Server Upgrade] 非 WebSocket 请求，拒绝升级');
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  
  console.log('[Server Upgrade] 转发 WebSocket 升级请求');
  proxy.ws(request, socket, head);
});

// 启动服务器
server.listen(PORT, '0.0.0.0', () => {
  console.log(`代理服务器已启动，监听端口 ${PORT}`);
  console.log(`正在代理 -> ${TARGET_HOST}`);
  console.log(`WebSocket 支持: 已启用`);
});

// 优雅关闭处理
const gracefulShutdown = () => {
  console.log('正在关闭服务器...');
  server.close(() => {
    console.log('服务器已关闭');
    proxy.close(() => {
      console.log('代理已关闭');
      process.exit(0);
    });
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

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
