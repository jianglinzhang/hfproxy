// netlify/edge-functions/proxy.ts

// 从环境变量中获取目标主机
const TARGET_HOST = Deno.env.get("TARGET_HOST");

function log(message: string) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function getDefaultUserAgent(isMobile: boolean = false): string {
  if (isMobile) {
    return "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
  } else {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  }
}

function transformHeaders(headers: Headers): Headers {
  const isMobile = headers.get("sec-ch-ua-mobile") === "?1";
  const newHeaders = new Headers(headers); // 直接复制所有头

  newHeaders.set("User-Agent", getDefaultUserAgent(isMobile));
  newHeaders.set("Host", TARGET_HOST!);
  newHeaders.set("Origin", `https://${TARGET_HOST}`);
  
  // 删除一些 Netlify 可能会添加的、导致问题的头
  newHeaders.delete("x-nf-geo");
  newHeaders.delete("x-nf-site-id");
  newHeaders.delete("x-nf-request-id");

  return newHeaders;
}

// WebSocket 代理逻辑保持不变
async function handleWebSocket(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const targetUrl = `wss://${TARGET_HOST}${url.pathname}${url.search}`;
  log(`Establishing WebSocket connection to: ${targetUrl}`);
  
  // Deno.upgradeWebSocket 在 Netlify Edge 中同样可用
  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);
  
  try {
    const serverSocket = new WebSocket(targetUrl);

    clientSocket.onopen = () => log("Client WebSocket connected");
    clientSocket.onmessage = (event) => {
      if (serverSocket.readyState === WebSocket.OPEN) {
        serverSocket.send(event.data);
      }
    };
    clientSocket.onclose = () => {
      log("Client WebSocket closed");
      if (serverSocket.readyState === WebSocket.OPEN) serverSocket.close();
    };
    clientSocket.onerror = (error) => log(`Client WebSocket error: ${error}`);

    serverSocket.onopen = () => log("Server WebSocket connected");
    serverSocket.onmessage = (event) => {
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(event.data);
      }
    };
    serverSocket.onclose = () => {
        log("Server WebSocket closed");
        if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close();
    };
    serverSocket.onerror = (error) => log(`Server WebSocket error: ${error}`);

    return response;
  } catch (error) {
    log(`WebSocket connection error: ${error.message}`);
    return new Response(`WebSocket Error: ${error.message}`, { status: 500 });
  }
}

// Netlify Edge Function 的主入口
export default async (req: Request): Promise<Response> => {
  if (!TARGET_HOST) {
    return new Response("TARGET_HOST environment variable not set", { status: 500 });
  }

  try {
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return await handleWebSocket(req);
    }

    const url = new URL(req.url);
    const targetUrl = `https://${TARGET_HOST}${url.pathname}${url.search}`;
    log(`Proxying HTTP request: ${targetUrl}`);

    const proxyReq = new Request(targetUrl, {
      method: req.method,
      headers: transformHeaders(req.headers),
      body: req.body,
      redirect: "follow",
    });

    const response = await fetch(proxyReq);
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error) {
    log(`Error: ${error.message}`);
    return new Response(`Proxy Error: ${error.message}`, { status: 500 });
  }
};
