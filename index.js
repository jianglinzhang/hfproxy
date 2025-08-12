// index.js

// 1. 导入所需模块
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
require('dotenv').config(); // 加载 .env 文件中的环境变量，主要用于本地开发

// 2. 配置
// 从环境变量中获取目标地址，这是部署到 Choreo 的关键
const TARGET_HOST = process.env.TARGET_HOST;

// 如果没有设置环境变量，则打印错误并退出，确保部署时不会出错
if (!TARGET_HOST) {
    console.error("错误：必须设置环境变量 TARGET_HOST。例如：TARGET_HOST=\"xxx-chat.hf.space\"");
    process.exit(1); // 退出进程
}

const TARGET_URL = `https://${TARGET_HOST}`;
// Choreo 会通过 PORT 环境变量告诉我们应该监听哪个端口
const PORT = process.env.PORT || 3001; 

// 3. 创建 Express 应用
const app = express();

// 4. 使用 CORS 中间件
// 允许所有来源的跨域请求，这对于作为公共代理是必要的
app.use(cors());

// 5. 配置 http-proxy-middleware
const proxyOptions = {
    // 代理的目标地址
    target: TARGET_URL,
    
    // 核心配置：更改请求头中的 'Host' 字段，使其与目标服务器匹配。
    // 这对于很多云平台（包括 Hugging Face Space）是必需的。
    changeOrigin: true,

    // 启用 WebSocket 代理，聊天功能必需
    ws: true,

    // 重写请求头，模拟直接从浏览器访问目标网站
    // 这部分和你 CF Worker 的逻辑是一致的
    onProxyReq: (proxyReq, req, res) => {
        proxyReq.setHeader('Origin', TARGET_URL);
        proxyReq.setHeader('Referer', TARGET_URL);
    },

    // 关键点：http-proxy-middleware 默认就是流式处理响应，
    // 它会直接将目标服务器的响应流转发给客户端，
    // 从而完美解决了 SSE 导致的 JSON 解析错误。
    // 无需额外配置！

    // 可选：增加日志，方便调试
    logLevel: 'debug',
};

// 6. 创建代理中间件并应用到所有路由
const hfProxy = createProxyMiddleware(proxyOptions);
app.use('/', hfProxy);

// 7. 启动服务器
app.listen(PORT, () => {
    console.log(`代理服务器已启动，正在监听端口 ${PORT}`);
    console.log(`成功代理到 -> ${TARGET_URL}`);
});
