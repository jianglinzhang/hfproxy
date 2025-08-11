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
  
  // 复制原始头部
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'host' && key.toLowerCase() !== 'origin') {
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

  wss.handleUpgrade(req, socket, head, (clientSocket) => {
    try {
      const serverSocket = new WebSocket(targetUrl);

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
        log(`Client WebSocket error: ${error}`);
      });

      serverSocket.on('error', (error) => {
        log(`Server WebSocket error: ${error}`);
      });

      clientSocket.on('close', () => {
        if (serverSocket.readyState === WebSocket.OPEN) {
          serverSocket.close();
        }
      });

      serverSocket.on('close', () => {
        if (clientSocket.readyState === WebSocket.OPEN) {
          clientSocket.close();
        }
      });

    } catch (error) {
      log(`WebSocket connection error: ${error.message}`);
      socket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    }
  });
}

async function handleHttpRequest(req, res) {
  try {
    const url = parse(req.url);
    const targetUrl = `https://${TARGET_HOST}${url.pathname || ''}${url.search || ''}`;
    log(`Proxying HTTP request: ${targetUrl}`);

    // 收集请求体
    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    }

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: transformHeaders(req.headers),
      body: body,
      redirect: 'follow'
    });

    // 设置响应头
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    responseHeaders['Access-Control-Allow-Origin'] = '*';

    res.writeHead(response.status, responseHeaders);

    // node-fetch 自动处理压缩内容，直接获取响应体
    const responseBuffer = await response.buffer();
    res.end(responseBuffer);

  } catch (error) {
    log(`Error: ${error.message}`);
    res.writeHead(500);
    res.end(`Proxy Error: ${error.message}`);
  }
}

function startServer(port) {
  log(`Starting proxy server on port ${port}`);
  
  const server = http.createServer(handleHttpRequest);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    handleWebSocket(req, socket, head, wss);
  });

  server.listen(port, () => {
    log(`Listening on http://localhost:${port}`);
  });
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

startServer(port);
