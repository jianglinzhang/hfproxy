const http = require('http');
const https = require('https');
const { parse } = require('url');
const zlib = require('zlib');
const WebSocket = require('ws');
const { pipeline } = require('stream');

// --- 配置 ---
// 优先使用环境变量，更安全、更灵活
const PORT = process.env.PORT || 8080;
const TARGET_HOST = process.env.TARGET_HOST;

// 日志函数
function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// 转换请求头
function transformHeaders(incomingHeaders) {
  const newHeaders = { ...incomingHeaders };

  // 关键：设置目标主机和来源
  newHeaders['host'] = TARGET_HOST;
  newHeaders['origin'] = `https://${TARGET_HOST}`;
  newHeaders['referer'] = `https://${TARGET_HOST}/`;

  // 删除或修改可能引起问题的头部
  // 'connection' 头由 Node.js 的 http Agent 自动管理
  delete newHeaders['connection'];
  delete newHeaders['upgrade-insecure-requests'];
  
  // 确保 accept-encoding 被正确传递，以便服务器返回压缩数据
  if (newHeaders['accept-encoding']) {
    // 我们可以简化它，只保留常见的几种
    newHeaders['accept-encoding'] = 'gzip, deflate, br';
  }

  return newHeaders;
}

// 处理 WebSocket 升级请求
function handleWebSocket(req, socket, head) {
    const wss = new WebSocket.Server({ noServer: true });
  
    wss.on('connection', function connection(clientWs) {
        const url = parse(req.url);
        const targetUrl = `wss://${TARGET_HOST}${url.pathname || ''}${url.search || ''}`;
        log(`WS: Establishing connection to: ${targetUrl}`);

        const targetWs = new WebSocket(targetUrl, {
            headers: {
                'user-agent': req.headers['user-agent'],
                'origin': `https://${TARGET_HOST}`,
            }
        });

        const setupPipe = (source, destination, sourceName, destName) => {
            source.on('message', (data) => {
                if (destination.readyState === WebSocket.OPEN) {
                    destination.send(data);
                }
            });
            source.on('close', () => {
                log(`WS: ${sourceName} closed connection. Closing ${destName}.`);
                if (destination.readyState === WebSocket.OPEN) {
                    destination.close();
                }
            });
            source.on('error', (error) => {
                log(`WS Error from ${sourceName}: ${error.message}`);
                if (destination.readyState === WebSocket.OPEN) {
                    destination.close();
                }
            });
        };

        targetWs.on('open', () => {
            log('WS: Connection to target established.');
            setupPipe(clientWs, targetWs, 'Client', 'Target');
            setupPipe(targetWs, clientWs, 'Target', 'Client');
        });
        
        targetWs.on('error', (error) => {
             log(`WS: Failed to connect to target: ${error.message}`);
             clientWs.close(1011, 'Proxy connection error');
        });
    });

    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
    });
}


// 处理 HTTP 请求 (包括 SSE)
function handleRequest(req, res) {
  const url = parse(req.url);
  const options = {
    hostname: TARGET_HOST,
    port: 443,
    path: `${url.pathname || ''}${url.search || ''}`,
    method: req.method,
    headers: transformHeaders(req.headers)
  };

  const proxyReq = https.request(options, (targetRes) => {
    log(`[${targetRes.statusCode}] ${req.method} ${req.url}`);

    // --- 关键修复点 ---
    const responseHeaders = { ...targetRes.headers };
    // 增强 CORS 头部，确保所有类型的请求都能通过
    responseHeaders['access-control-allow-origin'] = '*';
    responseHeaders['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    responseHeaders['access-control-allow-headers'] = 'Content-Type, Authorization, X-Requested-With';
    
    // 删除与安全相关的头部，避免浏览器策略冲突
    delete responseHeaders['content-security-policy'];
    delete responseHeaders['x-frame-options'];
    
    // FIXED: 正确处理 304 Not Modified
    if (targetRes.statusCode === 304) {
      res.writeHead(304, responseHeaders);
      res.end();
      return;
    }

    // NEW: 特殊处理 SSE (Server-Sent Events)
    const contentType = targetRes.headers['content-type'];
    if (contentType && contentType.includes('text/event-stream')) {
      log('Proxying as Server-Sent Event stream. Bypassing compression handling.');
      res.writeHead(targetRes.statusCode, responseHeaders);
      // 直接将原始数据流管道连接到客户端，不做任何处理
      pipeline(targetRes, res, (err) => {
        if (err) {
          log(`SSE stream pipeline error: ${err.message}`);
        }
      });
      return;
    }

    // 对于其他所有响应，进行标准的流式处理
    res.writeHead(targetRes.statusCode, responseHeaders);
    const encoding = targetRes.headers['content-encoding'];
    
    // 根据内容编码选择合适的解压流
    let bodyStream = targetRes;
    if (encoding === 'gzip') {
        bodyStream = targetRes.pipe(zlib.createGunzip());
    } else if (encoding === 'deflate') {
        bodyStream = targetRes.pipe(zlib.createInflate());
    } else if (encoding === 'br') {
        bodyStream = targetRes.pipe(zlib.createBrotliDecompress());
    }

    pipeline(bodyStream, res, (err) => {
        if (err) {
            log(`Response pipeline error: ${err.message}`);
        }
    });

  });

  proxyReq.on('error', (error) => {
    log(`Proxy request error: ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway: Proxy request failed.');
    }
  });

  // 将客户端请求体流式传输到目标服务器
  pipeline(req, proxyReq, (err) => {
      if (err) {
          log(`Request pipeline error: ${err.message}`);
      }
  });
}

// 启动服务器
function startServer(port) {
  if (!TARGET_HOST) {
    console.error('FATAL: TARGET_HOST environment variable is not set.');
    console.error('Please run the server like this:');
    console.error('TARGET_HOST=xxx-xxx.hf.space node server.js');
    process.exit(1); // 退出程序
  }

  const server = http.createServer((req, res) => {
    // --- 新增的健康检查代码 ---
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
      return;
    }
    // 处理 OPTIONS 预检请求
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
            'Access-Control-Max-Age': 86400, // 24 hours
        });
        res.end();
        return;
    }
    handleRequest(req, res);
  });

  // 监听 'upgrade' 事件来处理 WebSocket
  server.on('upgrade', (req, socket, head) => {
    handleWebSocket(req, socket, head);
  });

  server.listen(port, () => {
    log(`Proxy server started on http://localhost:${port}`);
    log(`Targeting -> https://${TARGET_HOST}`);
  });
  
  // 优雅关机
  const shutdown = (signal) => {
      log(`Received ${signal}. Shutting down gracefully...`);
      server.close(() => {
          log('Server closed.');
          process.exit(0);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// 入口
if (require.main === module) {
  const args = process.argv.slice(2);
  let port = PORT;
  const portIndex = args.indexOf('--port');
  if (portIndex > -1 && args[portIndex + 1]) {
      port = parseInt(args[portIndex + 1], 10);
  }
  startServer(port);
}
