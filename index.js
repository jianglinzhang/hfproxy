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


// --- 3.【关键修复】添加 JSON 请求体解析中间件 ---
// 这个中间件必须在代理之前！它会解析 Content-Type 为 application/json 的请求体。
// 这样 http-proxy-middleware 才能正确地处理和转发 POST/PUT 等请求的数据。
app.use(express.json());


// --- 4. 健康检查路由 ---
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});


// --- 5. 配置代理中间件 ---
const proxyOptions = {
    target: TARGET_URL,
    changeOrigin: true,
    ws: true,
    
    onError: (err, req, res) => {
        console.error('代理请求出错:', err);
        // 确保即使在代理错误时，也能安全地结束响应
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        res.end('代理服务器出错，无法连接到目标服务。');
    },

    onProxyReq: (proxyReq, req, res) => {
        // 当我们使用了 express.json()，请求体已经被解析并存在 req.body 中。
        // http-proxy-middleware 默认会处理好这个已解析的 body，但为了确保万无一失，
        // 我们可以手动将解析后的 body 写回代理请求。
        // 注意：这只在有 body 的情况下执行。
        if (req.body) {
            const bodyData = JSON.stringify(req.body);
            // 更新 Content-Length，因为 body 内容可能已改变
            proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
            // 将 body 写入代理请求流
            proxyReq.write(bodyData);
        }
        console.log(`[Proxy] 正在将请求转发到: ${TARGET_URL}${req.url}`);
    },

    onProxyRes: (proxyRes, req, res) => {
        const originalContentType = proxyRes.headers['content-type'];
        
        if (originalContentType && originalContentType.includes('text/event-stream')) {
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            console.log(`[Proxy] 检测到 SSE 流，已强制设置 Content-Type: text/event-stream`);
        }
        
        if (req.path !== '/health') {
            console.log(`[Proxy] 收到来自 ${TARGET_URL}${req.url} 的响应: ${proxyRes.statusCode}`);
        }
    },

    logLevel: 'info'
};

const apiProxy = createProxyMiddleware(proxyOptions);

// --- 6. 应用代理中间件 ---
// 这个必须放在所有其他路由和中间件之后
app.use('/', apiProxy);


// --- 7. 启动服务器 ---
app.listen(PORT, () => {
    console.log(`代理服务器已启动，正在监听端口: ${PORT}`);
    console.log(`将所有请求代理到: ${TARGET_URL}`);
    console.log(`健康检查端点位于: /health`);
});
