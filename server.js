require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const httpProxy = require('http-proxy');
const cors = require('cors');
const { parse } = require('url');

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
  secure: true,
  headers: {
    'Connection': 'upgrade'
  }
});

// 处理代理错误
proxy.on('error', (err, req, res) => {
  console.error('[Proxy Error]', err.message);
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(500, {
      'Content-Type': 'text/plain',
      'Access-Control-Allow-Origin': '*'
    });
    res.end('代理错误: ' + err.message);
  }
});

// 处理 HTTP 请求的代理响应
proxy.on('proxyRes', (proxyRes, req, res) => {
  console.log(`[HTTP Response] ${req.method} ${req.url} -> ${proxyRes.statusCode}`);
  
  // 添加 CORS 头
  proxyRes.headers['Access-Control-Allow-Origin'] = '*';
  proxyRes.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
  proxyRes.headers['Access-Control-Allow-Headers'] = '*';
});

// 处理 WebSocket 代理请求
proxy.on('proxyReqWs', (proxyReq, req, socket, options, head) => {
  console.log(`[WebSocket Proxy] 升级请求: ${req.url}`);
  console.log(`[WebSocket Proxy] 目标: ${options.target.href}${req.url}`);
  
  // 设置正确的请求头
  proxyReq.setHeader('Origin', TARGET_HOST);
  proxyReq.setHeader('Referer', TARGET_HOST);
  proxyReq.setHeader('User-Agent', req.headers['user-agent'] || 'Node.js WebSocket Proxy');
});

// WebSocket 连接建立成功
proxy.on('open', (proxySocket) => {
  console.log('[WebSocket] 代理连接已建立');
});

// WebSocket 连接关闭
proxy.on('close', (res, socket, head) => {
  console.log('[WebSocket] 代理连接已关闭');
});

// 中间件：检查是否是 WebSocket 升级请求
const checkWebSocketUpgrade = (req, res, next) => {
  const isWebSocketPath = req.url.includes('/ws/socket.io/') || 
                         req.url.includes('/socket.io/');
  
  const hasUpgradeHeader = req.headers.upgrade && 
                          req.headers.upgrade.toLowerCase() === 'websocket';
  
  const hasConnectionUpgrade = req.headers.connection && 
                              req.headers.connection.toLowerCase().includes('upgrade');
  
  console.log(`[Request Check] ${req.method} ${req.url}`);
  console.log(`[Request Check] WebSocket Path: ${isWebSocketPath}`);
  console.log(`[Request Check] Upgrade Header: ${hasUpgradeHeader}`);
  console.log(`[Request Check] Connection Header: ${hasConnectionUpgrade}`);
  console.log(`[Request Check] Headers:`, req.headers);
  
  if (isWebSocketPath && req.method === 'GET' && (hasUpgradeHeader || hasConnectionUpgrade)) {
    // 这是一个 WebSocket 升级请求，但可能没有正确的头部
    // 强制设置正确的头部
    req.headers.upgrade = 'websocket';
    req.headers.connection = 'Upgrade';
    console.log('[Request Check] 修正为 WebSocket 升级请求');
  }
  
  next();
};

// 应用检查中间件
app.use(checkWebSocketUpgrade);

// Socket.IO 特殊处理路由
app.get('/ws/socket.io/*', (req, res) => {
  console.log(`[Socket.IO Route] ${req.url}`);
  console.log(`[Socket.IO Route] Query:`, req.query);
  
  const transport = req.query.transport;
  
  if (transport === 'websocket') {
    // 这应该是一个 WebSocket 升级请求
    console.log('[Socket.IO Route] WebSocket transport detected');
    
    // 检查是否有正确的升级头
    if (!req.headers.upgrade || req.headers.upgrade.toLowerCase() !== 'websocket') {
      console.log('[Socket.IO Route] 缺少 WebSocket 升级头，返回错误');
      return res.status(400).json({ 
        error: 'WebSocket upgrade required',
        code: 3,
        message: 'Transport unknown'
      });
    }
  }
  
  // 转发到代理
  proxy.web(req, res);
});

// 所有其他请求通过代理
app.use('/', (req, res) => {
  console.log(`[HTTP Request] ${req.method} ${req.url}`);
  proxy.web(req, res);
});

// 创建服务器
const server = createServer(app);

// 关键：处理 WebSocket 升级事件
server.on('upgrade', (request, socket, head) => {
  console.log(`\n=== WebSocket Upgrade Event ===`);
  console.log(`[Upgrade] URL: ${request.url}`);
  console.log(`[Upgrade] Method: ${request.method}`);
  console.log(`[Upgrade] Headers:`, JSON.stringify(request.headers, null, 2));
  
  const parsedUrl = parse(request.url, true);
  console.log(`[Upgrade] Parsed URL:`, parsedUrl);
  
  // 检查是否是 WebSocket 升级请求
  const isWebSocket = request.headers.upgrade && 
                     request.headers.upgrade.toLowerCase() === 'websocket';
  
  const isSocketIOWebSocket = request.url.includes('/ws/socket.io/') && 
                             parsedUrl.query.transport === 'websocket';
  
  if (!isWebSocket) {
    console.log('[Upgrade] 非 WebSocket 请求，拒绝升级');
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  
  if (!isSocketIOWebSocket) {
    console.log('[Upgrade] 非 Socket.IO WebSocket 请求');
  }
  
  console.log('[Upgrade] 开始 WebSocket 代理...');
  
  try {
    // 使用代理转发 WebSocket 升级
    proxy.ws(request, socket, head, {
      target: TARGET_HOST
    }, (error) => {
      if (error) {
        console.error('[Upgrade] WebSocket 代理错误:', error.message);
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        socket.destroy();
      }
    });
  } catch (error) {
    console.error('[Upgrade] WebSocket 代理异常:', error.message);
    socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    socket.destroy();
  }
  
  console.log(`=== WebSocket Upgrade Event End ===\n`);
});

// 处理服务器错误
server.on('error', (error) => {
  console.error('[Server Error]', error);
});

// 启动服务器
server.listen(PORT, '0.0.0.0', () => {
  console.log(`�� 代理服务器已启动`);
  console.log(`�� 监听端口: ${PORT}`);
  console.log(`�� 代理目标: ${TARGET_HOST}`);
  console.log(`�� WebSocket 支持: 已启用`);
  console.log(`�� 访问地址: http://localhost:${PORT}\n`);
});

// 优雅关闭处理
const gracefulShutdown = (signal) => {
  console.log(`\n收到 ${signal} 信号，正在关闭服务器...`);
  
  server.close((err) => {
    if (err) {
      console.error('服务器关闭时出错:', err);
      process.exit(1);
    }
    
    console.log('服务器已关闭');
    
    proxy.close(() => {
      console.log('代理已关闭');
      process.exit(0);
    });
  });
  
  // 强制退出超时
  setTimeout(() => {
    console.log('强制退出...');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 捕获未处理的异常
process.on('uncaughtException', (error) => {
  console.error('未捕获的异常:', error);
  gracefulShutdown('EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的 Promise 拒绝:', reason);
  gracefulShutdown('REJECTION');
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
