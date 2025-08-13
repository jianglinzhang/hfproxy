// 1. 引入依赖
require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

// 2. 检查环境变量
const TARGET_HOST = process.env.TARGET_HOST;
if (!TARGET_HOST) {
console.error('错误: 环境变量 TARGET_HOST 未设置。');
process.exit(1);
}

// 3. 初始化 Express 应用
const app = express();
const PORT = process.env.PORT || 3000;

// 4. 设置代理中间件 (增强版)
const proxy = createProxyMiddleware({
target: TARGET_HOST,
ws: true, // 必须：启用 WebSocket 代理
changeOrigin: true, // 必须：修改请求头中的 'Origin'

// --- 新增和优化的配置 ---

// 增加超时时间，防止平台因长轮询而提前终止连接
// Socket.IO的握手阶段可能会有较长的等待
timeout: 60000, // 服务器响应超时（毫秒）
proxyTimeout: 60000, // 代理请求超时（毫秒）

// 增强日志记录，用于调试
onProxyReq: (proxyReq, req, res) => {
// 打印所有即将发往目标服务器的HTTP请求
console.log([Proxy HTTP Req] ${req.method} ${req.originalUrl} -> ${TARGET_HOST}${proxyReq.path});
},
onProxyRes: (proxyRes, req, res) => {
// 打印从目标服务器收到的所有HTTP响应
console.log([Proxy HTTP Res] ${req.method} ${req.originalUrl} -> Status: ${proxyRes.statusCode});
},
onProxyReqWs: (proxyReq, req, socket, options, head) => {
// 打印WebSocket升级请求
console.log([Proxy WS Req] ${req.url} -> ${TARGET_HOST}${proxyReq.path});
},
onError: (err, req, res) => {
console.error('[Proxy Error]', err);
// 确保在出错时向客户端发送一个响应
if (res && !res.headersSent) {
res.writeHead(500, {
'Content-Type': 'text/plain',
});
res.end('Proxy error: ' + err.message);
}
}
});

// 5. 应用 CORS 和代理中间件
// 允许所有来源的跨域请求
app.use(require('cors')());

// 将所有请求都应用代理中间件
app.use('/', proxy);

// 6. 启动服务器
const server = app.listen(PORT, () => {
console.log(代理服务器已启动，监听端口 ${PORT});
console.log(正在代理 -> ${TARGET_HOST});
});

// 优雅地处理服务器关闭
process.on('SIGTERM', () => {
console.log('收到 SIGTERM，正在关闭服务器...');
server.close(() => {
console.log('服务器已关闭。');
});
});
