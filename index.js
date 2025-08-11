// index.js (Final Version - Manual Implementation)

import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';

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

// 1. HTTP 请求处理 (完全复刻 Deno 的 fetch -> pipe 逻辑)
app.use(async (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const targetUrl = `https://${TARGET_HOST}${url.pathname}${url.search}`;
  
  log(`Proxying HTTP request to: ${targetUrl}`);

  // 构造请求头
  const requestHeaders = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase() !== 'host') { // 排除旧的 host
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
      body: req.method !== 'GET' && req.method !== 'HEAD' ? req : null, // 将请求体流式传输
      redirect: 'follow',
      duplex: 'half' // 关键: 允许在请求中传递流
    });

    // 构造响应头
    const responseHeaders = {};
    proxyResponse.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    responseHeaders['Access-Control-Allow-Origin'] = '*';
    
    // 将目标服务器的响应头和状态码写入我们的响应中
    res.writeHead(proxyResponse.status, responseHeaders);

    // 核心: 将目标服务器的响应体（ReadableStream）直接 pipe 到我们的响应中
    // 这保证了数据流不被修改或缓冲，完美支持 SSE
    proxyResponse.body.pipe(res);

  } catch (error) {
    log(`HTTP Proxy Error: ${error.message}`);
    res.status(502).send(`Proxy Error: ${error.message}`);
  }
});

// 2. WebSocket 请求处理 (完全复刻 Deno 的双向管道逻辑)
server.on('upgrade', (req, clientSocket, head) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const targetUrl = `wss://${TARGET_HOST}${url.pathname}${url.search}`;
  
  log(`Establishing WebSocket connection to: ${targetUrl}`);

  // 创建一个连接到目标服务器的 WebSocket 客户端
  const serverSocket = new WebSocket(targetUrl, {
    // 传递原始请求的头信息
    headers: {
      ...req.headers,
      'Host': TARGET_HOST,
      'Origin': `https://${TARGET_HOST}`
    }
  });

  // 当与目标服务器的连接建立后
  serverSocket.on('open', () => {
    log('Server WebSocket connection opened.');
    // Node.js的`ws`库需要手动处理底层的socket升级
    // 这里我们直接用一个虚拟的WebSocketServer来处理握手
    const wss = new WebSocketServer({ noServer: true });
    wss.handleUpgrade(req, clientSocket, head, (ws) => {
      log('Client WebSocket connection established.');

      // 将客户端消息转发给服务器
      ws.on('message', (message) => {
        if (serverSocket.readyState === WebSocket.OPEN) {
          serverSocket.send(message);
        }
      });
      
      // 将服务器消息转发给客户端
      serverSocket.on('message', (message) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(message);
        }
      });
      
      ws.on('close', () => {
        log('Client WebSocket closed.');
        if (serverSocket.readyState === WebSocket.OPEN) serverSocket.close();
      });
      
      serverSocket.on('close', () => {
        log('Server WebSocket closed.');
        if (ws.readyState === WebSocket.OPEN) ws.close();
      });
      
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
