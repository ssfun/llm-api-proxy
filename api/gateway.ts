/* /api/gateway.ts */
export const runtime = 'edge';

import {
  PROXIES,
  DEFAULT_TIMEOUT,
  MAX_RESPONSE_SIZE,
  buildForwardHeaders,
  buildUpstreamURL,
  categorizeError,
  createCorsHeaders,
  createErrorResponse,
  fetchWithRetry,
  getRequestId,
  isStreamRequested,
  logDebug,
  logError,
  logInfo,
  logWarn,
  processResponseHeaders,
  sanitizePath,
  SizeLimitExceededError,
} from "./config";

const EDGE_FIRST_BYTE_LIMIT = 23000;
const EDGE_MAX_RESPONSE_SIZE = MAX_RESPONSE_SIZE;
const RETRY_HTTP_CODES = [408, 409, 425, 429, 500, 502, 503, 504];
const BACKGROUND_ENDPOINT = "/api/background";

function resolveEffectiveTimeout(proxyKey: string) {
  const proxy = PROXIES[proxyKey];
  const specific = proxy?.timeout ?? DEFAULT_TIMEOUT;
  return Math.min(specific, EDGE_FIRST_BYTE_LIMIT);
}

function cloneAllowedHeaders(headers: Headers) {
  const result = new Headers();
  for (const [key, value] of headers.entries()) result.set(key, value);
  return result;
}

async function detectStreamIntent(req: Request) {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.startsWith("application/json")) return isStreamRequested(req);
  try {
    const parsed = await req.clone().json();
    return isStreamRequested(req, parsed);
  } catch {
    return isStreamRequested(req);
  }
}

// 安全获取完整 URL
function getFullUrl(request: Request): URL {
  // Edge Runtime 中，request.url 可能只是路径
  const urlString = request.url;
  
  // 如果已经是完整 URL，直接使用
  if (urlString.startsWith('http://') || urlString.startsWith('https://')) {
    return new URL(urlString);
  }
  
  // 否则，从 headers 构造完整 URL
  const host = request.headers.get('host') || request.headers.get('x-forwarded-host') || 'localhost';
  const proto = request.headers.get('x-forwarded-proto') || 'https';
  
  // 构造完整 URL
  return new URL(urlString, `${proto}://${host}`);
}

async function handoffToBackground(
  req: Request,
  ctx: { service: string; userPath: string; reqId: string; requestUrl: URL }
) {
  const { service, userPath, reqId, requestUrl } = ctx;
  const query = requestUrl.search ? requestUrl.search.slice(1) : "";
  const bodyBuffer = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();

  const headers = cloneAllowedHeaders(req.headers);
  headers.set("x-gateway-target-service", service);
  headers.set("x-gateway-target-path", userPath);
  headers.set("x-request-id", reqId);
  if (query) headers.set("x-gateway-target-query", query);
  headers.set("x-gateway-dispatcher", "edge");

  const backgroundUrl = new URL(BACKGROUND_ENDPOINT, requestUrl.origin);
  const response = await fetch(backgroundUrl.toString(), {
    method: req.method,
    headers,
    body: bodyBuffer ? new Uint8Array(bodyBuffer) : undefined,
  });

  const processedHeaders = processResponseHeaders(response.headers, reqId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: processedHeaders,
  });
}

function enforceStreamLimit(stream: ReadableStream<Uint8Array>, limit: number, reqId: string) {
  const reader = stream.getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      total += value.byteLength;
      if (total > limit) {
        controller.error(new SizeLimitExceededError(limit, total));
        await reader.cancel();
        logWarn("流式响应被截断", { reqId, total, limit });
        return;
      }
      controller.enqueue(value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

async function handleStreamRequest(
  req: Request,
  ctx: { service: string; userPath: string; reqId: string; requestUrl: URL }
) {
  const { service, userPath, reqId, requestUrl } = ctx;
  const proxy = PROXIES[service];
  if (!proxy) return createErrorResponse(404, `未找到服务 ${service}`, reqId);

  const upstreamURL = buildUpstreamURL(proxy.host, proxy.basePath, userPath, requestUrl.search);
  const forwardHeaders = buildForwardHeaders(req.headers, proxy);
  forwardHeaders.set("X-Request-Id", reqId);

  const effectiveTimeout = resolveEffectiveTimeout(service);
  logDebug("准备发起流式请求", { reqId, upstreamURL, timeout: effectiveTimeout });

  try {
    const response = await fetchWithRetry(
      upstreamURL,
      {
        method: req.method,
        headers: forwardHeaders,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      },
      {
        retries: proxy.retryable ? 2 : 0,
        retryableMethods: proxy.retryableMethods ?? ["GET", "HEAD", "OPTIONS", "POST"],
        retryStatusCodes: RETRY_HTTP_CODES,
        timeoutPerAttempt: effectiveTimeout,
        baseDelay: 200,
        maxDelay: 2000,
        jitter: 0.25,
        reqId,
        label: service,
      }
    );

    const limit = proxy.maxResponseSize ?? EDGE_MAX_RESPONSE_SIZE;
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > limit) {
      logWarn("响应 Content-Length 超限", { reqId, limit, contentLength });
      return createErrorResponse(413, "响应体超过 Edge 允许的大小限制", reqId, {
        limit,
        content_length: Number(contentLength),
      });
    }

    const processedHeaders = processResponseHeaders(response.headers, reqId);
    processedHeaders.set("X-Upstream-Status", `${response.status}`);

    if (!response.body) {
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: processedHeaders,
      });
    }

    const limitedStream = enforceStreamLimit(response.body, limit, reqId);
    return new Response(limitedStream, {
      status: response.status,
      statusText: response.statusText,
      headers: processedHeaders,
    });
  } catch (err) {
    if (err instanceof SizeLimitExceededError) {
      return createErrorResponse(413, "响应体超过 Edge 允许的大小限制", reqId, {
        limit: err.maxBytes,
        actual: err.actualBytes,
      });
    }
    const { status, message } = categorizeError(err as Error);
    logError("流式请求失败", { reqId, message, status, service });
    return createErrorResponse(status, message, reqId, { service });
  }
}

export default async function handler(req: Request) {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: createCorsHeaders() });
    }

    // 使用安全的 URL 获取方法
    const url = getFullUrl(req);
    const reqId = getRequestId(req.headers);

    // 处理路径，支持 /api/gateway 和 /gateway
    const pathname = url.pathname;
    const pathWithoutApi = pathname.replace(/^\/api\//, '/');
    const segments = pathWithoutApi.replace(/^\/+|\/+$/g, "").split("/");
    
    // 记录调试信息
    logDebug("请求路径解析", {
      reqId,
      originalUrl: req.url,
      pathname,
      pathWithoutApi,
      segments: segments.join('/'),
    });

    if (segments[0] !== "gateway") {
      return createErrorResponse(404, "未匹配到网关路径", reqId, {
        receivedPath: pathname,
        expectedPrefix: "/gateway",
      });
    }

    if (segments.length < 3) {
      return createErrorResponse(400, "缺少上游路径参数", reqId, {
        hint: "路径格式应为: /gateway/{service}/{path}",
        receivedSegments: segments.length,
      });
    }

    const service = segments[1];
    const proxy = PROXIES[service];
    if (!proxy) {
      return createErrorResponse(404, `服务 ${service} 未配置`, reqId, {
        availableServices: Object.keys(PROXIES),
      });
    }

    const userPath = sanitizePath(segments.slice(2));
    logInfo("Edge 收到请求", {
      reqId,
      method: req.method,
      path: pathname,
      service,
      userPath,
      streamCheck: "pending",
    });

    const streamIntent = await detectStreamIntent(req);
    logDebug("流式判定结果", { reqId, stream: streamIntent });

    if (!streamIntent) {
      return handoffToBackground(req, { service, userPath, reqId, requestUrl: url });
    }

    return handleStreamRequest(req, { service, userPath, reqId, requestUrl: url });
  } catch (error) {
    const reqId = getRequestId(req.headers);
    logError("处理请求时发生错误", {
      reqId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return createErrorResponse(500, "内部服务器错误", reqId, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
