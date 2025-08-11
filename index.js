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

// --- 3. 配置代理中间件 ---
// http-proxy-middleware 会自动处理流式响应 (SSE) 和数据压缩
const proxyOptions = {
    target: TARGET_URL,  // 我们的目标服务器地址
    changeOrigin: true,  // 必须设置为 true，否则目标服务器可能因为 Host 头不匹配而拒绝请求
    ws: true,            // 启用 WebSocket 代理，很多现代Web应用（包括OpenWebUI的某些功能）可能会用到
    
    // 当代理出错时，提供更友好的错误信息
    onError: (err, req, res) => {
        console.error('代理请求出错:', err);
        res.writeHead(500, {
            'Content-Type': 'text/plain; charset=utf-8'
        });
        res.end('代理服务器出错，无法连接到目标服务。');
    },

    // 可以在这里查看和修改从目标服务器返回的头信息，但通常不需要
    onProxyRes: (proxyRes, req, res) => {
        // http-proxy-middleware 会自动处理 Content-Encoding (gzip, brotli等)
        // 它会直接将目标服务器的压缩数据流和头信息传递给客户端，由浏览器解压
        // 这就避免了“页面乱码”问题，效率也最高。
        console.log(`[Proxy] 收到来自 ${TARGET_URL} 的响应: ${proxyRes.statusCode}`);
    },

    logLevel: 'info' // 可以设置为 'debug' 来查看更详细的日志
};

const apiProxy = createProxyMiddleware(proxyOptions);

// --- 4. 应用代理中间件 ---
// 将所有进入的请求 (/) 都转发到 TARGET_URL
app.use('/', apiProxy);

// --- 5. 启动服务器 ---
app.listen(PORT, () => {
    console.log(`代理服务器已启动，正在监听端口: ${PORT}`);
    console.log(`将所有请求代理到: ${TARGET_URL}`);
});
