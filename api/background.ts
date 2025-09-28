/* /api/background.ts */
export const runtime = "nodejs";
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

const NODE_TIMEOUT_CAP = 290000;
const RETRY_STATUS_CODES = [408, 409, 425, 429, 500, 502, 503, 504];

function resolveParams(req: Request, headers: Headers) {
  const service = headers.get("x-gateway-target-service");
  const rawPath = headers.get("x-gateway-target-path") ?? "";
  const query = headers.get("x-gateway-target-query") ?? "";

  if (service) {
    return {
      service,
      userPath: sanitizePath(rawPath ? rawPath.split("/") : []),
      originalSearch: query ? `?${query}` : "",
    };
  }

  const url = req.url.startsWith("http://") || req.url.startsWith("https://")
    ? new URL(req.url)
    : (() => {
        const host = headers.get("host") ?? "localhost";
        const proto = headers.get("x-forwarded-proto") ?? "https";
        return new URL(req.url.startsWith("/") ? req.url : `/${req.url}`, `${proto}://${host}`);
      })();

  const directService = url.searchParams.get("service");
  const targetPath = url.searchParams.get("targetPath") ?? "";
  const targetQuery = url.searchParams.get("targetQuery") ?? "";

  return {
    service: directService,
    userPath: sanitizePath(targetPath ? targetPath.split("/") : []),
    originalSearch: targetQuery ? `?${targetQuery}` : "",
  };
}

async function readBody(response: Response) {
  const buffer = await response.arrayBuffer();
  return { buffer, size: buffer.byteLength };
}

export default async function handler(req: Request) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: createCorsHeaders() });
  }

  const incomingHeaders = new Headers(req.headers);
  const reqId = getRequestId(incomingHeaders);
  const { service, userPath, originalSearch } = resolveParams(req, incomingHeaders);

  if (!service) {
    return createErrorResponse(400, "缺少目标服务标识", reqId);
  }

  const proxy = PROXIES[service];
  if (!proxy) {
    return createErrorResponse(404, `服务 ${service} 未配置`, reqId);
  }

  logInfo("Background 处理请求", {
    reqId,
    method: req.method,
    service,
    path: userPath || "/",
  });

  const fallbackSearch = originalSearch || (() => {
    try {
      return req.url.startsWith("http")
        ? new URL(req.url).search
        : new URL(req.url, `https://${incomingHeaders.get("host") ?? "localhost"}`).search;
    } catch {
      return "";
    }
  })();

  const upstreamURL = buildUpstreamURL(proxy.host, proxy.basePath, userPath, fallbackSearch);
  const forwardHeaders = buildForwardHeaders(incomingHeaders, proxy);
  forwardHeaders.set("X-Request-Id", reqId);
  forwardHeaders.set("X-Background-Handler", "true");

  const timeoutPerAttempt = Math.min(proxy.timeout ?? DEFAULT_TIMEOUT, NODE_TIMEOUT_CAP);
  const retries = proxy.retryable ? 2 : 0;

  try {
    const upstreamResp = await fetchWithRetry(
      upstreamURL,
      {
        method: req.method,
        headers: forwardHeaders,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      },
      {
        retries,
        retryableMethods: proxy.retryableMethods ?? ["GET", "HEAD", "POST", "PUT", "OPTIONS"],
        retryStatusCodes: RETRY_STATUS_CODES,
        timeoutPerAttempt,
        baseDelay: 300,
        maxDelay: 2500,
        jitter: 0.3,
        reqId,
        label: `${service}-background`,
      }
    );

    const limit = proxy.maxResponseSize ?? MAX_RESPONSE_SIZE;
    const { buffer, size } = await readBody(upstreamResp);
    if (size > limit) {
      logWarn("响应超出大小限制", { reqId, service, size, limit });
      return createErrorResponse(413, "响应体超过允许的大小限制", reqId, { limit, actual: size });
    }

    const processedHeaders = processResponseHeaders(upstreamResp.headers, reqId);
    processedHeaders.set("X-Upstream-Status", `${upstreamResp.status}`);
    logDebug("Background 返回结果", { reqId, status: upstreamResp.status, size });

    return new Response(buffer, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: processedHeaders,
    });
  } catch (err) {
    const { status, message, type } = categorizeError(err as Error);
    logError("Background 请求失败", { reqId, service, type, message, status });
    return createErrorResponse(status, message, reqId, { service });
  }
}
