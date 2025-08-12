const http = require('http');
const https = require('https');
const url = require('url');
const WebSocket = require('ws');

const HF_SPACE_URL = process.env.TARGET_HOST || 'https://xxx-fastchat.hf.space';

// 创建HTTP服务器
const server = http.createServer((req, res) => {
  // 处理CORS预检请求
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    res.end();
    return;
  }

  // 处理普通HTTP请求
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
      host: targetUrl.hostname,
    },
  };

  const proxyRequest = (targetUrl.protocol === 'https:' ? https : http).request(options, (proxyRes) => {
    // 设置CORS头
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

  req.pipe(proxyRequest);
});

// 创建WebSocket服务器
const wss = new WebSocket.Server({ noServer: true });

// 处理HTTP服务器的升级事件
server.on('upgrade', (req, socket, head) => {
  console.log('Upgrade request received:', {
    url: req.url,
    headers: req.headers,
    upgrade: req.headers.upgrade
  });

  // 检查是否是WebSocket升级请求
  if (req.headers['upgrade'] === 'websocket') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleWebSocketConnection(ws, req);
    });
  } else {
    console.log('Not a WebSocket upgrade request, destroying socket');
    socket.destroy();
  }
});

// 处理WebSocket连接
function handleWebSocketConnection(ws, req) {
  const parsedUrl = url.parse(req.url);
  // 构建目标WebSocket URL
  const targetWsUrl = HF_SPACE_URL.replace('https://', 'wss://') + parsedUrl.path;
  
  console.log('Attempting to connect to target WebSocket:', targetWsUrl);

  // 获取客户端请求中的子协议
  const clientProtocol = req.headers['sec-websocket-protocol'];
  let protocols = [];
  let authToken = null;
  
  // 处理Choreo的特殊认证格式
  if (clientProtocol) {
    // 按逗号分割协议
    protocols = clientProtocol.split(',').map(s => s.trim());
    
    // 检查是否包含Choreo认证信息
    const authIndex = protocols.findIndex(p => p === 'choreo-oauth2-token' || p === 'choreo-test-key');
    if (authIndex !== -1 && protocols.length > authIndex + 1) {
      // 提取访问令牌或测试密钥
      authToken = protocols[authIndex + 1];
      console.log('Found Choreo authentication:', protocols[authIndex], authToken);
      
      // 保留认证令牌和子协议
      protocols = protocols.slice(authIndex + 2);
    }
  }
  
  console.log('Client protocols:', protocols);

  // 创建到目标服务器的WebSocket连接
  const targetWsOptions = {
    // 忽略证书验证（仅用于开发）
    rejectUnauthorized: false,
    // 添加必要的头部
    headers: {
      'Origin': HF_SPACE_URL,
      'Referer': HF_SPACE_URL,
      'User-Agent': req.headers['user-agent'] || 'Node.js WebSocket Proxy',
      'Cookie': req.headers['cookie'] || '',
      // 如果有认证令牌，添加到头部
      ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
      // 传递所有原始头部（过滤掉WebSocket特定头部）
      ...Object.fromEntries(
        Object.entries(req.headers).filter(([key]) => 
          !['host', 'upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions'].includes(key.toLowerCase())
        )
      )
    },
  };

  // 如果有子协议，传递它们
  if (protocols.length > 0) {
    targetWsOptions.protocol = protocols;
  }

  // 创建WebSocket连接
  const targetWs = new WebSocket(targetWsUrl, targetWsOptions);

  // 处理目标WebSocket连接打开
  targetWs.on('open', () => {
    console.log('Successfully connected to target WebSocket');
    
    // 如果是Socket.IO连接，发送初始握手包
    if (protocols.includes('socket.io')) {
      console.log('Sending Socket.IO handshake');
      targetWs.send('2probe');
    }
  });

  // 处理目标WebSocket消息
  targetWs.on('message', (data) => {
    try {
      console.log('Received message from target:', data);
      
      // 处理Socket.IO的消息格式
      if (typeof data === 'string') {
        // 处理SSE格式的数据
        if (data.startsWith('data: ')) {
          data = data.substring(6); // 移除 "data: " 前缀
        }
        
        // 处理Socket.IO心跳包
        if (data === '3') {
          // 心跳响应
          if (ws.readyState === WebSocket.OPEN) {
            ws.send('2');
          }
          return;
        }
        
        // 尝试解析并重新格式化消息
        try {
          const parsed = JSON.parse(data);
          data = JSON.stringify(parsed);
        } catch (parseError) {
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

  // 处理目标WebSocket关闭
  targetWs.on('close', (code, reason) => {
    console.log('Target WebSocket closed:', code, reason.toString());
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(code, reason);
    }
  });

  // 处理目标WebSocket错误
  targetWs.on('error', (error) => {
    console.error('Target WebSocket error:', error);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1011, 'Target connection error');
    }
  });

  // 处理客户端WebSocket消息
  ws.on('message', (data) => {
    try {
      console.log('Received message from client:', data);
      
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(data);
      }
    } catch (error) {
      console.error('Client message error:', error);
    }
  });

  // 处理客户端WebSocket关闭
  ws.on('close', (code, reason) => {
    console.log('Client WebSocket closed:', code, reason.toString());
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.close(code, reason);
    }
  });

  // 处理客户端WebSocket错误
  ws.on('error', (error) => {
    console.error('Client WebSocket error:', error);
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.close(1011, 'Client connection error');
    }
  });

  // 设置Socket.IO心跳
  if (protocols.includes('socket.io')) {
    let heartbeatInterval;
    
    targetWs.on('open', () => {
      heartbeatInterval = setInterval(() => {
        if (targetWs.readyState === WebSocket.OPEN) {
          targetWs.send('2'); // 心跳包
        }
      }, 25000);
    });
    
    targetWs.on('close', () => {
      clearInterval(heartbeatInterval);
    });
  }
}

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
