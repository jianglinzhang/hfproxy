const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const url = require('url');

const app = express();
const PORT = process.env.PORT || 3000;
const TARGET_HOST = process.env.TARGET_HOST;

if (!TARGET_HOST) {
  console.error('❌ 错误: TARGET_HOST 环境变量未设置');
  process.exit(1);
}

console.log(`�� 目标服务器: ${TARGET_HOST}`);

// 创建HTTP服务器
const server = http.createServer(app);

// 解析目标主机URL
const targetUrl = new URL(TARGET_HOST);
const wsTarget = TARGET_HOST.replace('https://', 'wss://').replace('http://', 'ws://');

// 健康检查函数
async function checkTargetHealth() {
  return new Promise((resolve) => {
    const options = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      path: '/',
      method: 'HEAD',
      timeout: 10000,
      headers: {
        'User-Agent': 'Health-Check/1.0'
      }
    };

    const client = targetUrl.protocol === 'https:' ? https : http;
    
    const req = client.request(options, (res) => {
      console.log(`✅ 目标服务器健康状态: ${res.statusCode}`);
      resolve(true);
    });

    req.on('error', (err) => {
      console.error(`❌ 目标服务器不可达: ${err.message}`);
      resolve(false);
    });

    req.on('timeout', () => {
      console.error('❌ 目标服务器响应超时');
      req.destroy();
      resolve(false);
    });

    req.end();
  });
}

// 中间件：解析JSON和处理CORS
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// 健康检查端点
app.get('/health', async (req, res) => {
  const isTargetHealthy = await checkTargetHealth();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    target: TARGET_HOST,
    target_healthy: isTargetHealthy
  });
});

// HTTP代理中间件 - 增强版
const httpProxy = createProxyMiddleware({
  target: TARGET_HOST,
  changeOrigin: true,
  ws: false,
  timeout: 30000,
  proxyTimeout: 30000,
  
  // 自定义代理逻辑
  router: (req) => {
    return TARGET_HOST;
  },
  
  onProxyReq: (proxyReq, req, res) => {
    // 设置正确的请求头
    proxyReq.setHeader('Host', targetUrl.host);
    proxyReq.setHeader('Origin', TARGET_HOST);
    proxyReq.setHeader('Referer', TARGET_HOST);
    
    // 保持原始IP信息
    if (req.ip) {
      proxyReq.setHeader('X-Real-IP', req.ip);
      proxyReq.setHeader('X-Forwarded-For', req.ip);
    }
    
    // 如果是POST/PUT请求，确保正确处理body
    if (req.body && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')) {
      const bodyData = JSON.stringify(req.body);
      proxyReq.setHeader('Content-Type', 'application/json');
      proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
      proxyReq.write(bodyData);
    }
  },
  
  onProxyRes: (proxyRes, req, res) => {
    // 确保响应头包含CORS
    proxyRes.headers['access-control-allow-origin'] = '*';
    proxyRes.headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS, PATCH';
    proxyRes.headers['access-control-allow-headers'] = '*';
    proxyRes.headers['access-control-allow-credentials'] = 'true';
    
    console.log(`�� ${req.method} ${req.path} -> ${proxyRes.statusCode}`);
  },
  
  onError: (err, req, res) => {
    console.error(`❌ HTTP代理错误 [${req.method} ${req.path}]:`, err.message);
    
    // 返回详细错误信息
    if (!res.headersSent) {
      res.status(502).json({
        error: 'Proxy Error',
        message: err.message,
        target: TARGET_HOST,
        timestamp: new Date().toISOString(),
        suggestion: '请检查目标服务器是否正常运行'
      });
    }
  }
});

// 应用HTTP代理到所有路由（除了健康检查）
app.use((req, res, next) => {
  if (req.path === '/health') {
    next();
  } else {
    httpProxy(req, res, next);
  }
});

// WebSocket服务器 - 增强版
const wss = new WebSocket.Server({ 
  server,
  verifyClient: (info) => {
    console.log(`�� WebSocket连接请求: ${info.req.url}`);
    return true;
  }
});

// WebSocket连接处理
wss.on('connection', (clientWs, request) => {
  const clientIP = request.headers['x-forwarded-for'] || request.connection.remoteAddress;
  console.log(`�� 客户端WebSocket连接建立 [${clientIP}]`);
  
  // 解析请求URL
  const parsedUrl = url.parse(request.url);
  const targetWsUrl = wsTarget + (parsedUrl.pathname || '') + (parsedUrl.search || '');
  
  console.log(`�� 连接目标WebSocket: ${targetWsUrl}`);
  
  let targetWs;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 3;
  
  function connectToTarget() {
    try {
      targetWs = new WebSocket(targetWsUrl, {
        headers: {
          'Origin': TARGET_HOST,
          'Referer': TARGET_HOST,
          'User-Agent': request.headers['user-agent'] || 'WebSocket-Proxy/1.0',
          'Host': targetUrl.host
        },
        handshakeTimeout: 10000
      });

      // 目标WebSocket连接打开
      targetWs.on('open', () => {
        console.log('✅ 目标WebSocket连接成功');
        reconnectAttempts = 0;
      });

      // 目标WebSocket消息转发到客户端
      targetWs.on('message', (data, isBinary) => {
        try {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data, { binary: isBinary });
          }
        } catch (error) {
          console.error('❌ 消息转发错误:', error.message);
        }
      });

      // 处理目标WebSocket关闭
      targetWs.on('close', (code, reason) => {
        console.log(`�� 目标WebSocket关闭: ${code} ${reason}`);
        
        // 如果是非正常关闭且重连次数未达上限，尝试重连
        if (code !== 1000 && reconnectAttempts < maxReconnectAttempts) {
          reconnectAttempts++;
          console.log(`�� 尝试重连 (${reconnectAttempts}/${maxReconnectAttempts})...`);
          setTimeout(() => {
            if (clientWs.readyState === WebSocket.OPEN) {
              connectToTarget();
            }
          }, 2000 * reconnectAttempts);
        } else {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(code, reason);
          }
        }
      });

      // 处理目标WebSocket错误
      targetWs.on('error', (error) => {
        console.error('❌ 目标WebSocket错误:', error.message);
        
        if (reconnectAttempts < maxReconnectAttempts) {
          reconnectAttempts++;
          console.log(`�� 连接失败，尝试重连 (${reconnectAttempts}/${maxReconnectAttempts})...`);
          setTimeout(() => {
            if (clientWs.readyState === WebSocket.OPEN) {
              connectToTarget();
            }
          }, 2000 * reconnectAttempts);
        } else {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(1011, 'Target connection failed');
          }
        }
      });

    } catch (error) {
      console.error('❌ WebSocket创建错误:', error.message);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(1011, 'Setup error');
      }
    }
  }

  // 初始连接
  connectToTarget();

  // 处理客户端消息
  clientWs.on('message', (data, isBinary) => {
    try {
      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(data, { binary: isBinary });
      } else {
        console.log('⚠️ 目标WebSocket未就绪，消息暂存或丢弃');
      }
    } catch (error) {
      console.error('❌ 客户端消息转发错误:', error.message);
    }
  });

  // 处理客户端连接关闭
  clientWs.on('close', (code, reason) => {
    console.log(`�� 客户端WebSocket关闭: ${code} ${reason}`);
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
      targetWs.close(code, reason);
    }
  });

  // 处理客户端错误
  clientWs.on('error', (error) => {
    console.error('❌ 客户端WebSocket错误:', error.message);
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
      targetWs.close(1011, 'Client connection error');
    }
  });

  // 定期ping保持连接
  const pingInterval = setInterval(() => {
    if (clientWs.readyState === WebSocket.OPEN) {
      try {
        clientWs.ping();
      } catch (error) {
        clearInterval(pingInterval);
      }
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);
});

// 启动前检查目标服务器
async function startServer() {
  console.log('�� 检查目标服务器状态...');
  
  const isHealthy = await checkTargetHealth();
  if (!isHealthy) {
    console.warn('⚠️ 警告: 目标服务器似乎不可达，但服务器仍将启动');
  }
  
  server.listen(PORT, '0.0.0.0', () => {
    console.log('�� WebSocket代理服务器启动成功!');
    console.log(`�� 监听端口: ${PORT}`);
    console.log(`�� 代理目标: ${TARGET_HOST}`);
    console.log(`�� 健康检查: http://localhost:${PORT}/health`);
    console.log(`�� WebSocket端点: ws://localhost:${PORT}`);
  });
}

// 优雅关闭处理
function gracefulShutdown(signal) {
  console.log(`�� 收到${signal}信号，正在优雅关闭服务器...`);
  
  server.close((err) => {
    if (err) {
      console.error('❌ 服务器关闭错误:', err);
      process.exit(1);
    }
    console.log('✅ 服务器已关闭');
    process.exit(0);
  });
  
  // 强制关闭超时
  setTimeout(() => {
    console.error('⏰ 强制关闭服务器');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 启动服务器
startServer();
