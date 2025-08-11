const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

// 在本地开发时，加载 .env 文件中的环境变量
require('dotenv').config();

// --- 1. 从环境变量中读取配置 ---
const PORT = process.env.PORT || 3000;
const TARGET_URL = process.env.TARGET_URL;

if (!TARGET_URL) {
    console.error('错误：关键环境变量 TARGET_URL 未设置！');
    process.exit(1);
}

// --- 2. 创建 Express 应用 ---
const app = express();

// --- 3. 健康检查路由 ---
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// --- 4. 配置代理中间件 ---
const proxyOptions = {
    target: TARGET_URL,
    changeOrigin: true,
    ws: true,
    
    // 当代理出错时提供友好信息
    onError: (err, req, res) => {
        console.error('代理请求出错:', err);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('代理服务器出错，无法连接到目标服务。');
    },

    // 关键修复：在这里处理从目标服务器返回的响应
    onProxyRes: (proxyRes, req, res) => {
        // 获取原始响应的 Content-Type
        const originalContentType = proxyRes.headers['content-type'];
        
        // 检查是否为 SSE 流
        if (originalContentType === 'text/event-stream' || originalContentType === 'text/event-stream; charset=utf-8') {
            // 确保返回给客户端的头也是 text/event-stream
            // 这可以防止 Express 或其他中间件可能错误地将其重置为 application/json
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            console.log(`[Proxy] 检测到 SSE 流，已强制设置 Content-Type: text/event-stream`);
        }
        
        const logPath = req.path;
        // 忽略健康检查日志，保持日志清晰
        if (logPath !== '/health') {
            console.log(`[Proxy] 收到来自 ${TARGET_URL}${req.url} 的响应: ${proxyRes.statusCode}`);
        }
    },

    logLevel: 'info'
};

const apiProxy = createProxyMiddleware(proxyOptions);

// --- 5. 应用代理中间件 ---
app.use('/', apiProxy);

// --- 6. 启动服务器 ---
app.listen(PORT, () => {
    console.log(`代理服务器已启动，正在监听端口: ${PORT}`);
    console.log(`将所有请求代理到: ${TARGET_URL}`);
    console.log(`健康检查端点位于: /health`);
});
