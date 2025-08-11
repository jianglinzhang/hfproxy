const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const compression = require('compression');

// 在本地开发时，加载 .env 文件中的环境变量
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

// --- 3. 启用压缩中间件 ---
app.use(compression({
    filter: (req, res) => {
        // 不压缩 SSE 流
        if (res.getHeader('Content-Type') && res.getHeader('Content-Type').includes('text/event-stream')) {
            return false;
        }
        return compression.filter(req, res);
    }
}));

// --- 中间件：记录所有进入的请求 ---
app.use((req, res, next) => {
    console.log(`[DEBUG-0] 收到请求: ${req.method} ${req.url}`);
    console.log(`[DEBUG-0] 请求头:`, JSON.stringify(req.headers, null, 2));
    next();
});

// --- 4.【必需】添加请求体解析器 ---
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.raw({ limit: '50mb', type: 'application/octet-stream' }));

// --- 中间件：检查解析后的请求体 ---
app.use((req, res, next) => {
    if (req.method === 'POST' || req.method === 'PUT') {
        console.log(`[DEBUG-1] 请求体解析后:`, req.body ? JSON.stringify(req.body) : '无请求体');
    }
    next();
});

// --- 5.【必需】健康检查端点 ---
app.get('/health', (req, res) => {
    console.log('[DEBUG-HEALTH] 健康检查通过');
    res.status(200).send('OK');
});

// --- 6.【核心】配置并应用代理中间件 ---
const apiProxy = createProxyMiddleware({
    target: TARGET_URL,
    changeOrigin: true,
    ws: true, // 支持 WebSocket
    secure: true, // 支持 HTTPS
    followRedirects: true,
    logLevel: 'debug',
    timeout: 300000, // 5分钟超时，适合长时间的SSE连接
    proxyTimeout: 300000,
    
    // 保留原始路径
    pathRewrite: {
        '^/': '/'
    },
    
    onProxyReq: (proxyReq, req, res) => {
        console.log(`[DEBUG-2] 准备代理请求到: ${TARGET_URL}${req.originalUrl}`);
        console.log(`[DEBUG-2] 代理请求头:`, JSON.stringify(proxyReq.getHeaders(), null, 2));
        
        // 确保正确的请求头
        proxyReq.setHeader('Host', new URL(TARGET_URL).host);
        proxyReq.setHeader('Origin', TARGET_URL);
        proxyReq.setHeader('Referer', TARGET_URL);
        
        // 移除可能导致问题的请求头
        proxyReq.removeHeader('x-forwarded-for');
        proxyReq.removeHeader('x-forwarded-proto');
        proxyReq.removeHeader('x-forwarded-host');
        
        if (req.body) {
            console.log('[DEBUG-2] 检测到请求体，将由代理转发。');
        }
    },
    
    onProxyRes: (proxyRes, req, res) => {
        console.log(`[DEBUG-3] 收到来自目标的响应，状态码: ${proxyRes.statusCode}`);
        console.log(`[DEBUG-3] 目标响应头:`, JSON.stringify(proxyRes.headers, null, 2));
        
        const originalContentType = proxyRes.headers['content-type'];
        
        // 处理 SSE 流
        if (originalContentType && originalContentType.includes('text/event-stream')) {
            console.log('[DEBUG-3] 检测到 SSE 流，设置正确的响应头。');
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Headers', 'Cache-Control');
            res.setHeader('X-Accel-Buffering', 'no'); // 禁用 Nginx 缓冲
        }
        
        // 处理 CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
        
        // 移除可能干扰的响应头
        delete proxyRes.headers['x-frame-options'];
        delete proxyRes.headers['content-security-policy'];
    },
    
    onError: (err, req, res) => {
        console.error('[DEBUG-ERROR] 代理发生严重错误:', err.message);
        console.error('[DEBUG-ERROR] 错误堆栈:', err.stack);
        
        if (!res.headersSent) {
            res.status(502).json({
                error: 'Proxy Error',
                message: err.message,
                timestamp: new Date().toISOString()
            });
        }
    }
});

// --- 7. CORS 预检请求处理 ---
app.options('*', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.sendStatus(200);
});

// --- 8. 将所有其他请求都交给代理处理 ---
app.use('/', apiProxy);

// --- 9. 全局错误处理 ---
app.use((err, req, res, next) => {
    console.error('[GLOBAL-ERROR] 未捕获的错误:', err);
    if (!res.headersSent) {
        res.status(500).json({
            error: 'Internal Server Error',
            message: err.message
        });
    }
});

// --- 10. 启动服务器 ---
const server = app.listen(PORT, () => {
    console.log(`代理服务器已启动，正在监听端口: ${PORT}`);
    console.log(`将所有请求代理到: ${TARGET_URL}`);
    console.log(`健康检查端点位于: /health`);
});

// --- 11. 优雅关闭处理 ---
process.on('SIGTERM', () => {
    console.log('收到 SIGTERM 信号，准备优雅关闭...');
    server.close(() => {
        console.log('服务器已关闭');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('收到 SIGINT 信号，准备优雅关闭...');
    server.close(() => {
        console.log('服务器已关闭');
        process.exit(0);
    });
});

module.exports = app;
