require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const httpProxy = require('http-proxy');
const cors = require('cors');
const { parse } = require('url');

const TARGET_HOST = process.env.TARGET_HOST;
if (!TARGET_HOST) {
  console.error('错误: 环境变量 TARGET_HOST 未设置。');
  console.error('请设置: TARGET_HOST=https://your-fastchat.hf.space');
  process.exit(1);
}

console.log(`目标主机: ${TARGET_HOST}`);

const app = express();
const PORT = process.env.PORT || 3000;

// 防止进程意外退出的保护机制
process.on('SIGTERM', () => {
  console.log('收到 SIGTERM，延迟关闭以完成请求处理...');
  setTimeout(() => {
    console.log('优雅关闭服务器');
    process.exit(0);
  }, 5000);
});

// CORS 设置
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['*'],
  credentials: false
}));

// 创建代理实例
const proxy = httpProxy.createProxyServer({
  target: TARGET_HOST,
  changeOrigin: true,
  ws: true,
  timeout: 60000,
  proxyTimeout: 60000,
  secure: true,
  followRedirects: true
});

// 代理错误处理
proxy.on('error', (err, req, res, target) => {
  console.error(`[Proxy Error] ${err.message} - URL: ${req.url}`);
  
  if (res && !res.headersSent) {
    // 根据请求类型返回不同格式的错误
    const acceptsJSON = req.headers.accept && req.headers.accept.includes('application/json');
    const isAPI = req.url.includes('/api/') || req.url.includes('/socket.io/');
    
    if (acceptsJSON || isAPI) {
      res.writeHead(502, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({
        error: 'Proxy Error',
        message: err.message,
        code: 502
      }));
    } else {
      res.writeHead(502, {
        'Content-Type': 'text/html',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>代理错误</title>
          <meta charset="utf-8">
        </head>
        <body>
          <h1>502 代理服务器错误</h1>
          <p>无法连接到目标服务器: ${TARGET_HOST}</p>
          <p>错误信息: ${err.message}</p>
          <p>请稍后重试或联系管理员。</p>
        </body>
        </html>
      `);
    }
  }
});

// 响应处理
proxy.on('proxyRes', (proxyRes, req, res) => {
  const status = proxyRes.statusCode;
  console.log(`[${status}] ${req.method} ${req.url}`);
  
  // 添加 CORS 头
  proxyRes.headers['access-control-allow-origin'] = '*';
  proxyRes.headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS, HEAD';
  proxyRes.headers['access-control-allow-headers'] = '*';
  
  // 确保 MIME 类型正确
  const url = req.url;
  if (url.endsWith('.js') && proxyRes.headers['content-type']) {
    if (!proxyRes.headers['content-type'].includes('javascript')) {
      proxyRes.headers['content-type'] = 'application/javascript; charset=utf-8';
    }
  } else if (url.endsWith('.json') && proxyRes.headers['content-type']) {
    if (!proxyRes.headers['content-type'].includes('json')) {
      proxyRes.headers['content-type'] = 'application/json; charset=utf-8';
    }
  } else if (url.endsWith('.css') && proxyRes.headers['content-type']) {
    if (!proxyRes.headers['content-type'].includes('css')) {
      proxyRes.headers['content-type'] = 'text/css; charset=utf-8';
    }
  }
});

// WebSocket 代理处理
proxy.on('proxyReqWs', (proxyReq, req, socket, options, head) => {
  console.log(`[WebSocket] 代理升级请求: ${req.url}`);
  proxyReq.setHeader('Origin', TARGET_HOST);
  proxyReq.setHeader('Referer', TARGET_HOST);
});

proxy.on('open', (proxySocket) => {
  console.log('[WebSocket] 代理连接建立成功');
});

proxy.on('close', (res, socket, head) => {
  console.log('[WebSocket] 代理连接关闭');
});

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    target: TARGET_HOST,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// 根路径处理 - 避免直接代理可能导致的问题
app.get('/', (req, res) => {
  console.log('[Root] 根路径访问');
  
  // 添加缓存控制头
  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  
  proxy.web(req, res);
});

// Socket.IO 特殊处理
app.all('/socket.io/*', (req, res) => {
  console.log(`[Socket.IO] ${req.method} ${req.url}`);
  console.log(`[Socket.IO] Transport: ${req.query.transport}`);
  
  // 设置适当的头部
  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  
  proxy.web(req, res);
});

// API 路径处理
app.all('/api/*', (req, res) => {
  console.log(`[API] ${req.method} ${req.url}`);
  proxy.web(req, res);
});

// 静态资源处理 - 特别关注 MIME 类型
app.use('/static/*', (req, res, next) => {
  console.log(`[Static] ${req.url}`);
  
  // 预设正确的 MIME 类型
  const url = req.url;
  if (url.endsWith('.js')) {
    res.type('application/javascript');
  } else if (url.endsWith('.json')) {
    res.type('application/json');
  } else if (url.endsWith('.css')) {
    res.type('text/css');
  } else if (url.endsWith('.html')) {
    res.type('text/html');
  }
  
  proxy.web(req, res);
});

// 应用资源处理（特别针对 _app 路径）
app.use('/_app/*', (req, res, next) => {
  console.log(`[App] ${req.url}`);
  
  // 强制设置正确的 MIME 类型
  if (req.url.includes('.js')) {
    res.type('application/javascript');
  }
  
  proxy.web(req, res);
});

// 捕获所有其他请求
app.use('*', (req, res) => {
  console.log(`[Proxy] ${req.method} ${req.originalUrl}`);
  proxy.web(req, res);
});

// 创建服务器
const server = createServer(app);

// WebSocket 升级处理
server.on('upgrade', (request, socket, head) => {
  console.log(`[Upgrade] WebSocket 升级请求: ${request.url}`);
  
  const isWebSocket = request.headers.upgrade && 
                     request.headers.upgrade.toLowerCase() === 'websocket';
  
  if (!isWebSocket) {
    console.log('[Upgrade] 拒绝非 WebSocket 升级');
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  
  console.log('[Upgrade] 转发 WebSocket 升级请求');
  proxy.ws(request, socket, head);
});

// 服务器错误处理
server.on('error', (error) => {
  console.error('[Server Error]', error);
});

server.on('clientError', (err, socket) => {
  console.error('[Client Error]', err.message);
  if (!socket.destroyed) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
});

// 启动服务器
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 代理服务器启动成功`);
  console.log(`�� 监听地址: http://0.0.0.0:${PORT}`);
  console.log(`�� 代理目标: ${TARGET_HOST}`);
  console.log(`⚡ WebSocket 支持: 已启用`);
  console.log(`�� 启动时间: ${new Date().toISOString()}`);
});

// 优雅关闭处理
const shutdown = (signal) => {
  console.log(`收到 ${signal}，开始优雅关闭...`);
  
  server.close((err) => {
    if (err) {
      console.error('关闭服务器时出错:', err);
      process.exit(1);
    }
    
    console.log('HTTP 服务器已关闭');
    
    if (proxy.close) {
      proxy.close(() => {
        console.log('代理服务器已关闭');
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  });
  
  // 强制退出保护
  setTimeout(() => {
    console.log('强制退出');
    process.exit(1);
  }, 10000);
};

// 信号处理 - 移除 SIGTERM 的立即退出
process.on('SIGINT', () => shutdown('SIGINT'));

// 异常处理
process.on('uncaughtException', (error) => {
  console.error('未捕获的异常:', error);
  // 不要立即退出，给时间完成正在进行的请求
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的 Promise 拒绝:', reason);
});

console.log('�� 代理服务器初始化完成，等待启动...');


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
