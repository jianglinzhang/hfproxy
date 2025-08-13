// 1. 引入依赖
require('dotenv').config(); // 加载 .env 文件中的环境变量
const express = require('express');
const cors = 'cors';
const { createProxyMiddleware } = require('http-proxy-middleware');

// 2. 检查环境变量
const TARGET_HOST = process.env.TARGET_HOST;
if (!TARGET_HOST) {
  console.error('错误: 环境变量 TARGET_HOST 未设置。');
  process.exit(1); // 退出程序
}

// 3. 初始化 Express 应用
const app = express();

// 4. 设置代理中间件
const proxy = createProxyMiddleware({
  // 代理的目标地址
  target: TARGET_HOST,
  
  // 关键：设置为 true, 代理 WebSocket 请求
  ws: true,
  
  // 关键：设置为 true, 修改请求头中的 'Origin' 字段为目标地址
  // 这对于绕过目标服务器的 CORS 或来源检查至关重要
  changeOrigin: true,

  // 可选：重写路径（如果需要的话，这里我们保持原样，所以注释掉）
  // pathRewrite: {
  //   '^/api': '', // 例如：将 /api/users 转换为 /users
  // },

  // 可选：添加自定义日志，方便调试
  onProxyReq: (proxyReq, req, res) => {
    console.log(`[Proxy] ${req.method} ${req.url} -> ${TARGET_HOST}${proxyReq.path}`);
  },
  onProxyReqWs: (proxyReq, req, socket, options, head) => {
    console.log(`[Proxy WS] ${req.url} -> ${TARGET_HOST}${proxyReq.path}`);
  },
  onError: (err, req, res) => {
    console.error('代理出错:', err);
    res.writeHead(500, {
      'Content-Type': 'text/plain',
    });
    res.end('代理服务器发生错误。');
  }
});

// 5. 应用 CORS 和代理中间件
// 允许所有来源的跨域请求，这对于前端应用调用此代理至关重要
app.use(require('cors')()); 

// 将所有请求（'/'）都应用代理中间件
app.use('/', proxy);

// 6. 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`代理服务器已启动，监听端口 ${PORT}`);
  console.log(`正在代理 -> ${TARGET_HOST}`);
});
