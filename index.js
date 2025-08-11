const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

// 在本地开发时，加载 .env 文件中的环境变量
require('dotenv').config();

// --- 1. 从环境变量中读取配置 ---
const PORT = process.env.PORT || 3000; // Choreo 会自动注入 PORT 环境变量
const TARGET_URL = process.env.TARGET_URL;

// 检查关键环境变量是否设置
if (!TARGET_URL) {
    console.error('错误：关键环境变量 TARGET_URL 未设置！');
    process.exit(1); // 退出程序
}

// --- 2. 创建 Express 应用 ---
const app = express();

// --- 3. 添加一个专门用于健康检查的路由 ---
// 这个路由必须在代理中间件之前定义！
// 它会立即响应，告诉平台（如 Choreo）我们的服务是存活的。
app.get('/health', (req, res) => {
    res.status(200).send('OK');
    console.log('Health check endpoint was hit.');
});


// --- 4. 配置代理中间件 ---
const proxyOptions = {
    target: TARGET_URL,
    changeOrigin: true,
    ws: true,
    onError: (err, req, res) => {
        console.error('代理请求出错:', err);
        res.writeHead(500, {
            'Content-Type': 'text/plain; charset=utf-8'
        });
        res.end('代理服务器出错，无法连接到目标服务。');
    },
    onProxyRes: (proxyRes, req, res) => {
        // 忽略健康检查的日志，保持日志干净
        if (req.path !== '/health') {
            console.log(`[Proxy] 收到来自 ${TARGET_URL}${req.url} 的响应: ${proxyRes.statusCode}`);
        }
    },
    logLevel: 'info'
};

const apiProxy = createProxyMiddleware(proxyOptions);

// --- 5. 应用代理中间件 ---
// 将除了 /health 之外的所有请求都转发到 TARGET_URL
app.use('/', apiProxy);

// --- 6. 启动服务器 ---
app.listen(PORT, () => {
    console.log(`代理服务器已启动，正在监听端口: ${PORT}`);
    console.log(`将所有请求代理到: ${TARGET_URL}`);
    console.log(`健康检查端点位于: /health`);
});
