const http = require('http');
const https = require('https');
const url = require('url');
const WebSocket = require('ws');

const HF_SPACE_URL = process.env.TARGET_HOST || 'https://xxx-fastchat.hf.space';

// 创建 HTTP 服务器
const server = http.createServer((req, res) => {
  // 处理 CORS 预检请求
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    res.end();
    return;
  }

  // 处理普通 HTTP 请求
  const parsedUrl = url.parse(req.url);
  const targetUrl = new URL(parsedUrl.path, HF_SPACE_URL);

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: req.method,
    headers: {
      ...req.headers,
      'Origin': HF_SPACE_URL,
      'Referer': HF_SPACE_URL,
      host: targetUrl.hostname, // 覆盖原始 host 头
    },
  };

  // 根据目标协议选择 http 或 https
  const proxyRequest = (targetUrl.protocol === 'https:' ? https : http).request(options, (proxyRes) => {
    // 设置 CORS 头
    proxyRes.headers['Access-Control-Allow-Origin'] = '*';
    proxyRes.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    proxyRes.headers['Access-Control-Allow-Headers'] = '*';

    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyRequest.on('error', (e) => {
    console.error('Proxy request error:', e);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Error: ' + e.message);
  });

  // 将请求体传递给代理请求
  req.pipe(proxyRequest);
});

// 创建 WebSocket 服务器（不绑定到 HTTP 服务器）
const wss = new WebSocket.Server({ noServer: true });

// 处理 HTTP 服务器的升级事件
server.on('upgrade', (req, socket, head) => {
  // 检查是否是 WebSocket 升级请求
  if (req.headers['upgrade'] === 'websocket') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      // 当 WebSocket 连接建立后，处理连接
      handleWebSocketConnection(ws, req);
    });
  } else {
    // 如果不是 WebSocket 升级，则关闭连接
    socket.destroy();
  }
});

// 处理 WebSocket 连接
function handleWebSocketConnection(ws, req) {
  const parsedUrl = url.parse(req.url);
  // 构建目标 WebSocket URL
  const targetWsUrl = HF_SPACE_URL.replace('https://', 'wss://') + parsedUrl.path;

  // 创建到目标服务器的 WebSocket 连接
  const targetWs = new WebSocket(targetWsUrl, {
    // 忽略证书验证（仅用于开发）
    rejectUnauthorized: false,
  });

  // 处理目标 WebSocket 连接打开
  targetWs.on('open', () => {
    console.log('Connected to target WebSocket');
  });

  // 处理目标 WebSocket 消息
  targetWs.on('message', (data) => {
    try {
      // 处理 Socket.IO 的消息格式（与原代码相同）
      if (typeof data === 'string') {
        if (data.startsWith('data: ')) {
          data = data.substring(6); // 移除 "data: " 前缀
        }
        try {
          const parsed = JSON.parse(data);
          data = JSON.stringify(parsed);
        } catch (parseError) {
          // 如果不是JSON，保持原样
          console.log('Non-JSON message:', data);
        }
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    } catch (error) {
      console.error('Message processing error:', error);
    }
  });

  // 处理目标 WebSocket 关闭
  targetWs.on('close', (code, reason) => {
    console.log('Target WebSocket closed:', code, reason.toString());
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(code, reason);
    }
  });

  // 处理目标 WebSocket 错误
  targetWs.on('error', (error) => {
    console.error('Target WebSocket error:', error);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1011, 'Target connection error');
    }
  });

  // 处理客户端 WebSocket 消息
  ws.on('message', (data) => {
    try {
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(data);
      }
    } catch (error) {
      console.error('Client message error:', error);
    }
  });

  // 处理客户端 WebSocket 关闭
  ws.on('close', (code, reason) => {
    console.log('Client WebSocket closed:', code, reason.toString());
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.close(code, reason);
    }
  });

  // 处理客户端 WebSocket 错误
  ws.on('error', (error) => {
    console.error('Client WebSocket error:', error);
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.close(1011, 'Client connection error');
    }
  });
}

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
