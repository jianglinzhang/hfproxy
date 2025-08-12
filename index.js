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

// --- 4. 添加压缩支持（排除SSE流）---
app.use(compression({
    filter: (req, res) => {
        if (req.headers.accept && req.headers.accept.includes('text/event-stream')) {
            return false;
        }
        return compression.filter(req, res);
    }
}));

// --- 5. 请求解析器 ---
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// --- 6. 调试中间件 ---
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url.includes('/auth')) {
        console.log('登录请求体:', JSON.stringify(req.body));
    }
    next();
});

// --- 7. 健康检查端点 ---
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// --- 8. 代理中间件配置 ---
const proxyOptions = {
    target: TARGET_URL,
    changeOrigin: true,
    ws: false, // 默认不启用WebSocket，按需启用
    secure: false,
    buffer: false,
    autoDecompress: false,
    xfwd: true,
    logLevel: 'debug',
    
    // 请求处理
    onProxyReq: (proxyReq, req, res) => {
        // 确保认证头正确传递
        if (req.headers.authorization) {
            proxyReq.setHeader('Authorization', req.headers.authorization);
        }
        
        // 处理SSE请求
        if (req.headers.accept && req.headers.accept.includes('text/event-stream')) {
            proxyReq.setHeader('Accept-Encoding', 'identity');
            proxyReq.setHeader('Cache-Control', 'no-cache');
        }
        
        // 记录重要请求
        if (req.url.includes('/auth') || req.url.includes('/chat')) {
            console.log(`代理请求: ${req.method} ${req.url} -> ${TARGET_URL}${req.url}`);
        }
    },
    
    // 响应处理
    onProxyRes: (proxyRes, req, res) => {
        // 处理SSE响应
        if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
            console.log('检测到SSE响应，设置流式头');
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.removeHeader('Content-Encoding');
            res.removeHeader('Content-Length');
        }
        
        // 处理认证响应
        if (req.url.includes('/auth')) {
            console.log(`认证响应状态: ${proxyRes.statusCode}`);
            if (proxyRes.headers['set-cookie']) {
                console.log('设置Cookie:', proxyRes.headers['set-cookie']);
            }
        }
    },
    
    // 错误处理
    onError: (err, req, res) => {
        console.error(`代理错误: ${req.method} ${req.url}`, err);
        if (!res.headersSent) {
            res.status(502).send('代理错误');
        }
    }
};

// --- 9. 创建代理中间件 ---
const apiProxy = createProxyMiddleware(proxyOptions);

// --- 10. 特殊路径处理 ---
// 登录请求 - 普通HTTP请求
app.post('/api/v1/auths/signin', (req, res, next) => {
    console.log('拦截登录请求:', req.body);
    // 确保登录请求使用普通HTTP代理
    proxyOptions.ws = false;
    next();
}, apiProxy);

// 聊天请求 - 可能使用SSE
app.post('/api/v1/chat/completions', (req, res, next) => {
    console.log('拦截聊天请求');
    // 聊天请求可能需要SSE支持
    if (req.headers.accept?.includes('text/event-stream')) {
        proxyOptions.ws = false; // SSE不是WebSocket
        proxyOptions.buffer = false;
    }
    next();
}, apiProxy);

// WebSocket连接（仅用于实际需要WebSocket的端点）
app.use('/ws', createProxyMiddleware({
    ...proxyOptions,
    ws: true,
    pathRewrite: { '^/ws': '' }
}));

// --- 11. 默认代理 ---
app.use('/', (req, res, next) => {
    // 根据路径动态决定是否启用WebSocket
    if (req.url.startsWith('/ws')) {
        proxyOptions.ws = true;
    } else {
        proxyOptions.ws = false;
    }
    next();
}, apiProxy);

// --- 12. 启动服务器 ---
app.listen(PORT, () => {
    console.log(`代理服务器已启动，监听端口: ${PORT}`);
    console.log(`目标服务器: ${TARGET_URL}`);
    console.log('健康检查: /health');
});
