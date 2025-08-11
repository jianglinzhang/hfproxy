const http = require('http');
const https = require('https');
const { parse } = require('url');
const zlib = require('zlib');

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
  const newHeaders = {};
  
  // 复制所有头部，但排除一些可能导致问题的
  for (const [key, value] of Object.entries(headers)) {
    if (!['connection', 'upgrade', 'host', 'origin'].includes(key.toLowerCase())) {
      newHeaders[key] = value;
    }
  }
  
  // 设置必要的头部
  newHeaders['User-Agent'] = getDefaultUserAgent(isMobile);
  newHeaders['Host'] = TARGET_HOST;
  newHeaders['Origin'] = `https://${TARGET_HOST}`;
  
  return newHeaders;
}

// 处理 HTTP 请求
function handleRequest(req, res) {
  // 设置基本的 CORS 头部
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  // 处理 OPTIONS 预检请求
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  try {
    const url = parse(req.url);
    const targetPath = `${url.pathname || ''}${url.search || ''}`;
    
    log(`${req.method} ${targetPath}`);
    
    // 构建代理请求选项
    const options = {
      hostname: TARGET_HOST,
      port: 443,
      path: targetPath,
      method: req.method,
      headers: transformHeaders(req.headers),
      timeout: 30000
    };
    
    // 创建 HTTPS 请求
    const proxyReq = https.request(options, (targetResponse) => {
      const { statusCode, headers } = targetResponse;
      
      log(`Response: ${statusCode} ${headers['content-type'] || 'unknown'}`);
      
      // 复制响应头，但处理压缩相关的头部
      const responseHeaders = {};
      for (const [key, value] of Object.entries(headers)) {
        // 跳过可能导致问题的头部
        if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
          responseHeaders[key] = value;
        }
      }
      
      // 添加 CORS 头部
      responseHeaders['Access-Control-Allow-Origin'] = '*';
      responseHeaders['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
      responseHeaders['Access-Control-Allow-Headers'] = '*';
      
      // 写入响应状态和头部
      res.writeHead(statusCode, responseHeaders);
      
      // 处理响应体
      let responseStream = targetResponse;
      const encoding = headers['content-encoding'];
      
      // 处理压缩
      try {
        if (encoding === 'gzip') {
          responseStream = targetResponse.pipe(zlib.createGunzip());
        } else if (encoding === 'deflate') {
          responseStream = targetResponse.pipe(zlib.createInflate());
        } else if (encoding === 'br') {
          responseStream = targetResponse.pipe(zlib.createBrotliDecompress());
        }
      } catch (compressionError) {
        log(`Compression handling error: ${compressionError.message}`);
        responseStream = targetResponse; // 回退到原始流
      }
      
      // 流式传输响应
      responseStream.on('data', (chunk) => {
        try {
          res.write(chunk);
        } catch (writeError) {
          log(`Write error: ${writeError.message}`);
        }
      });
      
      responseStream.on('end', () => {
        try {
          res.end();
        } catch (endError) {
          log(`End error: ${endError.message}`);
        }
      });
      
      responseStream.on('error', (streamError) => {
        log(`Response stream error: ${streamError.message}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Stream processing error' }));
        }
      });
    });
    
    // 请求错误处理
    proxyReq.on('error', (error) => {
      log(`Request error: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ error: `Proxy error: ${error.message}` }));
      }
    });
    
    // 请求超时处理
    proxyReq.on('timeout', () => {
      log('Request timeout');
      proxyReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504, { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ error: 'Request timeout' }));
      }
    });
    
    // 处理请求体
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      req.on('data', (chunk) => {
        proxyReq.write(chunk);
      });
      
      req.on('end', () => {
        proxyReq.end();
      });
      
      req.on('error', (reqError) => {
        log(`Request body error: ${reqError.message}`);
        proxyReq.destroy();
      });
    } else {
      proxyReq.end();
    }
    
  } catch (error) {
    log(`Handler error: ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ error: `Server error: ${error.message}` }));
    }
  }
}

// 启动服务器
function startServer(port) {
  log(`Starting server on port ${port}`);
  log(`Target host: ${TARGET_HOST}`);
  
  const server = http.createServer(handleRequest);
  
  // 服务器错误处理
  server.on('error', (error) => {
    log(`Server error: ${error.message}`);
    if (error.code === 'EADDRINUSE') {
      log(`Port ${port} is already in use`);
      process.exit(1);
    }
  });
  
  server.listen(port, '0.0.0.0', () => {
    log(`Proxy server running on http://0.0.0.0:${port}`);
    log(`Proxying to: https://${TARGET_HOST}`);
  });
  
  // 优雅关闭
  const shutdown = (signal) => {
    log(`Received ${signal}, shutting down...`);
    server.close(() => {
      log('Server closed');
      process.exit(0);
    });
  };
  
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  
  return server;
}

// 解析命令行参数
const args = process.argv.slice(2);
let port = DEFAULT_PORT;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = parseInt(args[i + 1], 10);
    break;
  }
}

// 验证端口号
if (isNaN(port) || port < 1 || port > 65535) {
  console.error('Invalid port number');
  process.exit(1);
}

// 环境变量提示
if (!process.env.TARGET_HOST) {
  log('提示: 未设置 TARGET_HOST 环境变量，使用默认值');
}

// 启动服务器
if (require.main === module) {
  try {
    startServer(port);
  } catch (startError) {
    log(`Failed to start server: ${startError.message}`);
    process.exit(1);
  }
}
