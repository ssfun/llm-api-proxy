// *─────────────────────────────────────────────────────────────────────────────*
// * Vercel Edge Function - 单文件部署版本
// *─────────────────────────────────────────────────────────────────────────────*

// Vercel Edge Function 的配置，必须导出
export const config = {
  runtime: 'edge',
};

// Vercel Edge Function 的主处理函数
export default async function handler(req: Request) {
  const startTime = performance.now();
  const reqId = getRequestId(req.headers);
  const { method } = req;
  const originalUrl = new URL(req.url);
  const { pathname, searchParams } = originalUrl; // 使用 searchParams 以便过滤

  logInfo("Incoming request", { reqId, method, path: pathname, ip: req.headers.get("x-forwarded-for") || "unknown" });

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: createCorsHeaders() });
  }

  const cleanedPathname = pathname.startsWith('/gateway') ? pathname.replace('/gateway', '') : pathname;
  
  const segments = cleanedPathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    logWarn("Invalid path format", { reqId, path: cleanedPathname });
    return createErrorResponse(400, "Invalid path. Expected: /{service}/{path}", reqId, { availableServices: Object.keys(PROXIES) });
  }

  const [serviceAlias, ...pathSegments] = segments;
  const proxy = PROXIES[serviceAlias];
  if (!proxy) {
    logWarn("Service not found", { reqId, service: serviceAlias });
    return createErrorResponse(404, `Service '${serviceAlias}' not found`, reqId, { availableServices: Object.keys(PROXIES) });
  }
  
  // 创建一个安全的查询参数白名单，防止转发未知或有害的参数
  const newSearchParams = new URLSearchParams();
  // 只允许转发 'key' 参数，这是 Gemini API 等服务需要的
  if (searchParams.has('key')) {
      newSearchParams.set('key', searchParams.get('key')!);
  }
  // 如果未来需要其他参数，可在此处添加
  // if (searchParams.has('another_safe_param')) { ... }
  const finalSearch = newSearchParams.toString() ? `?${newSearchParams.toString()}` : '';


  const userPath = sanitizePath(pathSegments);
  const upstreamURL = buildUpstreamURL(proxy.host, proxy.basePath, userPath, finalSearch); // 使用过滤后的 finalSearch
  logDebug("Routing request", { reqId, service: serviceAlias, upstream: upstreamURL });

  const forwardHeaders = buildForwardHeaders(req.headers, proxy);
  const timeout = proxy.timeout || DEFAULT_TIMEOUT;
  const abortController = new AbortController();
  const timeoutId = setTimeout(()=>abortController.abort(), timeout);

  const upstreamRequest = new Request(upstreamURL, { method, headers: forwardHeaders, body: req.body, redirect: "follow", signal: abortController.signal });

  let upstreamResponse;
  try {
    upstreamResponse = await fetchWithRetry(upstreamRequest, { maxRetries: ENABLE_RETRY ? proxy.maxRetries ?? 2 : 0, retryableMethods: proxy.retryableMethods, reqId });
  } catch (error) {
    clearTimeout(timeoutId);
    const errorInfo = categorizeError(error as Error);
    logError("Upstream request failed", { reqId, service: serviceAlias, errorType: errorInfo.type, error: (error as Error).message, upstream: upstreamURL });
    return createErrorResponse(errorInfo.status, errorInfo.message, reqId, { type: errorInfo.type, upstream: upstreamURL });
  } finally{
    clearTimeout(timeoutId);
  }

  const responseHeaders = processResponseHeaders(upstreamResponse.headers, reqId);
  const maxSize = proxy.maxResponseSize || MAX_RESPONSE_SIZE;
  const contentLength = upstreamResponse.headers.get("content-length");

  if (contentLength) {
    const size = parseInt(contentLength);
    if (size > maxSize) {
      logWarn("Response size exceeds limit (pre-check)", { reqId, size_bytes: size, size_mb: (size / 1024 / 1024).toFixed(2), limit_mb: (maxSize / 1024 / 1024).toFixed(2) });
    }
  }

  let responseBody = upstreamResponse.body;
  if (responseBody && !contentLength && maxSize > 0) {
    const sizeMonitor = createSizeLimitedStream(maxSize, reqId);
    responseBody = responseBody.pipeThrough(sizeMonitor);
  }

  const duration = Math.round(performance.now() - startTime);
  const logContext = { reqId, status: upstreamResponse.status, duration_ms: duration, service: serviceAlias, ...contentLength && { size_bytes: parseInt(contentLength) } };
  
  if (upstreamResponse.status >= 400) {
    logWarn("Request completed", logContext);
  } else {
    logInfo("Request completed", logContext);
  }

  return new Response(responseBody, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders
  });
}


// *─────────────────────────────────────────────────────────────────────────────*
// * 模块: logger.ts
// *─────────────────────────────────────────────────────────────────────────────*
const shanghaiTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false
});
function toShanghaiTime() {
  return shanghaiTimeFormatter.format(new Date()).replace(/\//g, '-');
}
function log(level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', message: string, context?: Record<string, any>) {
  const time = toShanghaiTime();
  const levelColor = { DEBUG: "\x1b[36m", INFO: "\x1b[32m", WARN: "\x1b[33m", ERROR: "\x1b[31m" }[level];
  const reset = "\x1b[0m";
  let logStr = `[${time}]`;
  if (context?.reqId) logStr += ` [${context.reqId}]`;
  logStr += ` ${levelColor}[${level}]${reset} ${message}`;
  if (context) {
    const { reqId, ...rest } = context;
    if (Object.keys(rest).length > 0) {
      const contextStr = Object.entries(rest).map(([k, v])=>{
        if (v === undefined || v === null) return null;
        if (typeof v === 'object') return `${k}=${JSON.stringify(v)}`;
        return `${k}=${v}`;
      }).filter(Boolean).join(' ');
      if (contextStr) logStr += ` | ${contextStr}`;
    }
  }
  console.log(logStr);
}
const logDebug = (msg: string, ctx?: Record<string, any>)=>log("DEBUG", msg, ctx);
const logInfo = (msg: string, ctx?: Record<string, any>)=>log("INFO", msg, ctx);
const logWarn = (msg: string, ctx?: Record<string, any>)=>log("WARN", msg, ctx);
const logError = (msg: string, ctx?: Record<string, any>)=>log("ERROR", msg, ctx);


// *─────────────────────────────────────────────────────────────────────────────*
// * 模块: config.ts
// *─────────────────────────────────────────────────────────────────────────────*

function getEnv(key: string, defaultValue?: string): string | undefined {
  return (globalThis as any).process?.env[key] ?? defaultValue;
}

const BUILTIN_PROXIES: Record<string, any> = {
  azure: { 
    host: "models.inference.ai.azure.com",
    retryable: true,
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST", "PUT"]
  },
  cerebras: { 
    host: "api.cerebras.ai",
    retryable: true,
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"]
  },
  chutes: { 
    host: "llm.chutes.ai",
    retryable: true,
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"] 
  },
  claude: { 
    host: "api.anthropic.com",
    defaultHeaders: {
      "anthropic-version": "2023-06-01"
    },
    retryable: true,
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"]
  },
  cohere: { 
    host: "api.cohere.ai",
    retryable: true,
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"]
  },
  discord: { 
    host: "discord.com", 
    basePath: "api" 
  },
  dmxcn: { 
    host: "www.dmxapi.cn" 
  },
  dmxcom: { 
    host: "www.dmxapi.com" 
  },
  fireworks: { 
    host: "api.fireworks.ai", 
    basePath: "inference",
    retryable: true,
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"]
  },
  friendli: { 
    host: "api.friendli.ai", 
    basePath: "serverless",
    retryable: true,
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"] 
  },
  gemini: { 
    host: "generativelanguage.googleapis.com",
    retryable: true,
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"]
  },
  github: { 
    host: "models.github.ai",
    defaultHeaders: {
      "Accept": "application/vnd.github+json"
    },
    retryable: true,
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"]
  },
  gmi: { 
    host: "api.gmi-serving.com",
    retryable: true,
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"] 
  },
  groq: { 
    host: "api.groq.com", 
    basePath: "openai",
    retryable: true,
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"]
  },
  huggingface: { 
    host: "api-inference.huggingface.co",
    retryable: true,
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"]
  },
  meta: { 
    host: "www.meta.ai", 
    basePath: "api",
    retryable: true,
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"] 
  },
  modelscope: { 
    host: "api-inference.modelscope.cn",
    retryable: true,
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"] 
  },
  novita: { 
    host: "api.novita.ai",
    retryable: true,
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"]
  },
  openai: { 
    host: "api.openai.com",
    retryable: true,
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"],
    timeout: 120000,
    maxResponseSize: 10485760
  },
  openrouter: { 
    host: "openrouter.ai", 
    basePath: "api",
    retryable: true,
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"]
  },
  poe: { 
    host: "api.poe.com",
    retryable: true,
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"] 
  },
  portkey: { 
    host: "api.portkey.ai",
    retryable: true,
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"]
  },
  siliconflow: { 
    host: "api.siliconflow.cn",
    retryable: true,
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"]
  },
  targon: { 
    host: "api.targon.com",
    retryable: true,
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"] 
  },
  telegram: { 
    host: "api.telegram.org",
    retryable: true,
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"] 
  },
  together: { 
    host: "api.together.xyz",
    retryable: true,
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"]
  },
  xai: { 
    host: "api.x.ai",
    retryable: true,
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"]
  },
  httpbin: { 
    host: "httpbin.org",
    retryable: true 
  },
};

function loadProxyConfig() {
  const raw = getEnv("PROXY_CONFIG");
  if (!raw) return BUILTIN_PROXIES;
  try {
    const parsed = JSON.parse(raw);
    const merged = { ...BUILTIN_PROXIES };
    for (const [key, value] of Object.entries(parsed)){
      if (typeof value === 'object' && value !== null) {
        merged[key] = { ...BUILTIN_PROXIES[key], ...value };
      }
    }
    return merged;
  } catch (e) {
    console.error("⚠️ Invalid PROXY_CONFIG JSON, using built-in config", e);
    return BUILTIN_PROXIES;
  }
}

const ALLOWED_ORIGIN = getEnv("ALLOWED_ORIGIN", "*");
const DEFAULT_TIMEOUT = parseInt(getEnv("DEFAULT_TIMEOUT", "60000")!, 10);
const ENABLE_RETRY = getEnv("ENABLE_RETRY", "true") !== "false";
const MAX_RESPONSE_SIZE = parseInt(getEnv("MAX_RESPONSE_SIZE", "6291456")!, 10); // 6MB
const DEFAULT_RETRY_METHODS = ["GET", "HEAD", "OPTIONS"];


// *─────────────────────────────────────────────────────────────────────────────*
// * 模块: utils.ts
// *─────────────────────────────────────────────────────────────────────────────*
function getRequestId(headers: Headers): string {
  return headers.get("x-request-id") || headers.get("sb-request-id") || crypto.randomUUID();
}
function sanitizePath(parts: string[]): string {
  return parts.filter((seg)=>seg && seg !== "." && seg !== "..").map((seg)=>{
    return seg.split('/').map((s)=>encodeURIComponent(s).replace(/%3A/gi, ':')).join('/');
  }).join('/');
}
function buildUpstreamURL(host: string, basePath: string, userPath: string, search: string): string {
  const cleanBase = basePath?.replace(/^\/|\/$/g, '') || '';
  const cleanUser = userPath.replace(/^\/|\/$/g, '');
  const fullPath = [cleanBase, cleanUser].filter(Boolean).join('/');
  return `https://${host}${fullPath ? '/' + fullPath : ''}${search}`;
}
function categorizeError(error: Error) {
  const msg = error.message.toLowerCase();
  if (error.name === "AbortError" || msg.includes("timeout")) return { type: "TIMEOUT", status: 504, message: "Request timeout - upstream service took too long" };
  if (msg.includes("network") || msg.includes("fetch failed")) return { type: "NETWORK", status: 502, message: "Network error - unable to reach upstream service" };
  if (msg.includes("dns") || msg.includes("getaddrinfo")) return { type: "DNS", status: 502, message: "DNS resolution failed for upstream host" };
  if (msg.includes("connection refused") || msg.includes("econnrefused")) return { type: "CONNECTION", status: 503, message: "Connection refused - upstream service is down" };
  if (msg.includes("ssl") || msg.includes("tls") || msg.includes("certificate")) return { type: "SSL", status: 502, message: "SSL/TLS error - certificate validation failed" };
  return { type: "UNKNOWN", status: 500, message: `Unexpected error: ${error.message}` };
}
async function fetchWithRetry(request: Request, config: {maxRetries: number, retryableMethods?: string[], reqId: string}) {
  const { maxRetries, retryableMethods = DEFAULT_RETRY_METHODS, reqId } = config;
  if (!(maxRetries > 0 && retryableMethods.includes(request.method))) {
    return fetch(request);
  }
  let lastError: unknown = null;
  for(let attempt = 0; attempt <= maxRetries; attempt++){
    try {
      if (attempt > 0) logWarn("Retrying request", { reqId, attempt, maxRetries, url: request.url, method: request.method });
      const clonedRequest = request.clone();
      const response = await fetch(clonedRequest);
      if (attempt < maxRetries && response.status >= 500) {
        throw new Error(`Server error: ${response.status}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) break;
      const errorInfo = categorizeError(error as Error);
      if (!["TIMEOUT", "NETWORK", "CONNECTION", "UNKNOWN"].includes(errorInfo.type)) break;
      const delay = Math.min(100 * Math.pow(2, attempt), 5000) * (1 + (Math.random() - 0.5) * 0.3);
      await new Promise((resolve)=>setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
function createSizeLimitedStream(maxSize: number, reqId: string) {
  let totalBytes = 0;
  return new TransformStream({
    transform (chunk, controller) {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxSize) {
        logWarn("Response size limit exceeded", { reqId, totalBytes, maxSize });
        controller.error(new Error("Response size limit exceeded"));
        return;
      }
      controller.enqueue(chunk);
    }
  });
}

// *─────────────────────────────────────────────────────────────────────────────*
// * 模块: index.ts (主逻辑 - 辅助函数)
// *─────────────────────────────────────────────────────────────────────────────*
const PROXIES = loadProxyConfig();
const ALLOWED_REQ_HEADERS = new Set(["content-type", "content-length", "accept", "authorization", "x-api-key", "anthropic-version", "user-agent"]);
const BLACKLISTED_HEADERS = new Set(["host", "connection", "cf-connecting-ip", "x-forwarded-for", "cookie"]);
const CORS_ALLOWED_HEADERS = "Content-Type, Authorization, X-Requested-With, anthropic-version";
const CORS_EXPOSED_HEADERS = "Content-Type, Content-Length, X-Request-Id";

function createCorsHeaders() {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD");
  headers.set("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
  headers.set("Access-Control-Expose-Headers", CORS_EXPOSED_HEADERS);
  headers.set("Access-Control-Max-Age", "86400");
  return headers;
}
function createErrorResponse(status: number, message: string, reqId: string, detail?: object) {
  const errorBody = { error: { message, type: 'api_error', request_id: reqId }, status, ...detail };
  const headers = createCorsHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Request-Id", reqId);
  return new Response(JSON.stringify(errorBody), { status, headers });
}
function buildForwardHeaders(clientHeaders: Headers, proxy: any) {
  const headers = new Headers();
  if (proxy.defaultHeaders) {
    Object.entries(proxy.defaultHeaders).forEach(([key, value]) => headers.set(key, value as string));
  }
  for (const [key, value] of clientHeaders.entries()){
    const lowerKey = key.toLowerCase();
    if (!BLACKLISTED_HEADERS.has(lowerKey) && ALLOWED_REQ_HEADERS.has(lowerKey)) {
      headers.set(key, value);
    }
  }
  if (!headers.has("user-agent")) {
    headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
  }
  headers.delete("accept-encoding");
  return headers;
}
function processResponseHeaders(upstreamHeaders: Headers, reqId: string) {
  const headers = new Headers(upstreamHeaders);
  const corsHeaders = createCorsHeaders();
  for (const [key, value] of corsHeaders.entries()){
    headers.set(key, value);
  }
  headers.set("X-Request-Id", reqId);
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  headers.delete("server");
  return headers;
}

// 启动日志 (Vercel环境中只在构建时或首次调用时打印)
logInfo("🚀 Vercel Edge proxy service configured", {
  version: "1.0.0",
  services: Object.keys(PROXIES).length
});
