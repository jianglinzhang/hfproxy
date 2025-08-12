const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const compression = require('compression');
require('dotenv').config();

// --- 1. 配置 ---
const PORT = process.env.PORT || 3000;
const TARGET_URL = process.env.TARGET_URL;
if (!TARGET_URL) {
    console.error('【严重错误】环境变量 TARGET_URL 未设置！');
    process.exit(1);
}

// --- 2. 创建 Express 应用 ---
const app = express();

// --- 3. 添加压缩支持 ---
app.use(compression({
    filter: (req, res) => {
        // 对SSE流不压缩
        if (req.headers.accept && req.headers.accept.includes('text/event-stream')) {
            return false;
        }
        return compression.filter(req, res);
    }
}));

// --- 4. 中间件：记录所有进入的请求 ---
app.use((req, res, next) => {
    console.log(`[DEBUG-0] 收到请求: ${req.method} ${req.url}`);
    console.log(`[DEBUG-0] 请求头:`, JSON.stringify(req.headers, null, 2));
    next();
});

// --- 5. 【必需】添加 JSON 请求体解析器 ---
app.use(express.json());

// --- 6. 中间件：检查 JSON 解析后的请求体 ---
app.use((req, res, next) => {
    if (req.method === 'POST' || req.method === 'PUT') {
        console.log(`[DEBUG-1] 请求体解析后:`, req.body ? JSON.stringify(req.body) : '无请求体');
    }
    next();
});

// --- 7. 【必需】健康检查端点 ---
app.get('/health', (req, res) => {
    console.log('[DEBUG-HEALTH] 健康检查通过');
    res.status(200).send('OK');
});

// --- 8. 【核心】配置并应用代理中间件 ---
const apiProxy = createProxyMiddleware({
    target: TARGET_URL,
    changeOrigin: true,
    ws: true,
    buffer: false, // 禁用缓冲，支持流式传输
    autoDecompress: false, // 禁用自动解压，避免破坏SSE流
    xfwd: true, // 添加X-Forwarded-*头
    logLevel: 'debug',
    onProxyReq: (proxyReq, req, res) => {
        console.log(`[DEBUG-2] 准备代理请求到: ${TARGET_URL}${req.originalUrl}`);
        console.log(`[DEBUG-2] 代理请求头:`, JSON.stringify(proxyReq.getHeaders(), null, 2));
        
        // 确保SSE请求不被压缩
        if (req.headers.accept && req.headers.accept.includes('text/event-stream')) {
            proxyReq.setHeader('Accept-Encoding', 'identity');
        }
    },
    onProxyRes: (proxyRes, req, res) => {
        console.log(`[DEBUG-3] 收到来自目标的响应，状态码: ${proxyRes.statusCode}`);
        console.log(`[DEBUG-3] 目标响应头:`, JSON.stringify(proxyRes.headers, null, 2));
        
        const originalContentType = proxyRes.headers['content-type'];
        if (originalContentType && originalContentType.includes('text/event-stream')) {
            console.log('[DEBUG-3] 检测到 SSE 流，设置适当的响应头');
            
            // 设置SSE必需的响应头
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no'); // 禁用Nginx缓冲
            
            // 移除可能导致问题的头
            res.removeHeader('Content-Encoding');
            res.removeHeader('Content-Length');
        }
    },
    onError: (err, req, res) => {
        console.error('[DEBUG-ERROR] 代理发生严重错误:', err);
        if (!res.headersSent) {
            res.status(502).send('Proxy Error: ' + err.message);
        }
    }
});

// 将所有其他请求都交给代理处理
app.use('/', apiProxy);

// --- 9. 启动服务器 ---
app.listen(PORT, () => {
    console.log(`代理服务器已启动，正在监听端口: ${PORT}`);
    console.log(`将所有请求代理到: ${TARGET_URL}`);
    console.log(`健康检查端点位于: /health`);
});
