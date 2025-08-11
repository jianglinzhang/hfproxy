// index.js (Zero-Dependency Native Proxy)

import http from 'http';
import https from 'https';
import { WebSocketServer } from 'ws'; // `ws` 仍然是处理 WebSocket 的最佳选择
import WebSocket from 'ws';

// 从环境变量读取配置
const PORT = process.env.PORT || 8080;
const TARGET_HOST = process.env.TARGET_HOST;

if (!TARGET_HOST) {
  console.error("Error: TARGET_HOST environment variable not set.");
  process.exit(1);
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// 1. 创建 HTTP 服务器
const server = http.createServer((clientReq, clientRes) => {
  // ** 健康检查 **
  if (clientReq.url === '/health' && clientReq.method === 'GET') {
    clientRes.writeHead(200, { 'Content-Type': 'text/plain' });
    clientRes.end('OK');
    return;
  }
  
  log(`Proxying HTTP ${clientReq.method} ${clientReq.url} to ${TARGET_HOST}`);

  // 构造转发请求的选项
  const options = {
    hostname: TARGET_HOST,
    port: 443,
    path: clientReq.url,
    method: clientReq.method,
    headers: { ...clientReq.headers }, // 复制所有头
  };

  // 重写关键头信息，与你的Deno代码逻辑一致
  const isMobile = clientReq.headers['sec-ch-ua-mobile'] === '?1';
  options.headers['user-agent'] = isMobile
    ? "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
    : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  options.headers['host'] = TARGET_HOST;
  options.headers['origin'] = `https://${TARGET_HOST}`;
  
  // 发起 HTTPS 请求
  const proxyReq = https.request(options, (proxyRes) => {
    // 收到目标服务器的响应
    log(`Received response: ${proxyRes.statusCode}`);

    // 将目标服务器的响应头复制到我们的响应中
    const responseHeaders = {
      ...proxyRes.headers,
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
      'Cache-Control': 'no-cache, no-transform',
    };
    clientRes.writeHead(proxyRes.statusCode, responseHeaders);

    // 将目标服务器的响应体（流）直接 pipe 到我们的响应体（流）
    // 这是最核心、最可靠的流式转发
    proxyRes.pipe(clientRes);
  });

  // 处理请求错误
  proxyReq.on('error', (err) => {
    log(`Proxy request error: ${err.message}`);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
    }
    clientRes.end(`Proxy error: ${err.message}`);
  });

  // 将客户端的请求体（流）pipe到我们的请求体（流）
  clientReq.pipe(proxyReq);

});

// 2. WebSocket 升级处理
server.on('upgrade', (req, clientSocket, head) => {
    const targetUrl = `wss://${TARGET_HOST}${req.url}`;
    log(`Upgrading to WebSocket for: ${targetUrl}`);

    const serverSocket = new WebSocket(targetUrl, {
        headers: { ...req.headers, 'Host': TARGET_HOST, 'Origin': `https://${TARGET_HOST}` }
    });

    // 这部分逻辑和之前一样，是标准的双向管道
    serverSocket.on('open', () => {
        const wss = new WebSocketServer({ noServer: true });
        wss.handleUpgrade(req, clientSocket, head, (ws) => {
            ws.on('message', (message) => serverSocket.readyState === WebSocket.OPEN && serverSocket.send(message));
            serverSocket.on('message', (message) => ws.readyState === WebSocket.OPEN && ws.send(message));
            ws.on('close', () => serverSocket.readyState === WebSocket.OPEN && serverSocket.close());
            serverSocket.on('close', () => ws.readyState === WebSocket.OPEN && ws.close());
            ws.on('error', (err) => log(`Client WS error: ${err.message}`));
            serverSocket.on('error', (err) => log(`Server WS error: ${err.message}`));
        });
    });

    serverSocket.on('error', (err) => {
        log(`Target WS connection error: ${err.message}`);
        clientSocket.destroy();
    });
});

// 3. 启动服务器
server.listen(PORT, () => {
  log(`Native proxy server started on port ${PORT}`);
  log(`Proxying requests to ${TARGET_HOST}`);
});
