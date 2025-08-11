const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

// 在本地开发时，加载 .env 文件中的环境变量
require('dotenv').config();

// --- 1. 配置 ---
const PORT = process.env.PORT || 3000;
const TARGET_URL = process.env.TARGET_URL;

if (!TARGET_URL) {
    console.error('错误：关键环境变量 TARGET_URL 未设置！');
    process.exit(1);
}

// --- 2. 创建 Express 应用 ---
const app = express();

// --- 3.【必需】添加 JSON 请求体解析器 ---
// 这是处理 OpenWebUI 发送聊天内容（POST 请求）所必需的。
// 它必须放在代理中间件之前。
app.use(express.json());

// --- 4.【必需】健康检查端点 ---
// 为 Choreo 等云平台提供一个快速、可靠的健康检查路径。
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// --- 5.【核心】配置并应用代理中间件 ---
const apiProxy = createProxyMiddleware({
    target: TARGET_URL,
    changeOrigin: true,
    ws: true,
    logLevel: 'info', // 'debug' 可以看到更详细的日志

    // 【可选但推荐】修正 SSE 的响应头，防止意外问题
    onProxyRes: (proxyRes, req, res) => {
        const originalContentType = proxyRes.headers['content-type'];
        if (originalContentType && originalContentType.includes('text/event-stream')) {
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        }
    },

    // 当代理本身出错时的处理
    onError: (err, req, res) => {
        console.error('代理服务器内部错误:', err);
        if (!res.headersSent) {
            res.status(502).send('Proxy Error'); // 502 Bad Gateway 是标准的代理错误码
        }
    }
});

// 将所有其他请求都交给代理处理
app.use('/', apiProxy);

// --- 6. 启动服务器 ---
app.listen(PORT, () => {
    console.log(`代理服务器已启动，正在监听端口: ${PORT}`);
    console.log(`将所有请求代理到: ${TARGET_URL}`);
    console.log(`健康检查端点位于: /health`);
});
