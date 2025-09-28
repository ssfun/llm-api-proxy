/* /api/background.ts */
export const runtime = 'nodejs';
export const maxDuration = 300;

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
  logDebug,
  logError,
  logInfo,
  logWarn,
  processResponseHeaders,
  sanitizePath,
} from "./config";

const NODE_ATTEMPT_TIMEOUT = 290000;
const RETRY_STATUS_CODES = [408, 409, 425, 429, 500, 502, 503, 504];

function resolveParams(request: Request) {
  const headers = request.headers;
  
  // 从 headers 中获取参数（Edge Gateway 传递过来的）
  const service = headers.get("x-gateway-target-service");
  const rawPath = headers.get("x-gateway-target-path") ?? "";
  const query = headers.get("x-gateway-target-query") ?? "";
  
  if (!service) {
    // 如果不是从 Edge 传递的，尝试从 URL 解析
    try {
      const url = request.url.startsWith('http')
        ? new URL(request.url)
        : new URL(request.url, `https://${headers.get('host') || 'localhost'}`);
      
      return {
        service: url.searchParams.get("service"),
        userPath: sanitizePath((url.searchParams.get("targetPath") ?? "").split("/")),
        originalSearch: url.searchParams.get("targetQuery") ? `?${url.searchParams.get("targetQuery")}` : "",
      };
    } catch {
      return { service: null, userPath: "", originalSearch: "" };
    }
  }
  
  return {
    service,
    userPath: sanitizePath(rawPath.split("/")),
    originalSearch: query ? `?${query}` : "",
  };
}

async function readBody(response: Response) {
  const buffer = await response.arrayBuffer();
  return { buffer, size: buffer.byteLength };
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: createCorsHeaders() });
  }

  const reqId = getRequestId(request.headers);
  const { service, userPath, originalSearch } = resolveParams(request);
  
  if (!service) {
    return createErrorResponse(400, "缺少目标服务标识", reqId);
  }

  const proxy = PROXIES[service];
  if (!proxy) {
    return createErrorResponse(404, `服务 ${service} 未配置`, reqId);
  }

  logInfo("Background 处理请求", {
    reqId,
    method: request.method,
    service,
    path: userPath,
  });

  const upstreamURL = buildUpstreamURL(
    proxy.host,
    proxy.basePath,
    userPath,
    originalSearch
  );
  
  const forwardHeaders = buildForwardHeaders(request.headers, proxy);
  forwardHeaders.set("X-Request-Id", reqId);
  forwardHeaders.set("X-Background-Handler", "true");

  const effectiveTimeout = Math.min(proxy.timeout ?? DEFAULT_TIMEOUT, NODE_ATTEMPT_TIMEOUT);
  const retries = proxy.retryable ? 2 : 0;

  try {
    const response = await fetchWithRetry(
      upstreamURL,
      {
        method: request.method,
        headers: forwardHeaders,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      },
      {
        retries,
        retryableMethods: proxy.retryableMethods ?? ["GET", "HEAD", "POST", "PUT", "OPTIONS"],
        retryStatusCodes: RETRY_STATUS_CODES,
        timeoutPerAttempt: effectiveTimeout,
        baseDelay: 300,
        maxDelay: 2500,
        jitter: 0.3,
        reqId,
        label: `${service}-background`,
      }
    );

    const limit = proxy.maxResponseSize ?? MAX_RESPONSE_SIZE;
    const { buffer, size } = await readBody(response);
    
    if (size > limit) {
      logWarn("响应超出大小限制", { reqId, size, limit, service });
      return createErrorResponse(413, "响应体超过允许的大小限制", reqId, {
        limit,
        actual: size,
      });
    }

    const processedHeaders = processResponseHeaders(response.headers, reqId);
    processedHeaders.set("X-Upstream-Status", `${response.status}`);
    logDebug("Background 返回结果", { reqId, status: response.status, size });

    return new Response(buffer, {
      status: response.status,
      statusText: response.statusText,
      headers: processedHeaders,
    });
  } catch (err) {
    const { status, message, type } = categorizeError(err as Error);
    logError("Background 请求失败", { reqId, service, type, message, status });
    return createErrorResponse(status, message, reqId, { service });
  }
}
