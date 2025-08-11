import http from 'http';
import { parse } from 'url';
import fetch from 'node-fetch';
import WebSocket, { WebSocketServer } from 'ws';

const DEFAULT_PORT = 8080;
const TARGET_HOST = process.env.TARGET_HOST || 'xxx-xxx.hf.space';

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function getDefaultUserAgent(isMobile = false) {
  if (isMobile) {
    return "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
  } else {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  }
}

function transformHeaders(headers) {
  const isMobile = headers['sec-ch-ua-mobile'] === '?1';
  const newHeaders = {};
  
  // 复制原始头部，排除可能冲突的头部
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey !== 'host' && lowerKey !== 'origin' && 
        lowerKey !== 'connection' && lowerKey !== 'upgrade' &&
        lowerKey !== 'sec-websocket-key' && lowerKey !== 'sec-websocket-version') {
      newHeaders[key] = value;
    }
  }
  
  newHeaders['User-Agent'] = getDefaultUserAgent(isMobile);
  newHeaders['Host'] = TARGET_HOST;
  newHeaders['Origin'] = `https://${TARGET_HOST}`;
  
  return newHeaders;
}

function handleWebSocket(req, socket, head, wss) {
  const url = parse(req.url);
  const targetUrl = `wss://${TARGET_HOST}${url.pathname || ''}${url.search || ''}`;
  log(`Establishing WebSocket connection to: ${targetUrl}`);

  try {
    wss.handleUpgrade(req, socket, head, (clientSocket) => {
      try {
        const serverSocket = new WebSocket(targetUrl);

        const cleanup = () => {
          try {
            if (serverSocket.readyState === WebSocket.OPEN) {
              serverSocket.close();
            }
            if (clientSocket.readyState === WebSocket.OPEN) {
              clientSocket.close();
            }
          } catch (e) {
            log(`Cleanup error: ${e.message}`);
          }
        };

        clientSocket.on('message', (data) => {
          if (serverSocket.readyState === WebSocket.OPEN) {
            serverSocket.send(data);
          }
        });

        serverSocket.on('message', (data) => {
          if (clientSocket.readyState === WebSocket.OPEN) {
            clientSocket.send(data);
          }
        });

        clientSocket.on('error', (error) => {
          log(`Client WebSocket error: ${error.message}`);
          cleanup();
        });

        serverSocket.on('error', (error) => {
          log(`Server WebSocket error: ${error.message}`);
          cleanup();
        });

        clientSocket.on('close', cleanup);
        serverSocket.on('close', cleanup);

      } catch (error) {
        log(`Inner WebSocket error: ${error.message}`);
      }
    });
  } catch (error) {
    log(`WebSocket connection error: ${error.message}`);
    try {
      socket.destroy();
    } catch (e) {
      // ignore
    }
  }
}

async function handleHttpRequest(req, res) {
  try {
    const url = parse(req.url);
    const targetUrl = `https://${TARGET_HOST}${url.pathname || ''}${url.search || ''}`;
    log(`Proxying HTTP request: ${req.method} ${targetUrl}`);

    // 收集请求体
    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try {
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        if (chunks.length > 0) {
          body = Buffer.concat(chunks);
        }
      } catch (bodyError) {
        log(`Body reading error: ${bodyError.message}`);
      }
    }

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: transformHeaders(req.headers),
      body: body,
      redirect: 'follow',
      timeout: 30000, // 30秒超时
    });

    // 设置响应头
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    responseHeaders['Access-Control-Allow-Origin'] = '*';
    responseHeaders['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    responseHeaders['Access-Control-Allow-Headers'] = '*';

    res.writeHead(response.status, responseHeaders);

    // 使用流式传输而不是一次性读取所有内容
    if (response.body) {
      response.body.pipe(res);
    } else {
      res.end();
    }

  } catch (error) {
    log(`HTTP Error: ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Proxy Error: ${error.message}`);
    }
  }
}

function startServer(port) {
  log(`Starting proxy server on port ${port} for target: ${TARGET_HOST}`);
  
  const server = http.createServer((req, res) => {
    // 添加错误处理
    req.on('error', (err) => {
      log(`Request error: ${err.message}`);
    });
    
    res.on('error', (err) => {
      log(`Response error: ${err.message}`);
    });

    handleHttpRequest(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', (err) => {
      log(`Socket error: ${err.message}`);
    });
    handleWebSocket(req, socket, head, wss);
  });

  server.on('error', (err) => {
    log(`Server error: ${err.message}`);
    process.exit(1);
  });

  // 优雅关闭
  process.on('SIGINT', () => {
    log('Received SIGINT, shutting down gracefully');
    server.close(() => {
      log('Server closed');
      process.exit(0);
    });
  });

  process.on('SIGTERM', () => {
    log('Received SIGTERM, shutting down gracefully');
    server.close(() => {
      log('Server closed');
      process.exit(0);
    });
  });

  server.listen(port, '0.0.0.0', () => {
    log(`Server listening on http://0.0.0.0:${port}`);
    log(`Proxy target: https://${TARGET_HOST}`);
  });

  return server;
}

// 解析命令行参数
const args = process.argv.slice(2);
let port = DEFAULT_PORT;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = Number(args[i + 1]);
    break;
  }
}

// 验证端口号
if (isNaN(port) || port < 1 || port > 65535) {
  console.error('Invalid port number');
  process.exit(1);
}

// 检查目标主机
if (!TARGET_HOST || TARGET_HOST === 'xxx-xxx.hf.space') {
  log('Warning: TARGET_HOST not set or using default placeholder');
  log('Set TARGET_HOST environment variable to your actual Hugging Face space');
}

startServer(port);
