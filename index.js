const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const compression = require('compression');
const cors = require('cors');
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

// --- 3. 添加 CORS 支持 ---
app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept']
}));

// --- 4. 添加压缩支持（智能过滤SSE请求）---
app.use(compression({
    filter: (req, res) => {
        // 不压缩SSE流和WebSocket
        if (req.headers.accept && req.headers.accept.includes('text/event-stream')) {
            return false;
        }
        if (req.headers.upgrade && req.headers.upgrade.includes('websocket')) {
            return false;
        }
        return compression.filter(req, res);
    }
}));

// --- 5. 基础中间件 ---
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// --- 6. 调试日志中间件（可选，生产环境可移除）---
if (process.env.NODE_ENV !== 'production') {
    app.use((req, res, next) => {
        console.log(`[DEBUG] ${new Date().toISOString()} - ${req.method} ${req.url}`);
        if (req.method === 'POST' && req.body) {
            console.log(`[DEBUG] Request body:`, JSON.stringify(req.body).substring(0, 200) + '...');
        }
        next();
    });
}

// --- 7. 健康检查端点 ---
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// --- 8. 智能代理中间件 ---
const smartProxy = createProxyMiddleware({
    target: TARGET_URL,
    changeOrigin: true,
    ws: true, // 支持WebSocket，但不会强制所有请求使用WebSocket
    secure: false,
    xfwd: true,
    logLevel: process.env.NODE_ENV === 'production' ? 'warn' : 'debug',
    
    // 智能处理请求
    onProxyReq: (proxyReq, req, res) => {
        // 自动转发所有请求头
        Object.keys(req.headers).forEach(key => {
            // 跳过一些可能引起问题的头
            if (!['host', 'connection', 'accept-encoding'].includes(key.toLowerCase())) {
                proxyReq.setHeader(key, req.headers[key]);
            }
        });

        // 特殊处理SSE请求
        if (req.headers.accept && req.headers.accept.includes('text/event-stream')) {
            proxyReq.setHeader('Accept-Encoding', 'identity');
            proxyReq.setHeader('Cache-Control', 'no-cache');
        }

        // 处理请求体（自动处理，不需要手动写入）
        // http-proxy-middleware 会自动处理 req.body
    },
    
    // 智能处理响应
    onProxyRes: (proxyRes, req, res) => {
        // 检测SSE响应并设置正确的头
        const contentType = proxyRes.headers['content-type'] || '';
        if (contentType.includes('text/event-stream')) {
            // 设置SSE必需的响应头
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            
            // 移除可能干扰SSE的头
            res.removeHeader('Content-Encoding');
            res.removeHeader('Content-Length');
        }
        
        // 转发所有其他响应头
        Object.keys(proxyRes.headers).forEach(key => {
            if (!['content-length', 'content-encoding'].includes(key.toLowerCase()) || 
                !contentType.includes('text/event-stream')) {
                res.setHeader(key, proxyRes.headers[key]);
            }
        });
    },
    
    // 错误处理
    onError: (err, req, res) => {
        console.error('[Proxy Error]', err);
        if (!res.headersSent) {
            res.status(502).json({
                error: 'Proxy Error',
                message: err.message,
                url: req.url
            });
        }
    }
});

// --- 9. 应用代理 ---
// 所有请求都通过智能代理处理
app.use('/', smartProxy);

// --- 10. 启动服务器 ---
app.listen(PORT, () => {
    console.log(`通用代理服务器已启动，监听端口: ${PORT}`);
    console.log(`目标服务器: ${TARGET_URL}`);
    console.log(`健康检查: /health`);
    console.log(`环境: ${process.env.NODE_ENV || 'development'}`);
});
