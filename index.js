const http = require('http');
const https = require('https');
const { parse } = require('url');
const WebSocket = require('ws');
const zlib = require('zlib');

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
  const newHeaders = { ...headers };
  
  newHeaders['User-Agent'] = getDefaultUserAgent(isMobile);
  newHeaders['Host'] = TARGET_HOST;
  newHeaders['Origin'] = `https://${TARGET_HOST}`;
  
  // 移除可能导致问题的头部
  delete newHeaders['host'];
  delete newHeaders['origin'];
  
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

function handleHttpRequest(req, res) {
  try {
    const url = parse(req.url);
    const targetUrl = `https://${TARGET_HOST}${url.pathname || ''}${url.search || ''}`;
    log(`Proxying HTTP request: ${targetUrl}`);

    const options = {
      method: req.method,
      headers: transformHeaders(req.headers),
    };

    const proxyReq = https.request(targetUrl, options, (proxyRes) => {
      // 复制响应头，但处理压缩相关的头部
      const responseHeaders = { ...proxyRes.headers };
      responseHeaders['Access-Control-Allow-Origin'] = '*';
      
      // 检查是否有压缩
      const encoding = proxyRes.headers['content-encoding'];
      
      if (encoding === 'gzip') {
        // 如果是 gzip 压缩，先解压再发送
        delete responseHeaders['content-encoding'];
        delete responseHeaders['content-length'];
        
        res.writeHead(proxyRes.statusCode, responseHeaders);
        
        const gunzip = zlib.createGunzip();
        proxyRes.pipe(gunzip).pipe(res);
        
        gunzip.on('error', (error) => {
          log(`Gunzip error: ${error.message}`);
          res.end();
        });
      } else if (encoding === 'deflate') {
        // 如果是 deflate 压缩
        delete responseHeaders['content-encoding'];
        delete responseHeaders['content-length'];
        
        res.writeHead(proxyRes.statusCode, responseHeaders);
        
        const inflate = zlib.createInflate();
        proxyRes.pipe(inflate).pipe(res);
        
        inflate.on('error', (error) => {
          log(`Inflate error: ${error.message}`);
          res.end();
        });
      } else if (encoding === 'br') {
        // 如果是 brotli 压缩
        delete responseHeaders['content-encoding'];
        delete responseHeaders['content-length'];
        
        res.writeHead(proxyRes.statusCode, responseHeaders);
        
        const brotli = zlib.createBrotliDecompress();
        proxyRes.pipe(brotli).pipe(res);
        
        brotli.on('error', (error) => {
          log(`Brotli error: ${error.message}`);
          res.end();
        });
      } else {
        // 没有压缩，直接转发
        res.writeHead(proxyRes.statusCode, responseHeaders);
        proxyRes.pipe(res);
      }
    });

    proxyReq.on('error', (error) => {
      log(`Error: ${error.message}`);
      res.writeHead(500);
      res.end(`Proxy Error: ${error.message}`);
    });

    req.pipe(proxyReq);

  } catch (error) {
    log(`Error: ${error.message}`);
    res.writeHead(500);
    res.end(`Proxy Error: ${error.message}`);
  }
}

function startServer(port) {
  log(`Starting proxy server on port ${port}`);
  
  const server = http.createServer(handleHttpRequest);
  const wss = new WebSocket.Server({ noServer: true });

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
