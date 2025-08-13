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
console.log(`当前时间: ${new Date().toISOString()}\n`);

const app = express();
const PORT = process.env.PORT || 3000;

// 全局 CORS 设置
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH'],
  allowedHeaders: ['*'],
  credentials: false,
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

// 处理 OPTIONS 预检请求
app.options('*', (req, res) => {
  console.log(`[OPTIONS] ${req.url}`);
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH');
  res.header('Access-Control-Allow-Headers', '*');
  res.sendStatus(200);
});

// 创建 HTTP 代理实例
const proxy = httpProxy.createProxyServer({
  target: TARGET_HOST,
  changeOrigin: true,
  ws: true,
  timeout: 120000,
  proxyTimeout: 120000,
  secure: true,
  followRedirects: true,
  headers: {
    'User-Agent': 'Node.js WebSocket Proxy Server'
  }
});

// 代理事件处理
proxy.on('error', (err, req, res, target) => {
  console.error(`[Proxy Error] ${err.message}`);
  console.error(`[Proxy Error] URL: ${req.url}`);
  console.error(`[Proxy Error] Target: ${target || TARGET_HOST}`);
  
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      error: '代理服务器错误',
      message: err.message,
      code: 502
    }));
  }
});

proxy.on('proxyRes', (proxyRes, req, res) => {
  const status = proxyRes.statusCode;
  const method = req.method;
  const url = req.url;
  
  console.log(`[HTTP ${status}] ${method} ${url}`);
  
  // 强制添加 CORS 头
  proxyRes.headers['Access-Control-Allow-Origin'] = '*';
  proxyRes.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH';
  proxyRes.headers['Access-Control-Allow-Headers'] = '*';
  
  // 特殊处理 Socket.IO 相关响应
  if (url.includes('/socket.io/')) {
    console.log(`[Socket.IO Response] ${method} ${url} -> ${status}`);
    if (status === 400) {
      console.log(`[Socket.IO Error] 可能的原因: WebSocket 升级失败或协议版本不匹配`);
    }
  }
});

proxy.on('proxyReq', (proxyReq, req, res) => {
  // 设置代理请求头
  proxyReq.setHeader('Origin', TARGET_HOST);
  proxyReq.setHeader('Referer', TARGET_HOST);
  
  const method = req.method;
  const url = req.url;
  console.log(`[HTTP Req] ${method} ${url} -> ${TARGET_HOST}${url}`);
});

proxy.on('proxyReqWs', (proxyReq, req, socket, options, head) => {
  console.log(`�� [WebSocket Proxy] 升级请求开始`);
  console.log(`�� [WebSocket Proxy] URL: ${req.url}`);
  console.log(`�� [WebSocket Proxy] 目标: ${TARGET_HOST}${req.url}`);
  
  // 设置 WebSocket 代理请求头
  proxyReq.setHeader('Origin', TARGET_HOST);
  proxyReq.setHeader('Referer', TARGET_HOST);
  proxyReq.setHeader('User-Agent', req.headers['user-agent'] || 'Node.js WebSocket Proxy');
  
  console.log(`�� [WebSocket Proxy] 请求头已设置\n`);
});

proxy.on('open', (proxySocket) => {
  console.log(`✅ [WebSocket] 代理连接已建立`);
  
  proxySocket.on('data', (data) => {
    console.log(`�� [WebSocket Data] 收到 ${data.length} 字节`);
  });
  
  proxySocket.on('close', () => {
    console.log(`❌ [WebSocket] 代理连接已关闭`);
  });
  
  proxySocket.on('error', (err) => {
    console.error(`�� [WebSocket] 代理连接错误: ${err.message}`);
  });
});

proxy.on('close', (res, socket, head) => {
  console.log(`�� [WebSocket] 连接关闭事件`);
});

// 请求日志中间件
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  const method = req.method;
  const url = req.url;
  const userAgent = req.headers['user-agent'] || 'Unknown';
  
  console.log(`\n[${timestamp}] ${method} ${url}`);
  console.log(`User-Agent: ${userAgent.substring(0, 100)}...`);
  
  // 检查是否可能是 WebSocket 相关请求
  const isSocketIOPath = url.includes('/socket.io/') || url.includes('/ws/');
  const hasUpgrade = req.headers.upgrade;
  const hasConnection = req.headers.connection;
  
  if (isSocketIOPath) {
    console.log(`�� [Socket.IO] 检测到 Socket.IO 相关路径`);
    console.log(`�� [Socket.IO] Upgrade Header: ${hasUpgrade}`);
    console.log(`�� [Socket.IO] Connection Header: ${hasConnection}`);
    console.log(`�� [Socket.IO] Query Params:`, req.query);
  }
  
  next();
});

// Socket.IO 健康检查端点
app.get('/socket.io/health', (req, res) => {
  console.log(`�� [Health Check] Socket.IO 健康检查`);
  res.json({
    status: 'ok',
    proxy_target: TARGET_HOST,
    timestamp: new Date().toISOString(),
    websocket_support: true
  });
});

// 根路径重定向
app.get('/', (req, res) => {
  console.log(`�� [Root] 根路径访问，重定向到目标服务器`);
  proxy.web(req, res);
});

// Socket.IO 轮询处理（重要）
app.all('/socket.io/*', (req, res) => {
  const method = req.method;
  const url = req.url;
  const transport = req.query.transport;
  
  console.log(`�� [Socket.IO Route] ${method} ${url}`);
  console.log(`�� [Socket.IO Route] Transport: ${transport}`);
  
  if (transport === 'websocket' && method === 'GET') {
    console.log(`⚡ [Socket.IO Route] WebSocket 传输模式检测`);
    console.log(`⚡ [Socket.IO Route] 等待 WebSocket 升级事件...`);
  }
  
  // 转发到目标服务器
  proxy.web(req, res);
});

// 所有其他路径的代理
app.use('*', (req, res) => {
  console.log(`�� [Catch All] ${req.method} ${req.originalUrl}`);
  proxy.web(req, res);
});

// 创建 HTTP 服务器
const server = createServer(app);

// 核心：WebSocket 升级事件处理
server.on('upgrade', (request, socket, head) => {
  const timestamp = new Date().toISOString();
  console.log(`\n�� ============ WebSocket 升级事件 [${timestamp}] ============`);
  console.log(`�� URL: ${request.url}`);
  console.log(`�� Method: ${request.method}`);
  
  // 详细头部信息
  console.log(`�� Headers:`);
  Object.entries(request.headers).forEach(([key, value]) => {
    console.log(`   ${key}: ${value}`);
  });
  
  // URL 解析
  const parsedUrl = parse(request.url, true);
  console.log(`�� 解析后的 URL:`, {
    pathname: parsedUrl.pathname,
    query: parsedUrl.query,
    search: parsedUrl.search
  });
  
  // 检查 WebSocket 升级条件
  const upgrade = request.headers.upgrade;
  const connection = request.headers.connection;
  const isWebSocket = upgrade && upgrade.toLowerCase() === 'websocket';
  const isUpgradeConnection = connection && connection.toLowerCase().includes('upgrade');
  
  console.log(`✅ 升级检查结果:`);
  console.log(`   Upgrade Header: ${upgrade} (${isWebSocket ? '✓' : '✗'})`);
  console.log(`   Connection Header: ${connection} (${isUpgradeConnection ? '✓' : '✗'})`);
  
  if (!isWebSocket) {
    console.log(`❌ 拒绝非 WebSocket 升级请求`);
    socket.write('HTTP/1.1 400 Bad Request\r\n');
    socket.write('Content-Type: text/plain\r\n');
    socket.write('Access-Control-Allow-Origin: *\r\n');
    socket.write('\r\n');
    socket.write('WebSocket upgrade required');
    socket.end();
    return;
  }
  
  console.log(`�� 开始 WebSocket 代理到: ${TARGET_HOST}${request.url}`);
  
  // 设置错误处理
  const handleProxyError = (error) => {
    console.error(`�� WebSocket 代理错误: ${error.message}`);
    console.error(`�� 错误详情:`, error);
    
    if (!socket.destroyed) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\n');
      socket.write('Content-Type: text/plain\r\n');
      socket.write('Access-Control-Allow-Origin: *\r\n');
      socket.write('\r\n');
      socket.write(`WebSocket proxy error: ${error.message}`);
      socket.end();
    }
  };
  
  try {
    // 执行 WebSocket 代理
    proxy.ws(request, socket, head, {
      target: TARGET_HOST,
      ws: true,
      changeOrigin: true,
      headers: {
        'Origin': TARGET_HOST,
        'Referer': TARGET_HOST,
        'User-Agent': request.headers['user-agent'] || 'Node.js WebSocket Proxy'
      }
    }, handleProxyError);
    
    console.log(`✅ WebSocket 代理请求已发送`);
    
  } catch (error) {
    handleProxyError(error);
  }
  
  console.log(`�� ============ WebSocket 升级事件结束 ============\n`);
});

// 服务器事件处理
server.on('error', (error) => {
  console.error(`�� [Server Error]`, error);
});

server.on('clientError', (err, socket) => {
  console.error(`�� [Client Error]`, err.message);
  if (!socket.destroyed) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
});

// 启动服务器
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n�� =============== 服务器启动成功 ===============`);
  console.log(`�� 服务器地址: http://0.0.0.0:${PORT}`);
  console.log(`�� 代理目标: ${TARGET_HOST}`);
  console.log(`⚡ WebSocket 支持: 已启用`);
  console.log(`�� 启动时间: ${new Date().toISOString()}`);
  console.log(`�� Node.js 版本: ${process.version}`);
  console.log(`�� 环境变量:`);
  console.log(`   PORT: ${PORT}`);
  console.log(`   TARGET_HOST: ${TARGET_HOST}`);
  console.log(`�� ===============================================`);
});

// 优雅关闭处理
const gracefulShutdown = (signal) => {
  console.log(`�� 收到 ${signal} 信号，开始优雅关闭...`);
  
  const timeout = setTimeout(() => {
    console.log(`⏰ 关闭超时，强制退出`);
    process.exit(1);
  }, 15000);
  
  server.close((err) => {
    clearTimeout(timeout);
    
    if (err) {
      console.error(`❌ 服务器关闭时出错:`, err);
      process.exit(1);
    }
    
    console.log(`✅ HTTP 服务器已关闭`);
    
    proxy.close(() => {
      console.log(`✅ 代理服务器已关闭`);
      console.log(`�� 进程即将退出`);
      process.exit(0);
    });
  });
};

// 信号处理
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 异常处理
process.on('uncaughtException', (error) => {
  console.error(`�� 未捕获的异常:`, error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`�� 未处理的 Promise 拒绝:`, reason);
  console.error(`Promise:`, promise);
  gracefulShutdown('UNHANDLED_REJECTION');
});

// 内存监控（可选）
setInterval(() => {
  const used = process.memoryUsage();
  const usage = {
    rss: Math.round(used.rss / 1024 / 1024 * 100) / 100,
    heapTotal: Math.round(used.heapTotal / 1024 / 1024 * 100) / 100,
    heapUsed: Math.round(used.heapUsed / 1024 / 1024 * 100) / 100,
    external: Math.round(used.external / 1024 / 1024 * 100) / 100
  };
  
  console.log(`�� [Memory] RSS: ${usage.rss}MB, Heap: ${usage.heapUsed}/${usage.heapTotal}MB, External: ${usage.external}MB`);
}, 60000); // 每分钟输出一次

console.log(`�� 调试信息:`);
console.log(`   当前工作目录: ${process.cwd()}`);
console.log(`   命令行参数: ${process.argv.join(' ')}`);
console.log(`   环境: ${process.env.NODE_ENV || 'development'}`);


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
