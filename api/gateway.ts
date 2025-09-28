/* /api/gateway.ts */
export const runtime = "edge";

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

const EDGE_HARD_TIMEOUT = 23000;
const EDGE_MAX_BODY = MAX_RESPONSE_SIZE;
const RETRY_HTTP_CODES = [408, 409, 425, 429, 500, 502, 503, 504];

interface ParsedRoute {
  service: string;
  userPath: string;
  search: string;
  url: URL;
  originalPath: string;
}

function ensureAbsoluteURL(req: Request, headers: Headers) {
  if (req.url.startsWith("http://") || req.url.startsWith("https://")) {
    return new URL(req.url);
  }
  const host = headers.get("host") ?? "localhost";
  const proto = headers.get("x-forwarded-proto") ?? "https";
  const base = `${proto}://${host}`;
  return new URL(req.url.startsWith("/") ? req.url : `/${req.url}`, base);
}

function parseRoute(req: Request, headers: Headers): ParsedRoute | null {
  const url = ensureAbsoluteURL(req, headers);

  const serviceParam = url.searchParams.get("service");
  const pathParam = url.searchParams.get("path");
  if (serviceParam) {
    const cleaned = new URLSearchParams(url.searchParams);
    cleaned.delete("service");
    cleaned.delete("path");

    const normalizedPath = pathParam
      ? sanitizePath(decodeURIComponent(pathParam).split("/"))
      : "";

    return {
      service: serviceParam,
      userPath: normalizedPath,
      search: cleaned.toString() ? `?${cleaned.toString()}` : "",
      url,
      originalPath: `/gateway/${serviceParam}/${normalizedPath}`,
    };
  }

  let pathname = url.pathname;
  if (pathname.startsWith("/api/")) pathname = pathname.slice(4);

  const segments = pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (segments[0] !== "gateway" || segments.length < 3) return null;

  const service = segments[1];
  const userPath = sanitizePath(segments.slice(2));
  return {
    service,
    userPath,
    search: url.search,
    url,
    originalPath: pathname,
  };
}

function resolveEdgeTimeout(service: string) {
  const proxy = PROXIES[service];
  return Math.min(proxy?.timeout ?? DEFAULT_TIMEOUT, EDGE_HARD_TIMEOUT);
}

function buildBackgroundHeaders(source: Headers, extras: Record<string, string>, hasBody: boolean) {
  const whitelist = new Set([
    "accept",
    "accept-language",
    "content-type",
    "content-length",
    "authorization",
    "user-agent",
    "x-api-key",
    "x-goog-api-key",
  ]);
  const headers = new Headers();
  for (const [key, value] of source.entries()) {
    const lower = key.toLowerCase();
    if (whitelist.has(lower) || lower.startsWith("x-")) {
      headers.set(key, value);
    }
  }
  Object.entries(extras).forEach(([k, v]) => headers.set(k, v));
  if (!hasBody) headers.delete("content-length");
  return headers;
}

function limitStream(stream: ReadableStream<Uint8Array>, limit: number, reqId: string) {
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
        await reader.cancel("size_exceeded");
        logWarn("响应超过限制，终止传输", { reqId, total, limit });
        return;
      }
      controller.enqueue(value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

async function forwardViaEdge(req: Request, ctx: { service: string; userPath: string; search: string; reqId: string; headers: Headers; streaming: boolean }) {
  const { service, userPath, search, reqId, headers, streaming } = ctx;
  const proxy = PROXIES[service];
  if (!proxy) return createErrorResponse(404, `服务 ${service} 未配置`, reqId);

  const upstreamURL = buildUpstreamURL(proxy.host, proxy.basePath, userPath, search);
  const forwardHeaders = buildForwardHeaders(headers, proxy);
  forwardHeaders.set("X-Request-Id", reqId);

  const timeout = resolveEdgeTimeout(service);
  logDebug("Edge 直连上游", { reqId, service, upstreamURL, timeout, streaming });

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
        timeoutPerAttempt: timeout,
        baseDelay: 200,
        maxDelay: 1500,
        jitter: 0.25,
        reqId,
        label: `${service}-edge`,
      }
    );

    const limit = proxy.maxResponseSize ?? EDGE_MAX_BODY;
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > limit) {
      logWarn("响应 Content-Length 超限", { reqId, limit, contentLength, service });
      return createErrorResponse(413, "响应体超过 Edge 允许的大小限制", reqId, {
        limit,
        content_length: Number(contentLength),
      });
    }

    const processedHeaders = processResponseHeaders(response.headers, reqId);
    processedHeaders.set("X-Upstream-Status", `${response.status}`);

    if (!response.body) {
      return new Response(null, { status: response.status, statusText: response.statusText, headers: processedHeaders });
    }

    const stream = limitStream(response.body, limit, reqId);
    return new Response(stream, {
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
    logError("Edge 转发失败", { reqId, service, status, message });
    return createErrorResponse(status, message, reqId, { service });
  }
}

async function handoffToBackground(req: Request, ctx: { service: string; userPath: string; search: string; reqId: string; url: URL; headers: Headers }) {
  const { service, userPath, search, reqId, url, headers } = ctx;
  const bodyBuffer = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  const hasBody = bodyBuffer !== undefined;

  const relayHeaders = buildBackgroundHeaders(headers, {
    "x-gateway-target-service": service,
    "x-gateway-target-path": userPath,
    "x-request-id": reqId,
  }, hasBody);

  if (search) {
    relayHeaders.set("x-gateway-target-query", search.startsWith("?") ? search.slice(1) : search);
  }
  relayHeaders.set("x-gateway-dispatcher", "edge");

  const backgroundUrl = new URL("/background", url.origin);
  logInfo("Edge 分流至 Background", { reqId, service, target: backgroundUrl.toString() });

  const response = await fetch(backgroundUrl.toString(), {
    method: req.method,
    headers: relayHeaders,
    body: hasBody ? new Uint8Array(bodyBuffer) : undefined,
    cache: "no-store",
  });

  const processedHeaders = processResponseHeaders(response.headers, reqId);
  processedHeaders.set("X-Background-Proxy", "1");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: processedHeaders,
  });
}

export default async function handler(req: Request) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: createCorsHeaders() });
  }

  const incomingHeaders = new Headers(req.headers);
  const reqId = getRequestId(incomingHeaders);

  const route = parseRoute(req, incomingHeaders);
  if (!route) {
    return createErrorResponse(400, "无效的 Gateway 路径", reqId);
  }

  const { service, userPath, search, url, originalPath } = route;
  if (!PROXIES[service]) {
    return createErrorResponse(404, `服务 ${service} 未配置`, reqId);
  }

  logInfo("Edge 收到请求", {
    reqId,
    method: req.method,
    service,
    path: originalPath,
    search,
  });

  const streaming = await detectStreamIntent(req, incomingHeaders);
  const shouldStayOnEdge = streaming || req.method === "GET" || req.method === "HEAD";

  logDebug("分流决策", {
    reqId,
    streaming,
    method: req.method,
    stayOnEdge: shouldStayOnEdge,
  });

  if (shouldStayOnEdge) {
    return forwardViaEdge(req, {
      service,
      userPath,
      search,
      reqId,
      headers: incomingHeaders,
      streaming,
    });
  }

  return handoffToBackground(req, {
    service,
    userPath,
    search,
    reqId,
    url,
    headers: incomingHeaders,
  });
}
