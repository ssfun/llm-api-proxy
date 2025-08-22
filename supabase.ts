// *─────────────────────────────────────────────────────────────────────────────*
// * Supabase Edge Function - 单文件部署版本
// *─────────────────────────────────────────────────────────────────────────────*

import { serve } from "https://deno.land/std@0.199.0/http/server.ts";

// *─────────────────────────────────────────────────────────────────────────────*
// * 模块: logger.ts
// * 说明: 增强的结构化日志，支持请求追踪
// *─────────────────────────────────────────────────────────────────────────────*

//** 创建一个可复用的 formatter 实例，避免在高并发下重复创建对象的开销 *//
const shanghaiTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hour12: false
});

//** 转换为上海时区时间 *//
function toShanghaiTime() {
  // 复用 formatter 实例
  return shanghaiTimeFormatter.format(new Date()).replace(/\//g, '-');
}

//** 统一的日志输出 *//
function log(level, message, context) {
  const time = toShanghaiTime();
  const levelColor = {
    DEBUG: "\x1b[36m",
    INFO: "\x1b[32m",
    WARN: "\x1b[33m",
    ERROR: "\x1b[31m"
  }[level];
  const reset = "\x1b[0m";
  let logStr = `[${time}]`;
  if (context?.reqId) {
    logStr += ` [${context.reqId}]`;
  }
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

const logDebug = (msg, ctx)=>log("DEBUG", msg, ctx);
const logInfo = (msg, ctx)=>log("INFO", msg, ctx);
const logWarn = (msg, ctx)=>log("WARN", msg, ctx);
const logError = (msg, ctx)=>log("ERROR", msg, ctx);


// *─────────────────────────────────────────────────────────────────────────────*
// * 模块: config.ts
// * 说明: 配置管理，支持环境变量覆盖和服务特定配置
// *─────────────────────────────────────────────────────────────────────────────*

const BUILTIN_PROXIES = {
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
  pplx: { 
    host: "api.perplexity.ai",
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
  const raw = Deno.env.get("PROXY_CONFIG");
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

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const DEFAULT_TIMEOUT = parseInt(Deno.env.get("DEFAULT_TIMEOUT") ?? "60000");
const ENABLE_RETRY = Deno.env.get("ENABLE_RETRY") !== "false";
const MAX_RESPONSE_SIZE = parseInt(Deno.env.get("MAX_RESPONSE_SIZE") ?? "6291456"); // 6MB
const DEFAULT_RETRY_METHODS = ["GET", "HEAD", "OPTIONS"];


// *─────────────────────────────────────────────────────────────────────────────*
// * 模块: utils.ts
// * 说明: 工具函数集合
// *─────────────────────────────────────────────────────────────────────────────*

//** 生成或提取请求 ID *//
function getRequestId(headers) {
  return headers.get("x-request-id") || headers.get("sb-request-id") || crypto.randomUUID();
}

//** 安全的路径处理*//
function sanitizePath(parts) {
  return parts.filter((seg)=>seg && seg !== "." && seg !== "..").map((seg)=>{
    return seg.split('/').map((s)=>encodeURIComponent(s).replace(/%3A/gi, ':')).join('/');
  }).join('/');
}

//** 构建上游 URL *//
function buildUpstreamURL(host, basePath, userPath, search) {
  const cleanBase = basePath?.replace(/^\/|\/$/g, '') || '';
  const cleanUser = userPath.replace(/^\/|\/$/g, '');
  const fullPath = [cleanBase, cleanUser].filter(Boolean).join('/');
  return `https://${host}${fullPath ? '/' + fullPath : ''}${search}`;
}

function categorizeError(error) {
  const msg = error.message.toLowerCase();
  if (error.name === "AbortError" || msg.includes("timeout")) return { type: "TIMEOUT", status: 504, message: "Request timeout - upstream service took too long" };
  if (msg.includes("network") || msg.includes("fetch failed")) return { type: "NETWORK", status: 502, message: "Network error - unable to reach upstream service" };
  if (msg.includes("dns") || msg.includes("getaddrinfo")) return { type: "DNS", status: 502, message: "DNS resolution failed for upstream host" };
  if (msg.includes("connection refused") || msg.includes("econnrefused")) return { type: "CONNECTION", status: 503, message: "Connection refused - upstream service is down" };
  if (msg.includes("ssl") || msg.includes("tls") || msg.includes("certificate")) return { type: "SSL", status: 502, message: "SSL/TLS error - certificate validation failed" };
  return { type: "UNKNOWN", status: 500, message: `Unexpected error: ${error.message}` };
}

//** 带重试的 fetch *//
async function fetchWithRetry(request, config) {
  const { maxRetries, retryableMethods = DEFAULT_RETRY_METHODS, reqId } = config;
  const shouldRetry = maxRetries > 0 && retryableMethods.includes(request.method);

  if (!shouldRetry) {
    logDebug("Retry disabled for this request", { reqId, method: request.method, retryableMethods });
    return fetch(request);
  }

  let lastError = null;
  for(let attempt = 0; attempt <= maxRetries; attempt++){
    try {
      if (attempt > 0) {
        logWarn("Retrying request", { reqId, attempt, maxRetries, url: request.url, method: request.method });
      }
      const clonedRequest = request.clone();
      const response = await fetch(clonedRequest);

      if (attempt < maxRetries && response.status >= 500) {
        logWarn("Server error, will retry", { reqId, status: response.status, attempt });
        throw new Error(`Server error: ${response.status}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) break;
      const errorInfo = categorizeError(error);
      const retryableErrors = ["TIMEOUT", "NETWORK", "CONNECTION", "UNKNOWN"];
      if (!retryableErrors.includes(errorInfo.type)) {
        logDebug("Non-retryable error, giving up", { reqId, errorType: errorInfo.type });
        break;
      }
      const baseDelay = Math.min(100 * Math.pow(2, attempt), 5000);
      const jitter = baseDelay * (Math.random() * 0.3 - 0.15);
      const delay = Math.round(baseDelay + jitter);
      logDebug("Waiting before retry", { reqId, delay_ms: delay, nextAttempt: attempt + 1 });
      await new Promise((resolve)=>setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

//** 创建带大小限制的 Transform Stream（用于流式响应） *//
function createSizeLimitedStream(maxSize, reqId, onSizeExceeded) {
  let totalBytes = 0;
  return new TransformStream({
    transform (chunk, controller) {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxSize) {
        logWarn("Response size limit exceeded", { reqId, totalBytes, maxSize, exceeded_mb: ((totalBytes - maxSize) / 1024 / 1024).toFixed(2) });
        if (onSizeExceeded) onSizeExceeded();
        controller.error(new Error("Response size limit exceeded"));
        return;
      }
      controller.enqueue(chunk);
    },
    flush () {
      logDebug("Stream completed", { reqId, totalBytes, size_mb: (totalBytes / 1024 / 1024).toFixed(2) });
    }
  });
}

// *─────────────────────────────────────────────────────────────────────────────*
// * 模块: index.ts (主逻辑)
// *─────────────────────────────────────────────────────────────────────────────*

//* --- 常量 -----------------------------------------------------------------*//
const PROXIES = loadProxyConfig();
const ALLOWED_REQ_HEADERS = new Set(["content-type", "content-length", "accept", "accept-language", "authorization", "x-api-key", "anthropic-version", "anthropic-beta", "openai-organization", "openai-beta", "user-agent", "x-stainless-lang", "x-stainless-package-version", "x-stainless-os", "x-stainless-arch", "x-stainless-runtime", "x-stainless-runtime-version"]);
const BLACKLISTED_HEADERS = new Set(["host", "connection", "upgrade", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "cookie", "set-cookie"]);
const CORS_ALLOWED_HEADERS = "Content-Type, Authorization, X-Requested-With, anthropic-version, anthropic-beta, x-api-key, openai-beta";
const CORS_EXPOSED_HEADERS = "Content-Type, Content-Length, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-Request-Id";

//* --- 辅助函数 -------------------------------------------------------------*//
function createCorsHeaders() {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH");
  headers.set("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
  headers.set("Access-Control-Expose-Headers", CORS_EXPOSED_HEADERS);
  headers.set("Access-Control-Max-Age", "86400");
  return headers;
}

function createErrorResponse(status, message, reqId, detail) {
  const errorBody = { error: { message, type: detail?.['type'] || 'api_error', request_id: reqId }, status, timestamp: new Date().toISOString(), ...detail && { detail } };
  const headers = createCorsHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Request-Id", reqId);
  return new Response(JSON.stringify(errorBody), { status, headers });
}

function buildForwardHeaders(clientHeaders, proxy) {
  const headers = new Headers();
  if (proxy.defaultHeaders) {
    for (const [key, value] of Object.entries(proxy.defaultHeaders)){
      headers.set(key, value);
    }
  }
  for (const [key, value] of clientHeaders.entries()){
    const lowerKey = key.toLowerCase();
    if (BLACKLISTED_HEADERS.has(lowerKey) || lowerKey.startsWith("sec-ch-")) continue;
    if (ALLOWED_REQ_HEADERS.has(lowerKey)) {
      headers.set(key, value);
    }
  }
  if (!headers.has("user-agent")) {
    headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
  }
  headers.delete("accept-encoding");
  return headers;
}

function processResponseHeaders(upstreamHeaders, reqId) {
  const headers = new Headers(upstreamHeaders);
  const corsHeaders = createCorsHeaders();
  for (const [key, value] of corsHeaders.entries()){
    headers.set(key, value);
  }
  headers.set("X-Request-Id", reqId);
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  headers.delete("server");
  headers.delete("x-powered-by");
  headers.delete("via");
  return headers;
}

//* --- 主服务 ---------------------------------------------------------------*//
serve(async (req)=>{
  const startTime = performance.now();
  const reqId = getRequestId(req.headers);
  const { method } = req;
  const { pathname, search } = new URL(req.url);

  logInfo("Incoming request", { reqId, method, path: pathname, ip: req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(',')[0] || "unknown" });

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: createCorsHeaders() });
  }

  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    logWarn("Invalid path format", { reqId, path: pathname });
    return createErrorResponse(400, "Invalid path. Expected: /gateway/{service}/{path}", reqId, { availableServices: Object.keys(PROXIES) });
  }

  const [, serviceAlias, ...pathSegments] = segments;
  const proxy = PROXIES[serviceAlias];
  if (!proxy) {
    logWarn("Service not found", { reqId, service: serviceAlias });
    return createErrorResponse(404, `Service '${serviceAlias}' not found`, reqId, { availableServices: Object.keys(PROXIES) });
  }

  const userPath = sanitizePath(pathSegments);
  const upstreamURL = buildUpstreamURL(proxy.host, proxy.basePath, userPath, search);
  logDebug("Routing request", { reqId, service: serviceAlias, upstream: upstreamURL });

  const forwardHeaders = buildForwardHeaders(req.headers, proxy);
  const timeout = proxy.timeout || DEFAULT_TIMEOUT;
  const abortController = new AbortController();
  const timeoutId = setTimeout(()=>abortController.abort(), timeout);

  const upstreamRequest = new Request(upstreamURL, { method, headers: forwardHeaders, body: req.body, redirect: "follow", signal: abortController.signal, duplex: "half" });

  let upstreamResponse;
  try {
    upstreamResponse = await fetchWithRetry(upstreamRequest, { maxRetries: ENABLE_RETRY ? proxy.maxRetries ?? 2 : 0, retryableMethods: proxy.retryableMethods, reqId });
  } catch (error) {
    clearTimeout(timeoutId);
    const errorInfo = categorizeError(error);
    logError("Upstream request failed", { reqId, service: serviceAlias, errorType: errorInfo.type, error: error.message, upstream: upstreamURL });
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
});

//* --- 启动日志 ------------------------------------------------------------*//
logInfo("🚀 Edge proxy service started", {
  version: "1.0.0",
  services: Object.keys(PROXIES).length,
  config: {
    allowedOrigin: ALLOWED_ORIGIN,
    defaultTimeout: DEFAULT_TIMEOUT,
    retryEnabled: ENABLE_RETRY,
    maxResponseSize: `${(MAX_RESPONSE_SIZE / 1024 / 1024).toFixed(1)}MB`
  }
});
