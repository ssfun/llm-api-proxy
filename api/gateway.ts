import {
  PROXIES,
  ALLOWED_ORIGIN,
  DEFAULT_TIMEOUT,
  ENABLE_RETRY,
  MAX_RESPONSE_SIZE,
  DEFAULT_RETRY_METHODS
} from "./config";

export const config = { runtime: "edge" };

// ====================================
export default async function handler(req: Request) {
  const reqId = getRequestId(req.headers);
  const url = new URL(req.url);
  const { pathname, searchParams } = url;

  // 处理 CORS
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: createCorsHeaders() });
  }

  // 解析路径
  const cleanedPath = pathname.startsWith("/gateway")
    ? pathname.replace("/gateway", "")
    : pathname;
  const segments = cleanedPath.split("/").filter(Boolean);
  if (segments.length < 2) {
    return createErrorResponse(400, "无效路径", reqId, {
      availableServices: Object.keys(PROXIES),
    });
  }

  const [serviceAlias, ...rest] = segments;
  const proxy = PROXIES[serviceAlias];
  if (!proxy) {
    return createErrorResponse(404, `服务 '${serviceAlias}' 未找到`, reqId, {
      availableServices: Object.keys(PROXIES),
    });
  }

  // === stream 判定 ===
  let isStream = false;
  if (req.method === "POST") {
    try {
      const body = await req.clone().json();
      if (body?.stream === true) isStream = true;
    } catch {/* ignore */}
  }

  // === 非流式 → Background Function
  if (!isStream) {
    const backgroundUrl = new URL(`/api/background${cleanedPath}${url.search}`, url.origin).toString();
    return fetch(backgroundUrl, { method: req.method, headers: req.headers, body: req.body });
  }

  // === 流式 → Edge 直传
  const upstreamUrl = buildUpstreamURL(proxy.host, proxy.basePath, rest.join("/"), "");
  const upstreamReq = new Request(upstreamUrl, {
    method: req.method,
    headers: buildForwardHeaders(req.headers, proxy),
    body: req.body,
  });
  const upstreamResp = await fetchWithRetry(upstreamReq, {
    maxRetries: ENABLE_RETRY ? proxy.maxRetries ?? 2 : 0,
    retryableMethods: proxy.retryableMethods,
    reqId,
  });

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    headers: processResponseHeaders(upstreamResp.headers, reqId),
  });
}

// =================== 工具函数 ===================

function getRequestId(headers: Headers): string {
  return headers.get("x-request-id") || headers.get("sb-request-id") || crypto.randomUUID();
}
function sanitizePath(parts: string[]): string {
  return parts.filter(seg => seg !== "." && seg !== "..")
              .map(seg => encodeURIComponent(seg).replace(/%3A/gi, ":"))
              .join("/");
}
function buildUpstreamURL(host: string, basePath: string, userPath: string, search: string): string {
  const cleanBase = basePath?.replace(/^\/|\/$/g, "") || "";
  const cleanUser = userPath.replace(/^\/|\/$/g, "");
  const full = [cleanBase, cleanUser].filter(Boolean).join("/");
  return `https://${host}${full ? "/" + full : ""}${search}`;
}

// 错误分类
function categorizeError(error: Error) {
  const msg = error.message.toLowerCase();
  if (error.name === "AbortError" || msg.includes("timeout")) return { type: "TIMEOUT", status: 504, message: "请求超时" };
  if (msg.includes("network") || msg.includes("fetch failed")) return { type: "NETWORK", status: 502, message: "网络错误" };
  if (msg.includes("dns")) return { type: "DNS", status: 502, message: "DNS解析失败" };
  if (msg.includes("connection refused")) return { type: "CONNECTION", status: 503, message: "连接被拒绝" };
  return { type: "UNKNOWN", status: 500, message: "未知错误: " + error.message };
}
async function fetchWithRetry(req: Request, cfg: { maxRetries: number, retryableMethods?: string[], reqId: string }) {
  const { maxRetries, retryableMethods = DEFAULT_RETRY_METHODS } = cfg;
  let lastErr: any;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const resp = await fetch(req.clone());
      if (resp.status >= 500 && i < maxRetries) throw new Error(`服务器错误: ${resp.status}`);
      return resp;
    } catch (err) {
      lastErr = err;
      if (i < maxRetries) {
        const delay = Math.min(200 * 2 ** i, 5000) * (1 + (Math.random() - 0.5) * 0.3);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}
function createSizeLimitedStream(maxSize: number, reqId: string) {
  let total = 0;
  return new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxSize) {
        controller.error(new Error("响应超限"));
        return;
      }
      controller.enqueue(chunk);
    }
  });
}
function createCorsHeaders() {
  const h = new Headers();
  h.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, *");
  h.set("Access-Control-Expose-Headers", "Content-Type, X-Request-Id");
  return h;
}
function createErrorResponse(status: number, message: string, reqId: string, detail?: object) {
  const body = { error: { message, type: "api_error", request_id: reqId }, status, ...detail };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Request-Id": reqId }
  });
}
function buildForwardHeaders(clientHeaders: Headers, proxy: any) {
  const headers = new Headers(proxy.defaultHeaders || {});
  for (const [k, v] of clientHeaders.entries()) {
    const lower = k.toLowerCase();
    if (!BLACKLISTED_HEADERS.has(lower) && (ALLOWED_REQ_HEADERS.has(lower) || lower.startsWith("x-"))) {
      headers.set(k, v);
    }
  }
  headers.delete("accept-encoding");
  return headers;
}
function processResponseHeaders(up: Headers, reqId: string) {
  const h = new Headers(up);
  const cors = createCorsHeaders();
  for (const [k, v] of cors.entries()) h.set(k, v);
  h.set("X-Request-Id", reqId);
  h.delete("transfer-encoding");
  h.delete("server");
  return h;
}

// =================== 日志 ===================
function log(level: "DEBUG" | "INFO" | "WARN" | "ERROR", msg: string, ctx?: any) {
  const t = new Date().toISOString();
  console.log(`[${t}][${ctx?.reqId || ""}][${level}] ${msg}`, ctx || "");
}
const logDebug = (m: string, c?: any) => log("DEBUG", m, c);
const logInfo = (m: string, c?: any) => log("INFO", m, c);
const logWarn = (m: string, c?: any) => log("WARN", m, c);
const logError = (m: string, c?: any) => log("ERROR", m, c);

logInfo("🚀 Gateway 启动完成", { services: Object.keys(PROXIES).length });
