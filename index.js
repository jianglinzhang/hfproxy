const http = require('http');
const https = require('https');
const { parse } = require('url');
const zlib = require('zlib');
const WebSocket = require('ws');
const { pipeline } = require('stream');

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

// 处理数据压缩解压
function handleCompression(response, targetResponse) {
  const encoding = targetResponse.headers['content-encoding'];
  
  if (encoding === 'gzip') {
    return pipeline(targetResponse, zlib.createGunzip(), response, (err) => {
      if (err) log(`Gzip decompression error: ${err.message}`);
    });
  } else if (encoding === 'deflate') {
    return pipeline(targetResponse, zlib.createInflate(), response, (err) => {
      if (err) log(`Deflate decompression error: ${err.message}`);
    });
  } else if (encoding === 'br') {
    return pipeline(targetResponse, zlib.createBrotliDecompress(), response, (err) => {
      if (err) log(`Brotli decompression error: ${err.message}`);
    });
  } else {
    // 无压缩，直接流式传输
    return pipeline(targetResponse, response, (err) => {
      if (err) log(`Stream pipeline error: ${err.message}`);
    });
  }
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
      
      // 处理 304 Not Modified 响应
      if (targetResponse.statusCode === 304) {
        res.writeHead(200, responseHeaders);
        res.end();
        return;
      }
      
      res.writeHead(targetResponse.statusCode, responseHeaders);
      
      // 处理压缩和流式传输
      handleCompression(res, targetResponse);
    });
    
    // 错误处理
    proxyReq.on('error', (error) => {
      log(`Proxy request error: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Proxy Error: ${error.message}`);
      }
    });
    
    // 请求超时处理
    proxyReq.setTimeout(30000, () => {
      log('Proxy request timeout');
      proxyReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'text/plain' });
        res.end('Gateway Timeout');
      }
    });
    
    // 流式传输请求体
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      pipeline(req, proxyReq, (err) => {
        if (err) {
          log(`Request body pipeline error: ${err.message}`);
        }
      });
    } else {
      proxyReq.end();
    }
    
  } catch (error) {
    log(`Request handling error: ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Error: ${error.message}`);
    }
  }
}

// 启动服务器
function startServer(port) {
  const server = http.createServer(handleRequest);
  
  // WebSocket 升级处理
  server.on('upgrade', (req, socket, head) => {
    handleWebSocket(req, socket, head);
  });
  
  // 优雅关闭处理
  process.on('SIGINT', () => {
    log('Received SIGINT, shutting down gracefully...');
    server.close(() => {
      log('Server closed');
      process.exit(0);
    });
  });
  
  process.on('SIGTERM', () => {
    log('Received SIGTERM, shutting down gracefully...');
    server.close(() => {
      log('Server closed');
      process.exit(0);
    });
  });
  
  server.listen(port, () => {
    log(`Starting proxy server on port ${port}`);
    log(`Proxying requests to: ${TARGET_HOST}`);
    log(`Listening on http://localhost:${port}`);
  });
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
