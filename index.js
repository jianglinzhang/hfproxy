const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const url = require('url');
const zlib = require('zlib');

// 从环境变量获取目标主机，提高安全性
const TARGET_HOST = process.env.TARGET_HOST || 'xxx-xxx.hf.space';
const DEFAULT_PORT = process.env.PORT || 8080;

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
  const isMobile = headers['sec-ch-ua-mobile'] === "?1";
  const newHeaders = {};
  
  // 复制原始头部
  for (const [key, value] of Object.entries(headers)) {
    newHeaders[key] = value;
  }
  
  // 更新特定头部
  newHeaders['User-Agent'] = getDefaultUserAgent(isMobile);
  newHeaders['Host'] = TARGET_HOST;
  newHeaders['Origin'] = `https://${TARGET_HOST}`;
  
  // 删除一些可能导致问题的头部
  delete newHeaders['content-length'];
  
  return newHeaders;
}

function handleWebSocket(req, socket, head) {
  const parsedUrl = url.parse(req.url);
  const targetUrl = `wss://${TARGET_HOST}${parsedUrl.pathname}${parsedUrl.search}`;
  
  log(`Establishing WebSocket connection to: ${targetUrl}`);
  
  try {
    // 设置 WebSocket 客户端选项
    const wsOptions = {
      headers: {
        ...transformHeaders(req.headers),
        'Connection': 'Upgrade',
        'Upgrade': 'websocket'
      }
    };
    
    const wss = new WebSocket(targetUrl, [], wsOptions);
    
    wss.on('open', () => {
      // 发送初始握手数据
      if (head && head.length > 0) {
        wss.send(head, { binary: true });
      }
      
      // 建立双向数据传输
      socket.on('data', (data) => {
        if (wss.readyState === WebSocket.OPEN) {
          wss.send(data, { binary: data instanceof Buffer });
        }
      });
      
      wss.on('message', (data, isBinary) => {
        if (socket.readyState === 'open') {
          socket.write(data);
        }
      });
      
      // 处理错误
      socket.on('error', (error) => {
        log(`Client WebSocket error: ${error.message}`);
      });
      
      wss.on('error', (error) => {
        log(`Server WebSocket error: ${error.message}`);
      });
      
      // 处理关闭
      socket.on('close', (hadError) => {
        log(`Client WebSocket closed, hadError: ${hadError}`);
        if (wss.readyState === WebSocket.OPEN) {
          wss.close();
        }
      });
      
      wss.on('close', (code, reason) => {
        log(`Server WebSocket closed, code: ${code}, reason: ${reason}`);
        if (socket.readyState === 'open') {
          socket.end();
        }
      });
    });
    
    wss.on('error', (error) => {
      log(`WebSocket connection error: ${error.message}`);
      socket.end(`HTTP/1.1 500 WebSocket Error: ${error.message}\r\n\r\n`);
    });
    
    wss.on('unexpected-response', (request, response) => {
      log(`WebSocket unexpected response: ${response.statusCode}`);
      socket.end(`HTTP/1.1 ${response.statusCode} WebSocket Error\r\n\r\n`);
    });
  } catch (error) {
    log(`WebSocket setup error: ${error.message}`);
    socket.end(`HTTP/1.1 500 WebSocket Setup Error: ${error.message}\r\n\r\n`);
  }
}

async function handleRequest(req, res) {
  try {
    const parsedUrl = url.parse(req.url);
    const targetUrl = `https://${TARGET_HOST}${parsedUrl.pathname}${parsedUrl.search}`;
    
    log(`Proxying HTTP request: ${targetUrl}`);
    
    // 准备代理请求选项
    const options = {
      hostname: TARGET_HOST,
      port: 443,
      path: parsedUrl.pathname + (parsedUrl.search || ''),
      method: req.method,
      headers: transformHeaders(req.headers)
    };
    
    // 创建代理请求
    const proxyReq = https.request(options, (proxyRes) => {
      // 处理压缩数据
      const contentEncoding = proxyRes.headers['content-encoding'];
      
      // 设置响应头
      const responseHeaders = { ...proxyRes.headers };
      responseHeaders['Access-Control-Allow-Origin'] = '*';
      
      // 删除可能导致问题的头部
      delete responseHeaders['content-length'];
      
      // 如果有压缩，删除压缩头，因为我们会在代理中解压缩
      if (contentEncoding === 'gzip' || contentEncoding === 'deflate') {
        delete responseHeaders['content-encoding'];
      }
      
      res.writeHead(proxyRes.statusCode, responseHeaders);
      
      // 处理压缩数据，避免页面乱码和304问题
      if (contentEncoding === 'gzip') {
        const gunzip = zlib.createGunzip();
        proxyRes.pipe(gunzip).pipe(res);
      } else if (contentEncoding === 'deflate') {
        const inflate = zlib.createInflate();
        proxyRes.pipe(inflate).pipe(res);
      } else {
        // 流式传输响应，支持OpenWebUI
        proxyRes.pipe(res);
      }
    });
    
    // 处理错误
    proxyReq.on('error', (error) => {
      log(`Proxy request error: ${error.message}`);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Proxy Error: ${error.message}`);
    });
    
    // 流式传输请求体
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
  } catch (error) {
    log(`Error: ${error.message}`);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Proxy Error: ${error.message}`);
  }
}

function startServer(port) {
  log(`Starting proxy server on port ${port}`);
  
  const server = http.createServer((req, res) => {
    handleRequest(req, res);
  });
  
  // 处理 WebSocket 升级
  server.on('upgrade', (req, socket, head) => {
    handleWebSocket(req, socket, head);
  });
  
  server.listen(port, () => {
    log(`Listening on http://localhost:${port}`);
  });
}

// 解析命令行参数
function parseArgs() {
  const args = process.argv.slice(2);
  const parsedArgs = {};
  
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].substring(2);
      const nextArg = args[i + 1];
      
      if (nextArg && !nextArg.startsWith('--')) {
        parsedArgs[key] = nextArg;
        i++;
      } else {
        parsedArgs[key] = true;
      }
    }
  }
  
  return parsedArgs;
}

// 主函数
function main() {
  const parsedArgs = parseArgs();
  const port = parsedArgs.port ? Number(parsedArgs.port) : DEFAULT_PORT;
  startServer(port);
}

// 运行主函数
if (require.main === module) {
  main();
}
