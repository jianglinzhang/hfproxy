// 1. 引入依赖
require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { createServer } = require('http');
const WebSocket = require('ws');
const { URL } = require('url');

// 2. 检查环境变量
const TARGET_HOST = process.env.TARGET_HOST;
if (!TARGET_HOST) {
  console.error('错误: 环境变量 TARGET_HOST 未设置。');
  process.exit(1);
}

console.log(`目标主机: ${TARGET_HOST}`);

// 3. 初始化 Express 应用
const app = express();
const PORT = process.env.PORT || 3000;

// 4. CORS 中间件
app.use(require('cors')({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['*'],
  credentials: false
}));

// 5. HTTP 代理中间件
const httpProxy = createProxyMiddleware({
  target: TARGET_HOST,
  changeOrigin: true,
  ws: false, // 我们手动处理 WebSocket
  timeout: 60000,
  proxyTimeout: 60000,
  
  // 请求头处理
  onProxyReq: (proxyReq, req, res) => {
    // 设置正确的 Origin 和 Referer
    proxyReq.setHeader('Origin', TARGET_HOST);
    proxyReq.setHeader('Referer', TARGET_HOST);
    console.log(`[HTTP] ${req.method} ${req.originalUrl} -> ${TARGET_HOST}${proxyReq.path}`);
  },
  
  onProxyRes: (proxyRes, req, res) => {
    console.log(`[HTTP Response] ${req.method} ${req.originalUrl} -> ${proxyRes.statusCode}`);
  },
  
  onError: (err, req, res) => {
    console.error('[HTTP Proxy Error]', err.message);
    if (res && !res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('HTTP Proxy error: ' + err.message);
    }
  }
});

// 6. 应用 HTTP 代理
app.use('/', httpProxy);

// 7. 创建 HTTP 服务器
const server = createServer(app);

// 8. 手动处理 WebSocket 升级
server.on('upgrade', async (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname;
  const search = url.search || '';
  
  console.log(`[WebSocket Upgrade] ${pathname}${search}`);
  
  // 检查是否是 WebSocket 升级请求
  if (request.headers.upgrade !== 'websocket') {
    console.log('[WebSocket] 非 WebSocket 升级请求，忽略');
    socket.destroy();
    return;
  }
  
  try {
    // 构建目标 WebSocket URL
    const targetUrl = TARGET_HOST.replace(/^https?:/, 'ws:').replace(/^http:/, 'ws:') + pathname + search;
    console.log(`[WebSocket] 连接目标: ${targetUrl}`);
    
    // 创建到目标服务器的 WebSocket 连接
    const targetWs = new WebSocket(targetUrl, {
      headers: {
        'Origin': TARGET_HOST,
        'Referer': TARGET_HOST,
        'User-Agent': request.headers['user-agent'] || 'Node.js WebSocket Proxy'
      },
      handshakeTimeout: 30000
    });
    
    // 处理目标 WebSocket 连接打开
    targetWs.on('open', () => {
      console.log('[WebSocket] 成功连接到目标服务器');
      
      // 构建 WebSocket 响应头
      const key = request.headers['sec-websocket-key'];
      const acceptKey = require('crypto')
        .createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      
      const responseHeaders = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey}`,
        'Access-Control-Allow-Origin: *',
        'Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers: *',
        ''
      ].join('\r\n');
      
      // 发送升级响应
      socket.write(responseHeaders + '\r\n');
      
      // 双向消息转发
      const forwardMessage = (data, direction) => {
        try {
          console.log(`[WebSocket ${direction}] 消息长度: ${data.length}`);
          return true;
        } catch (error) {
          console.error(`[WebSocket ${direction} Error]`, error.message);
          return false;
        }
      };
      
      // 目标服务器 -> 客户端
      targetWs.on('message', (data) => {
        if (forwardMessage(data, 'Target->Client')) {
          try {
            // 处理 WebSocket 帧格式
            const frame = createWebSocketFrame(data);
            socket.write(frame);
          } catch (error) {
            console.error('[WebSocket Frame Error]', error.message);
          }
        }
      });
      
      // 客户端 -> 目标服务器
      socket.on('data', (data) => {
        try {
          // 解析 WebSocket 帧
          const messages = parseWebSocketFrames(data);
          messages.forEach(message => {
            if (message && forwardMessage(message, 'Client->Target')) {
              targetWs.send(message);
            }
          });
        } catch (error) {
          console.error('[WebSocket Parse Error]', error.message);
        }
      });
    });
    
    // 处理目标服务器连接错误
    targetWs.on('error', (error) => {
      console.error('[WebSocket Target Error]', error.message);
      socket.destroy();
    });
    
    // 处理目标服务器关闭
    targetWs.on('close', (code, reason) => {
      console.log(`[WebSocket Target Closed] Code: ${code}, Reason: ${reason}`);
      socket.destroy();
    });
    
    // 处理客户端连接关闭
    socket.on('close', () => {
      console.log('[WebSocket Client Closed]');
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.close();
      }
    });
    
    // 处理客户端连接错误
    socket.on('error', (error) => {
      console.error('[WebSocket Client Error]', error.message);
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.close();
      }
    });
    
  } catch (error) {
    console.error('[WebSocket Setup Error]', error.message);
    socket.destroy();
  }
});

// 9. WebSocket 帧处理函数
function createWebSocketFrame(data) {
  const payload = Buffer.from(data);
  const payloadLength = payload.length;
  
  let frame;
  if (payloadLength < 126) {
    frame = Buffer.allocUnsafe(2 + payloadLength);
    frame[0] = 0x81; // FIN + text frame
    frame[1] = payloadLength;
    payload.copy(frame, 2);
  } else if (payloadLength < 65536) {
    frame = Buffer.allocUnsafe(4 + payloadLength);
    frame[0] = 0x81; // FIN + text frame
    frame[1] = 126;
    frame.writeUInt16BE(payloadLength, 2);
    payload.copy(frame, 4);
  } else {
    frame = Buffer.allocUnsafe(10 + payloadLength);
    frame[0] = 0x81; // FIN + text frame
    frame[1] = 127;
    frame.writeUInt32BE(0, 2); // 高32位
    frame.writeUInt32BE(payloadLength, 6); // 低32位
    payload.copy(frame, 10);
  }
  
  return frame;
}

function parseWebSocketFrames(buffer) {
  const messages = [];
  let offset = 0;
  
  while (offset < buffer.length) {
    if (offset + 2 > buffer.length) break;
    
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    
    const fin = (firstByte & 0x80) === 0x80;
    const opcode = firstByte & 0x0F;
    const masked = (secondByte & 0x80) === 0x80;
    let payloadLength = secondByte & 0x7F;
    
    let totalHeaderLength = 2;
    
    if (payloadLength === 126) {
      if (offset + 4 > buffer.length) break;
      payloadLength = buffer.readUInt16BE(offset + 2);
      totalHeaderLength = 4;
    } else if (payloadLength === 127) {
      if (offset + 10 > buffer.length) break;
      payloadLength = buffer.readUInt32BE(offset + 6); // 只读低32位
      totalHeaderLength = 10;
    }
    
    if (masked) {
      totalHeaderLength += 4; // mask key
    }
    
    if (offset + totalHeaderLength + payloadLength > buffer.length) break;
    
    if (opcode === 1 || opcode === 2) { // text or binary frame
      let payload = buffer.slice(offset + totalHeaderLength, offset + totalHeaderLength + payloadLength);
      
      if (masked) {
        const maskKey = buffer.slice(offset + totalHeaderLength - 4, offset + totalHeaderLength);
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }
      
      if (opcode === 1) { // text frame
        messages.push(payload.toString('utf8'));
      } else { // binary frame
        messages.push(payload);
      }
    }
    
    offset += totalHeaderLength + payloadLength;
  }
  
  return messages;
}

// 10. 启动服务器
server.listen(PORT, () => {
  console.log(`代理服务器已启动，监听端口 ${PORT}`);
  console.log(`正在代理 -> ${TARGET_HOST}`);
  console.log(`WebSocket 支持: 已启用`);
});

// 11. 优雅关闭
process.on('SIGTERM', () => {
  console.log('收到 SIGTERM，正在关闭服务器...');
  server.close(() => {
    console.log('服务器已关闭。');
  });
});

process.on('SIGINT', () => {
  console.log('收到 SIGINT，正在关闭服务器...');
  server.close(() => {
    console.log('服务器已关闭。');
  });
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
