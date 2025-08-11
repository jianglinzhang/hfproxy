const http = require('http');
const https = require('https');
const { parse } = require('url');
const zlib = require('zlib');
const WebSocket = require('ws');
const { pipeline, Transform } = require('stream');

// 配置
const DEFAULT_PORT = process.env.PORT || 8080;
const TARGET_HOST = process.env.TARGET_HOST || 'xxx-xxx.hf.space';

// 日志函数
function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// 获取默认 User-Agent
function getDefaultUserAgent(isMobile = false) {
  if (isMobile) {
    return "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
  } else {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  }
}

// 转换请求头
function transformHeaders(headers) {
  const isMobile = headers['sec-ch-ua-mobile'] === '?1';
  const newHeaders = { ...headers };
  
  // 设置必要的头部
  newHeaders['User-Agent'] = getDefaultUserAgent(isMobile);
  newHeaders['Host'] = TARGET_HOST;
  newHeaders['Origin'] = `https://${TARGET_HOST}`;
  
  // 删除可能导致问题的头部
  delete newHeaders['connection'];
  delete newHeaders['upgrade'];
  
  return newHeaders;
}

// 检查是否为流式响应（SSE）
function isStreamingResponse(headers) {
  const contentType = headers['content-type'] || '';
  return contentType.includes('text/event-stream') || 
         contentType.includes('text/plain') ||
         contentType.includes('application/json');
}

// 创建流式数据处理器
function createStreamProcessor() {
  return new Transform({
    transform(chunk, encoding, callback) {
      try {
        // 直接传递原始数据，不进行 JSON 解析
        callback(null, chunk);
      } catch (error) {
        log(`Stream processing error: ${error.message}`);
        callback(null, chunk); // 即使出错也传递原始数据
      }
    }
  });
}

// 处理 WebSocket 连接
function handleWebSocket(req, socket, head) {
  const url = parse(req.url);
  const targetUrl = `wss://${TARGET_HOST}${url.pathname || ''}${url.search || ''}`;
  
  log(`Establishing WebSocket connection to: ${targetUrl}`);

  const wss = new WebSocket.Server({ noServer: true });
  
  wss.handleUpgrade(req, socket, head, (ws) => {
    try {
      const serverSocket = new WebSocket(targetUrl);
      
      // 客户端到服务器
      ws.on('message', (data) => {
        if (serverSocket.readyState === WebSocket.OPEN) {
          serverSocket.send(data);
        }
      });
      
      // 服务器到客户端
      serverSocket.on('message', (data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });
      
      // 错误处理
      ws.on('error', (error) => {
        log(`Client WebSocket error: ${error.message}`);
        if (serverSocket.readyState === WebSocket.OPEN) {
          serverSocket.close();
        }
      });
      
      serverSocket.on('error', (error) => {
        log(`Server WebSocket error: ${error.message}`);
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      });
      
      // 连接关闭处理
      ws.on('close', () => {
        if (serverSocket.readyState === WebSocket.OPEN) {
          serverSocket.close();
        }
      });
      
      serverSocket.on('close', () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      });
      
    } catch (error) {
      log(`WebSocket connection error: ${error.message}`);
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    }
  });
}

// 处理数据压缩解压和流式传输
function handleResponse(response, targetResponse) {
  const encoding = targetResponse.headers['content-encoding'];
  const isStreaming = isStreamingResponse(targetResponse.headers);
  
  log(`Response encoding: ${encoding || 'none'}, streaming: ${isStreaming}`);
  
  let processStream;
  
  // 解压缩处理
  if (encoding === 'gzip') {
    processStream = targetResponse.pipe(zlib.createGunzip());
  } else if (encoding === 'deflate') {
    processStream = targetResponse.pipe(zlib.createInflate());
  } else if (encoding === 'br') {
    processStream = targetResponse.pipe(zlib.createBrotliDecompress());
  } else {
    processStream = targetResponse;
  }
  
  // 如果是流式响应，添加流处理器
  if (isStreaming) {
    processStream = processStream.pipe(createStreamProcessor());
  }
  
  // 流式传输到响应
  pipeline(processStream, response, (err) => {
    if (err && err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
      log(`Response pipeline error: ${err.message}`);
    }
  });
}

// 处理 HTTP 请求
function handleRequest(req, res) {
  try {
    const url = parse(req.url);
    const targetUrl = `https://${TARGET_HOST}${url.pathname || ''}${url.search || ''}`;
    
    log(`Proxying HTTP request: ${req.method} ${targetUrl}`);
    
    // 构建代理请求选项
    const options = {
      hostname: TARGET_HOST,
      port: 443,
      path: `${url.pathname || ''}${url.search || ''}`,
      method: req.method,
      headers: transformHeaders(req.headers)
    };
    
    // 发起 HTTPS 请求
    const proxyReq = https.request(options, (targetResponse) => {
      // 设置响应头
      const responseHeaders = { ...targetResponse.headers };
      responseHeaders['Access-Control-Allow-Origin'] = '*';
      responseHeaders['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
      responseHeaders['Access-Control-Allow-Headers'] = '*';
      responseHeaders['Access-Control-Allow-Credentials'] = 'true';
      
      // 移除可能导致问题的压缩头部（让浏览器自行处理）
      delete responseHeaders['content-encoding'];
      delete responseHeaders['content-length']; // 流式响应时长度可能变化
      
      // 处理 CORS 预检请求
      if (req.method === 'OPTIONS') {
        res.writeHead(200, responseHeaders);
        res.end();
        return;
      }
      
      // 处理 304 Not Modified 响应
      if (targetResponse.statusCode === 304) {
        res.writeHead(200, responseHeaders);
        res.end();
        return;
      }
      
      log(`Response status: ${targetResponse.statusCode}, content-type: ${targetResponse.headers['content-type']}`);
      
      res.writeHead(targetResponse.statusCode, responseHeaders);
      
      // 处理响应数据
      handleResponse(res, targetResponse);
    });
    
    // 错误处理
    proxyReq.on('error', (error) => {
      log(`Proxy request error: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ error: `Proxy Error: ${error.message}` }));
      }
    });
    
    // 请求超时处理
    proxyReq.setTimeout(60000, () => {
      log('Proxy request timeout');
      proxyReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504, { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ error: 'Gateway Timeout' }));
      }
    });
    
    // 流式传输请求体
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      pipeline(req, proxyReq, (err) => {
        if (err && err.code !== 'EPIPE') {
          log(`Request body pipeline error: ${err.message}`);
        }
      });
    } else {
      proxyReq.end();
    }
    
  } catch (error) {
    log(`Request handling error: ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ error: `Error: ${error.message}` }));
    }
  }
}

// 启动服务器
function startServer(port) {
  const server = http.createServer(handleRequest);
  
  // 设置服务器选项
  server.keepAliveTimeout = 65000; // 65秒
  server.headersTimeout = 66000; // 66秒
  
  // WebSocket 升级处理
  server.on('upgrade', (req, socket, head) => {
    handleWebSocket(req, socket, head);
  });
  
  // 处理未捕获的错误
  server.on('error', (error) => {
    log(`Server error: ${error.message}`);
  });
  
  // 优雅关闭处理
  const gracefulShutdown = (signal) => {
    log(`Received ${signal}, shutting down gracefully...`);
    server.close((err) => {
      if (err) {
        log(`Error during server shutdown: ${err.message}`);
        process.exit(1);
      }
      log('Server closed');
      process.exit(0);
    });
    
    // 强制关闭超时
    setTimeout(() => {
      log('Forcing server shutdown...');
      process.exit(1);
    }, 10000);
  };
  
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  
  // 处理未捕获的异常
  process.on('uncaughtException', (error) => {
    log(`Uncaught Exception: ${error.message}`);
    log(error.stack);
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    log(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
  });
  
  server.listen(port, '0.0.0.0', () => {
    log(`Starting proxy server on port ${port}`);
    log(`Proxying requests to: ${TARGET_HOST}`);
    log(`Listening on http://0.0.0.0:${port}`);
  });
  
  return server;
}

// 命令行参数解析
const args = process.argv.slice(2);
let port = DEFAULT_PORT;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = parseInt(args[i + 1]);
    break;
  }
}

// 环境变量检查
if (!process.env.TARGET_HOST) {
  log('Warning: TARGET_HOST environment variable not set, using default value');
  log('Please set TARGET_HOST environment variable for production use');
}

// 启动服务器
if (require.main === module) {
  startServer(port);
}

module.exports = { startServer };
