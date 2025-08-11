// index.js (Final Version v2 - Correct Stream Handling)

import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
// 关键: 导入 Readable 用于流类型转换
import { Readable } from 'stream';

// 从环境变量读取配置
const PORT = process.env.PORT || 8080;
const TARGET_HOST = process.env.TARGET_HOST;

if (!TARGET_HOST) {
  console.error("Error: TARGET_HOST environment variable not set.");
  process.exit(1);
}

const app = express();
const server = http.createServer(app);

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function getDefaultUserAgent(headers) {
  const isMobile = headers['sec-ch-ua-mobile'] === '?1';
  if (isMobile) {
    return "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
  } else {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  }
}

// HTTP 请求处理
app.use(async (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const targetUrl = `https://${TARGET_HOST}${url.pathname}${url.search}`;
  
  log(`Proxying HTTP request to: ${targetUrl}`);

  const requestHeaders = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase() !== 'host') {
          requestHeaders.set(key, value);
      }
  }
  requestHeaders.set('User-Agent', getDefaultUserAgent(req.headers));
  requestHeaders.set('Host', TARGET_HOST);
  requestHeaders.set('Origin', `https://${TARGET_HOST}`);

  try {
    const proxyResponse = await fetch(targetUrl, {
      method: req.method,
      headers: requestHeaders,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? req : null,
      redirect: 'follow',
      duplex: 'half'
    });

    const responseHeaders = {};
    proxyResponse.headers.forEach((value, key) => {
      // 解决某些 huggingface space 会强制返回 gzip 的问题，让其自然传输
      if (key.toLowerCase() !== 'content-encoding') {
        responseHeaders[key] = value;
      }
    });
    responseHeaders['Access-Control-Allow-Origin'] = '*';
    // 强制禁用所有代理和浏览器的缓冲，对SSE至关重要
    responseHeaders['Cache-Control'] = 'no-cache, no-transform';
    responseHeaders['X-Accel-Buffering'] = 'no';
    
    res.writeHead(proxyResponse.status, responseHeaders);

    // *** 核心修正 ***
    // 将 Web-standard ReadableStream 转换为 Node.js Readable stream
    // 然后再 pipe 到 express 的 response 对象
    if (proxyResponse.body) {
      const nodeStream = Readable.fromWeb(proxyResponse.body);
      nodeStream.pipe(res);
    } else {
      res.end();
    }

  } catch (error) {
    log(`HTTP Proxy Error: ${error.message}`);
    // 只有在还没有发送任何内容给客户端时才发送错误
    if (!res.headersSent) {
      res.status(502).send(`Proxy Error: ${error.message}`);
    }
  }
});

// WebSocket 请求处理 (这部分逻辑是正确的，无需修改)
server.on('upgrade', (req, clientSocket, head) => {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const targetUrl = `wss://${TARGET_HOST}${url.pathname}${url.search}`;
    log(`Establishing WebSocket connection to: ${targetUrl}`);
    const serverSocket = new WebSocket(targetUrl, {
        headers: { ...req.headers, 'Host': TARGET_HOST, 'Origin': `https://${TARGET_HOST}` }
    });
    serverSocket.on('open', () => {
        log('Server WebSocket connection opened.');
        const wss = new WebSocketServer({ noServer: true });
        wss.handleUpgrade(req, clientSocket, head, (ws) => {
            log('Client WebSocket connection established.');
            ws.on('message', (message) => serverSocket.readyState === WebSocket.OPEN && serverSocket.send(message));
            serverSocket.on('message', (message) => ws.readyState === WebSocket.OPEN && ws.send(message));
            ws.on('close', () => { log('Client WebSocket closed.'); serverSocket.readyState === WebSocket.OPEN && serverSocket.close(); });
            serverSocket.on('close', () => { log('Server WebSocket closed.'); ws.readyState === WebSocket.OPEN && ws.close(); });
            ws.on('error', (err) => log(`Client WebSocket error: ${err.message}`));
            serverSocket.on('error', (err) => log(`Server WebSocket error: ${err.message}`));
        });
    });
    serverSocket.on('error', (err) => {
        log(`Failed to connect to target WebSocket: ${err.message}`);
        clientSocket.destroy();
    });
});

// 启动服务器
server.listen(PORT, () => {
  log(`Manual proxy server started on port ${PORT}`);
  log(`Proxying all requests to ${TARGET_HOST}`);
});
