// index.js (v2 - More Robust)

// 1. 导入所需模块
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
// cors 中间件在这里不再是必需的，因为我们在 onProxyRes 中手动设置了头
// const cors = require('cors'); 
require('dotenv').config();

// 2. 配置
const TARGET_HOST = process.env.TARGET_HOST;
if (!TARGET_HOST) {
    console.error("错误：必须设置环境变量 TARGET_HOST。");
    process.exit(1);
}
const TARGET_URL = `httpshttps://${TARGET_HOST}`;
const PORT = process.env.PORT || 3001;

// 3. 创建 Express 应用
const app = express();

// 4. 配置 http-proxy-middleware
const proxyOptions = {
    target: TARGET_URL,
    changeOrigin: true,
    ws: true, // 保持 WebSocket 代理开启
    logLevel: 'debug', // 使用 'debug' 级别日志以获取更详细的输出

    // 请求发往目标服务器之前的回调
    onProxyReq: (proxyReq, req, res) => {
        // 确保请求头正确，模拟真实浏览器访问
        proxyReq.setHeader('Origin', TARGET_URL);
        proxyReq.setHeader('Referer', TARGET_URL);
    },

    /**
     *  ============== 关键的修改部分 ==============
     *  收到目标服务器响应之后，发送给客户端之前的回调
     */
    onProxyRes: (proxyRes, req, res) => {
        // 允许任何来源访问，这是代理的核心功能
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        // Hugging Face Space 的 SSE 流通常使用 'text/event-stream'
        // 我们需要确保这个 Content-Type 头被正确传递
        const contentType = proxyRes.headers['content-type'];
        console.log(`原始 Content-Type: ${contentType}`);

        // 有些代理或云平台可能会意外地移除或修改 Content-Encoding 头，
        // 导致浏览器无法正确处理压缩过的内容。
        // 为了确保流式数据不被破坏，我们直接删除它，让数据以原始形式流向客户端。
        delete proxyRes.headers['content-encoding'];
        
        // 对于流式响应，Content-Length 是不确定的。如果存在，可能会导致客户端等待一个永远不会达到的长度。
        // 删除它可以强制客户端以 chunked 模式接收数据，这对于 SSE 是正确的。
        delete proxyRes.headers['content-length'];
        
        console.log('已清理响应头，准备将数据流式传输到客户端。');
    },

    // 错误处理
    onError: (err, req, res) => {
        console.error('代理遇到错误:', err);
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Proxy Error: Could not connect to the target server.');
    }
};

// 5. 创建并应用代理
const hfProxy = createProxyMiddleware(proxyOptions);
app.use('/', hfProxy);

// 6. 启动服务器
app.listen(PORT, () => {
    console.log(`[v2] 增强型代理服务器已启动，监听端口 ${PORT}`);
    console.log(`代理目标 -> ${TARGET_URL}`);
});
