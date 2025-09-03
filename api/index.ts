/**
 * Vercel Edge Function - API 网关代理服务
 * 
 * 本服务提供了一个统一的代理接口，用于转发请求到不同的上游服务。
 * 支持多种 AI 服务提供商，包括 OpenAI、Anthropic、Google 等。
 * 
 * @version 1.0.0
 * @description 一个高性能的 Edge Function 代理服务，支持重试、超时、响应大小限制等功能
 */

import type { Request } from 'fetch';

// 配置 Vercel Edge Function 运行时
export const config = {
  runtime: 'edge',
};

/**
 * 主请求处理函数
 * 
 * 处理传入的请求并将其路由到对应的上游服务，支持错误处理、重试、CORS 等功能
 * 
 * @param {Request} req - 传入的请求对象
 * @returns {Promise<Response>} - 返回处理后的响应对象
 */
export default async function handler(req: Request) {
  const startTime = performance.now();
  const reqId = getRequestId(req.headers);
  const { method } = req;
  const originalUrl = new URL(req.url);
  const { pathname, searchParams } = originalUrl; // 使用 searchParams 以便过滤

  logInfo("收到请求", { 
    reqId, 
    method, 
    path: pathname, 
    ip: req.headers.get("x-forwarded-for") || "unknown" 
  });

  // 处理 OPTIONS 请求（CORS 预检）
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: createCorsHeaders() });
  }

  // 清理路径，移除可能的前缀
  const cleanedPathname = pathname.startsWith('/gateway') ? pathname.replace('/gateway', '') : pathname;
  
  // 解析路径段，验证格式
  const segments = cleanedPathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    logWarn("路径格式无效", { reqId, path: cleanedPathname });
    return createErrorResponse(
      400, 
      "无效的路径。期望格式: /{service}/{path}", 
      reqId, 
      { availableServices: Object.keys(PROXIES) }
    );
  }

  // 提取服务别名和用户路径
  const [serviceAlias, ...pathSegments] = segments;
  const proxy = PROXIES[serviceAlias];
  
  // 验证服务是否存在
  if (!proxy) {
    logWarn("服务未找到", { reqId, service: serviceAlias });
    return createErrorResponse(
      404, 
      `服务 '${serviceAlias}' 未找到`, 
      reqId, 
      { availableServices: Object.keys(PROXIES) }
    );
  }
  
  // 直接从原始请求中复制所有查询参数，不再使用严格的白名单
  const newSearchParams = new URLSearchParams(searchParams);

  // 如果未来确实需要移除某些内部参数，可以在这里操作
  // newSearchParams.delete('some_internal_param_to_remove');
  
  const finalSearch = newSearchParams.toString() ? `?${newSearchParams.toString()}` : '';

  // 构建用户路径和上游 URL
  const userPath = sanitizePath(pathSegments);
  const upstreamURL = buildUpstreamURL(proxy.host, proxy.basePath, userPath, finalSearch); // 使用过滤后的 finalSearch
  logDebug("路由请求", { reqId, service: serviceAlias, upstream: upstreamURL });

  // 构建转发请求头和超时控制
  const forwardHeaders = buildForwardHeaders(req.headers, proxy);
  const timeout = proxy.timeout || DEFAULT_TIMEOUT;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeout);

  // 创建上游请求
  const upstreamRequest = new Request(upstreamURL, { 
    method, 
    headers: forwardHeaders, 
    body: req.body, 
    redirect: "follow", 
    signal: abortController.signal 
  });

  let upstreamResponse;
  try {
    // 发起请求，支持重试
    upstreamResponse = await fetchWithRetry(upstreamRequest, { 
      maxRetries: ENABLE_RETRY ? proxy.maxRetries ?? 2 : 0, 
      retryableMethods: proxy.retryableMethods, 
      reqId 
    });
  } catch (error) {
    clearTimeout(timeoutId);
    const errorInfo = categorizeError(error as Error);
    logError("上游请求失败", { 
      reqId, 
      service: serviceAlias, 
      errorType: errorInfo.type, 
      error: (error as Error).message, 
      upstream: upstreamURL 
    });
    return createErrorResponse(
      errorInfo.status, 
      errorInfo.message, 
      reqId, 
      { type: errorInfo.type, upstream: upstreamURL }
    );
  } finally {
    clearTimeout(timeoutId);
  }

  // 处理响应头
  const responseHeaders = processResponseHeaders(upstreamResponse.headers, reqId);
  
  // 检查响应大小限制
  const maxSize = proxy.maxResponseSize || MAX_RESPONSE_SIZE;
  const contentLength = upstreamResponse.headers.get("content-length");

  if (contentLength) {
    const size = parseInt(contentLength);
    if (size > maxSize) {
      logWarn("响应大小超过限制（预检查）", { 
        reqId, 
        size_bytes: size, 
        size_mb: (size / 1024 / 1024).toFixed(2), 
        limit_mb: (maxSize / 1024 / 1024).toFixed(2) 
      });
    }
  }

  // 处理响应体流
  let responseBody = upstreamResponse.body;
  if (responseBody && !contentLength && maxSize > 0) {
    const sizeMonitor = createSizeLimitedStream(maxSize, reqId);
    responseBody = responseBody.pipeThrough(sizeMonitor);
  }

  // 记录请求完成信息
  const duration = Math.round(performance.now() - startTime);
  const logContext = { 
    reqId, 
    status: upstreamResponse.status, 
    duration_ms: duration, 
    service: serviceAlias, 
    ...contentLength && { size_bytes: parseInt(contentLength) } 
  };
  
  if (upstreamResponse.status >= 400) {
    logWarn("请求完成", logContext);
  } else {
    logInfo("请求完成", logContext);
  }

  // 返回最终响应
  return new Response(responseBody, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders
  });
}

// =================== 日志模块 ===================

/**
 * 上海时区的时间格式化器
 */
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

/**
 * 获取当前上海时间
 * 
 * @returns {string} 格式化的上海时间字符串
 */
function toShanghaiTime() {
  return shanghaiTimeFormatter.format(new Date()).replace(/\//g, '-');
}

/**
 * 日志记录函数
 * 
 * @param {'DEBUG' | 'INFO' | 'WARN' | 'ERROR'} level - 日志级别
 * @param {string} message - 日志消息
 * @param {Record<string, any>} [context] - 上下文对象
 */
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
      const contextStr = Object.entries(rest)
        .map(([k, v]) => {
          if (v === undefined || v === null) return null;
          if (typeof v === 'object') return `${k}=${JSON.stringify(v)}`;
          return `${k}=${v}`;
        })
        .filter(Boolean)
        .join(' ');
      if (contextStr) logStr += ` | ${contextStr}`;
    }
  }
  console.log(logStr);
}

/**
 * 记录调试级别日志
 * 
 * @param {string} msg - 日志消息
 * @param {Record<string, any>} [ctx] - 上下文对象
 */
const logDebug = (msg: string, ctx?: Record<string, any>) => log("DEBUG", msg, ctx);

/**
 * 记录信息级别日志
 * 
 * @param {string} msg - 日志消息
 * @param {Record<string, any>} [ctx] - 上下文对象
 */
const logInfo = (msg: string, ctx?: Record<string, any>) => log("INFO", msg, ctx);

/**
 * 记录警告级别日志
 * 
 * @param {string} msg - 日志消息
 * @param {Record<string, any>} [ctx] - 上下文对象
 */
const logWarn = (msg: string, ctx?: Record<string, any>) => log("WARN", msg, ctx);

/**
 * 记录错误级别日志
 * 
 * @param {string} msg - 日志消息
 * @param {Record<string, any>} [ctx] - 上下文对象
 */
const logError = (msg: string, ctx?: Record<string, any>) => log("ERROR", msg, ctx);

// =================== 配置模块 ===================

/**
 * 环境变量获取函数
 * 
 * @param {string} key - 环境变量键名
 * @param {string} [defaultValue] - 默认值
 * @returns {string | undefined} - 环境变量值或默认值
 */
function getEnv(key: string, defaultValue?: string): string | undefined {
  return (globalThis as any).process?.env[key] ?? defaultValue;
}

/**
 * 内置代理服务配置
 * 
 * 包含了支持的各个上游服务的主机名、基础路径、重试配置等信息
 */
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
  chataw: { 
    host: "api.chatanywhere.tech",
    retryable: true,
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"]
  },
};

/**
 * 加载代理配置
 * 
 * 合并内置配置与环境变量中的自定义配置
 * 
 * @returns {Record<string, any>} - 合并后的代理配置
 */
function loadProxyConfig() {
  const raw = getEnv("PROXY_CONFIG");
  if (!raw) return BUILTIN_PROXIES;
  
  try {
    const parsed = JSON.parse(raw);
    const merged = { ...BUILTIN_PROXIES };
    
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'object' && value !== null) {
        merged[key] = { ...BUILTIN_PROXIES[key], ...value };
      }
    }
    
    return merged;
  } catch (e) {
    console.error("⚠️ 无效的 PROXY_CONFIG JSON，使用内置配置", e);
    return BUILTIN_PROXIES;
  }
}

// 环境变量配置
const ALLOWED_ORIGIN = getEnv("ALLOWED_ORIGIN", "*");
const DEFAULT_TIMEOUT = parseInt(getEnv("DEFAULT_TIMEOUT", "60000")!, 10);
const ENABLE_RETRY = getEnv("ENABLE_RETRY", "true") !== "false";
const MAX_RESPONSE_SIZE = parseInt(getEnv("MAX_RESPONSE_SIZE", "6291456")!, 10); // 6MB
const DEFAULT_RETRY_METHODS = ["GET", "HEAD", "OPTIONS"];

// =================== 工具函数模块 ===================

/**
 * 从请求头中获取请求ID
 * 
 * 如果请求头中没有，则生成一个随机的UUID
 * 
 * @param {Headers} headers - 请求头对象
 * @returns {string} - 请求ID
 */
function getRequestId(headers: Headers): string {
  return headers.get("x-request-id") || headers.get("sb-request-id") || crypto.randomUUID();
}

/**
 * 清理路径，确保安全性
 * 
 * 过滤掉 `.` 和 `..` 等潜在危险的路径段，并对路径进行编码
 * 
 * @param {string[]} parts - 路径段数组
 * @returns {string} - 清理后的安全路径
 */
function sanitizePath(parts: string[]): string {
  return parts
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .map((seg) => {
      return seg.split('/')
        .map((s) => encodeURIComponent(s).replace(/%3A/gi, ':'))
        .join('/');
    })
    .join('/');
}

/**
 * 构建上游URL
 * 
 * 根据主机、基础路径、用户路径和查询参数构建完整的上游URL
 * 
 * @param {string} host - 上游主机
 * @param {string} basePath - 基础路径
 * @param {string} userPath - 用户路径
 * @param {string} search - 查询字符串
 * @returns {string} - 完整的上游URL
 */
function buildUpstreamURL(host: string, basePath: string, userPath: string, search: string): string {
  const cleanBase = basePath?.replace(/^\/|\/$/g, '') || '';
  const cleanUser = userPath.replace(/^\/|\/$/g, '');
  const fullPath = [cleanBase, cleanUser].filter(Boolean).join('/');
  return `https://${host}${fullPath ? '/' + fullPath : ''}${search}`;
}

/**
 * 错误分类处理
 * 
 * 根据错误消息和类型对错误进行分类，返回适合的状态码和消息
 * 
 * @param {Error} error - 错误对象
 * @returns {{type: string, status: number, message: string}} - 错误分类信息
 */
function categorizeError(error: Error) {
  const msg = error.message.toLowerCase();
  
  if (error.name === "AbortError" || msg.includes("timeout")) {
    return { 
      type: "TIMEOUT", 
      status: 504, 
      message: "请求超时 - 上游服务响应时间过长" 
    };
  }
  
  if (msg.includes("network") || msg.includes("fetch failed")) {
    return { 
      type: "NETWORK", 
      status: 502, 
      message: "网络错误 - 无法连接到上游服务" 
    };
  }
  
  if (msg.includes("dns") || msg.includes("getaddrinfo")) {
    return { 
      type: "DNS", 
      status: 502, 
      message: "DNS 解析失败 - 无法解析上游主机" 
    };
  }
  
  if (msg.includes("connection refused") || msg.includes("econnrefused")) {
    return { 
      type: "CONNECTION", 
      status: 503, 
      message: "连接被拒绝 - 上游服务不可用" 
    };
  }
  
  if (msg.includes("ssl") || msg.includes("tls") || msg.includes("certificate")) {
    return { 
      type: "SSL", 
      status: 502, 
      message: "SSL/TLS 错误 - 证书验证失败" 
    };
  }
  
  return { 
    type: "UNKNOWN", 
    status: 500, 
    message: `未知错误: ${error.message}` 
  };
}

/**
 * 带重试功能的请求函数
 * 
 * 在请求失败时进行重试，支持指数退避算法
 * 
 * @param {Request} request - 请求对象
 * @param {object} config - 配置对象
 * @param {number} config.maxRetries - 最大重试次数
 * @param {string[]} [config.retryableMethods] - 可重试的HTTP方法
 * @param {string} config.reqId - 请求ID
 * @returns {Promise<Response>} - 响应对象
 */
async function fetchWithRetry(request: Request, config: { maxRetries: number, retryableMethods?: string[], reqId: string }) {
  const { maxRetries, retryableMethods = DEFAULT_RETRY_METHODS, reqId } = config;
  
  // 如果禁用重试或方法不支持重试，直接发起请求
  if (!(maxRetries > 0 && retryableMethods.includes(request.method))) {
    return fetch(request);
  }
  
  let lastError: unknown = null;
  
  // 重试逻辑
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        logWarn("重试请求", { 
          reqId, 
          attempt, 
          maxRetries, 
          url: request.url, 
          method: request.method 
        });
      }
      
      const clonedRequest = request.clone();
      const response = await fetch(clonedRequest);
      
      // 如果收到服务器错误且还有重试机会，则抛出错误以触发重试
      if (attempt < maxRetries && response.status >= 500) {
        throw new Error(`服务器错误: ${response.status}`);
      }
      
      return response;
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) break;
      
      const errorInfo = categorizeError(error as Error);
      
      // 只对特定类型的错误进行重试
      if (!["TIMEOUT", "NETWORK", "CONNECTION", "UNKNOWN"].includes(errorInfo.type)) {
        break;
      }
      
      // 指数退避算法，带有随机抖动
      const delay = Math.min(100 * Math.pow(2, attempt), 5000) * (1 + (Math.random() - 0.5) * 0.3);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

/**
 * 创建大小限制流
 * 
 * 对响应流进行监控，确保响应大小不超过限制
 * 
 * @param {number} maxSize - 最大允许字节数
 * @param {string} reqId - 请求ID
 * @returns {TransformStream} - 带大小限制的转换流
 */
function createSizeLimitedStream(maxSize: number, reqId: string) {
  let totalBytes = 0;
  
  return new TransformStream({
    transform(chunk, controller) {
      totalBytes += chunk.byteLength;
      
      if (totalBytes > maxSize) {
        logWarn("响应大小超过限制", { 
          reqId, 
          totalBytes, 
          maxSize 
        });
        controller.error(new Error("响应大小超过限制"));
        return;
      }
      
      controller.enqueue(chunk);
    }
  });
}

// =================== 主逻辑模块 ===================

// 加载代理配置
const PROXIES = loadProxyConfig();

// 允许转发的请求头白名单
const ALLOWED_REQ_HEADERS = new Set([
  "content-type", 
  "content-length", 
  "accept", 
  "authorization", 
  "x-api-key", 
  "anthropic-version", 
  "user-agent"
]);

// 禁止转发的请求头黑名单
const BLACKLISTED_HEADERS = new Set([
  "host", 
  "connection", 
  "cf-connecting-ip", 
  "x-forwarded-for", 
  "cookie"
]);

// CORS 相关配置
const CORS_ALLOWED_HEADERS = "Content-Type, Authorization, X-Requested-With, anthropic-version";
const CORS_EXPOSED_HEADERS = "Content-Type, Content-Length, X-Request-Id";

/**
 * 创建 CORS 响应头
 * 
 * @returns {Headers} - 包含 CORS 配置的响应头
 */
function createCorsHeaders() {
  const headers = new Headers();
  
  headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD");
  headers.set("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
  headers.set("Access-Control-Expose-Headers", CORS_EXPOSED_HEADERS);
  headers.set("Access-Control-Max-Age", "86400");
  
  return headers;
}

/**
 * 创建错误响应
 * 
 * 生成包含错误信息的标准 JSON 响应
 * 
 * @param {number} status - HTTP状态码
 * @param {string} message - 错误消息
 * @param {string} reqId - 请求ID
 * @param {object} [detail] - 额外的错误详情
 * @returns {Response} - 错误响应对象
 */
function createErrorResponse(status: number, message: string, reqId: string, detail?: object) {
  const errorBody = { 
    error: { 
      message, 
      type: 'api_error', 
      request_id: reqId 
    }, 
    status, 
    ...detail 
  };
  
  const headers = createCorsHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Request-Id", reqId);
  
  return new Response(JSON.stringify(errorBody), { 
    status, 
    headers 
  });
}

/**
 * 构建转发请求头
 * 
 * 处理客户端请求头，过滤黑名单，添加默认头，构建适合上游的请求头
 * 
 * @param {Headers} clientHeaders - 客户端请求头
 * @param {any} proxy - 代理配置
 * @returns {Headers} - 处理后的转发请求头
 */
function buildForwardHeaders(clientHeaders: Headers, proxy: any) {
  const headers = new Headers();
  
  // 添加代理配置中的默认请求头
  if (proxy.defaultHeaders) {
    Object.entries(proxy.defaultHeaders).forEach(([key, value]) => {
      headers.set(key, value as string);
    });
  }
  
  // 处理客户端请求头，只转发白名单中的头
  for (const [key, value] of clientHeaders.entries()) {
    const lowerKey = key.toLowerCase();
    
    if (!BLACKLISTED_HEADERS.has(lowerKey) && ALLOWED_REQ_HEADERS.has(lowerKey)) {
      headers.set(key, value);
    }
  }
  
  // 设置默认 User-Agent
  if (!headers.has("user-agent")) {
    headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
  }
  
  // 删除 Accept-Encoding，让浏览器自动处理
  headers.delete("accept-encoding");
  
  return headers;
}

/**
 * 处理响应头
 * 
 * 处理上游返回的响应头，添加 CORS 头，移除不必要的头
 * 
 * @param {Headers} upstreamHeaders - 上游响应头
 * @param {string} reqId - 请求ID
 * @returns {Headers} - 处理后的响应头
 */
function processResponseHeaders(upstreamHeaders: Headers, reqId: string) {
  const headers = new Headers(upstreamHeaders);
  
  // 添加 CORS 头
  const corsHeaders = createCorsHeaders();
  for (const [key, value] of corsHeaders.entries()) {
    headers.set(key, value);
  }
  
  // 添加请求ID
  headers.set("X-Request-Id", reqId);
  
  // 移除不必要的头
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  headers.delete("server");
  
  return headers;
}

// 启动日志（Vercel环境中只在构建时或首次调用时打印）
logInfo("🚀 Vercel Edge 代理服务已配置", {
  version: "1.0.0",
  services: Object.keys(PROXIES).length
});
