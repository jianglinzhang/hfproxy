const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const compression = require('compression');
const cors = require('cors');
require('dotenv').config();

// --- 1. 配置 ---
const PORT = process.env.PORT || 3000;
const TARGET_URL = process.env.TARGET_URL;
const NODE_ENV = process.env.NODE_ENV || 'development';

if (!TARGET_URL) {
    console.error('【严重错误】环境变量 TARGET_URL 未设置！');
    process.exit(1);
}

console.log(`[INFO] 运行环境: ${NODE_ENV}`);
console.log(`[INFO] 目标URL: ${TARGET_URL}`);

// --- 2. 创建 Express 应用 ---
const app = express();

// --- 3. 开发环境特定配置 ---
if (NODE_ENV === 'development') {
    // 开发环境启用详细日志
    app.use((req, res, next) => {
        console.log(`[DEBUG] ${new Date().toISOString()} - ${req.method} ${req.url}`);
        console.log(`[DEBUG] 请求头:`, JSON.stringify(req.headers, null, 2));
        next();
    });
    
    // 开发环境禁用压缩以便调试
    console.log('[INFO] 开发模式: 禁用压缩以便调试');
} else {
    // 生产环境启用压缩（排除SSE流）
    app.use(compression({
        filter: (req, res) => {
            if (req.headers.accept && req.headers.accept.includes('text/event-stream')) {
                return false;
            }
            return compression.filter(req, res);
        }
    }));
}

// --- 4. CORS 配置 ---
app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Cookie']
}));

// --- 5. 请求体解析 ---
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// --- 6. 开发环境请求体日志 ---
if (NODE_ENV === 'development') {
    app.use((req, res, next) => {
        if (req.method === 'POST' || req.method === 'PUT') {
            console.log(`[DEBUG] 请求体:`, req.body ? JSON.stringify(req.body).substring(0, 500) + '...' : '无请求体');
        }
        next();
    });
}

// --- 7. 健康检查端点 ---
app.get('/health', (req, res) => {
    console.log('[DEBUG] 健康检查通过');
    res.status(200).send('OK');
});

// --- 8. 代理中间件配置 ---
const apiProxy = createProxyMiddleware({
    target: TARGET_URL,
    changeOrigin: true,
    ws: true,
    secure: false,
    buffer: false,
    autoDecompress: false,
    xfwd: true,
    logLevel: NODE_ENV === 'development' ? 'debug' : 'info',
    
    // 处理代理请求
    onProxyReq: (proxyReq, req, res) => {
        console.log(`[DEBUG] 代理请求: ${req.method} ${TARGET_URL}${req.originalUrl}`);
        
        // 转发认证头
        if (req.headers.authorization) {
            proxyReq.setHeader('Authorization', req.headers.authorization);
        }
        
        // 转发Cookie
        if (req.headers.cookie) {
            proxyReq.setHeader('Cookie', req.headers.cookie);
        }
        
        // SSE请求特殊处理
        if (req.headers.accept && req.headers.accept.includes('text/event-stream')) {
            proxyReq.setHeader('Accept-Encoding', 'identity');
            proxyReq.setHeader('Cache-Control', 'no-cache');
        }
        
        // 开发环境详细日志
        if (NODE_ENV === 'development') {
            console.log(`[DEBUG] 代理请求头:`, JSON.stringify(proxyReq.getHeaders(), null, 2));
        }
    },
    
    // 处理代理响应
    onProxyRes: (proxyRes, req, res) => {
        console.log(`[DEBUG] 代理响应: ${proxyRes.statusCode} ${req.method} ${req.originalUrl}`);
        
        // 开发环境详细日志
        if (NODE_ENV === 'development') {
            console.log(`[DEBUG] 代理响应头:`, JSON.stringify(proxyRes.headers, null, 2));
        }
        
        // SSE流特殊处理
        const contentType = proxyRes.headers['content-type'];
        if (contentType && contentType.includes('text/event-stream')) {
            console.log('[DEBUG] 检测到SSE流，设置响应头');
            
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            
            // 移除可能干扰SSE的头
            res.removeHeader('Content-Encoding');
            res.removeHeader('Content-Length');
        }
        
        // 转发Cookie
        if (proxyRes.headers['set-cookie']) {
            const cookies = proxyRes.headers['set-cookie'];
            res.setHeader('Set-Cookie', cookies);
            console.log('[DEBUG] 转发Cookie:', cookies);
        }
    },
    
    // 错误处理
    onError: (err, req, res) => {
        console.error('[ERROR] 代理错误:', err);
        
        if (NODE_ENV === 'development') {
            console.error('[ERROR] 错误堆栈:', err.stack);
        }
        
        if (!res.headersSent) {
            res.status(502).send(
                NODE_ENV === 'development' 
                    ? `代理错误: ${err.message}\n${err.stack}` 
                    : '代理错误'
            );
        }
    }
});

// --- 9. 登录请求特殊处理 ---
app.post('/api/v1/auths/signin', (req, res, next) => {
    console.log('[DEBUG] 拦截登录请求:', req.body);
    
    // 确保登录请求有正确的Content-Type
    if (!req.headers['content-type'] || !req.headers['content-type'].includes('application/json')) {
        req.headers['content-type'] = 'application/json';
    }
    
    next();
}, apiProxy);

// --- 10. 其他请求路由 ---
app.use('/', apiProxy);

// --- 11. 启动服务器 ---
app.listen(PORT, () => {
    console.log(`[INFO] 代理服务器已启动，监听端口: ${PORT}`);
    console.log(`[INFO] 目标服务器: ${TARGET_URL}`);
    console.log(`[INFO] 健康检查端点: /health`);
    console.log(`[INFO] 运行环境: ${NODE_ENV}`);
});
