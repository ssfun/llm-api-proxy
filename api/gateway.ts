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

const EDGE_FIRST_BYTE_LIMIT = 23000; // < 25s
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

async function detectStreamIntent(req: Request, headers: Headers) {
    const contentType = headers.get("content-type") ?? "";
    if (!contentType.startsWith("application/json"))
        return isStreamRequested(headers);
    try {
        const parsed = await req.clone().json();
        return isStreamRequested(headers, parsed);
    } catch {
        return isStreamRequested(headers);
    }
}

interface ParsedPath {
    service: string;
    userPath: string;
    search: string;
    url: URL;
    rawPath: string;
}

function parseRequestPath(
    request: Request,
    headers: Headers,
): ParsedPath | null {
    let url: URL;
    try {
        if (
            request.url.startsWith("http://") ||
            request.url.startsWith("https://")
        ) {
            url = new URL(request.url);
        } else {
            const host = headers.get("host") || "localhost";
            const proto = headers.get("x-forwarded-proto") || "https";
            url = new URL(request.url, `${proto}://${host}`);
        }
    } catch (err) {
        logError("URL 解析失败", { error: String(err), rawUrl: request.url });
        return null;
    }

    const pathParam = url.searchParams.get("path");
    let fullPath: string;

    if (pathParam) {
        const decoded = decodeURIComponent(pathParam);
        fullPath = decoded.startsWith("/")
            ? `/gateway${decoded}`
            : `/gateway/${decoded}`;
        url.searchParams.delete("path");
    } else {
        fullPath = url.pathname.replace(/^\/api\//, "/");
    }

    const searchString = url.searchParams.toString();
    const finalSearch = searchString ? `?${searchString}` : "";
    const segments = fullPath.replace(/^\/+|\/+$/g, "").split("/");

    if (segments[0] !== "gateway" || segments.length < 3) {
        return null;
    }

    const service = segments[1];
    const userPath = sanitizePath(segments.slice(2));

    return {
        service,
        userPath,
        search: finalSearch,
        url,
        rawPath: fullPath,
    };
}

async function handoffToBackground(
    req: Request,
    ctx: {
        service: string;
        userPath: string;
        reqId: string;
        search: string;
        url: URL;
        headers: Headers;
    },
) {
    const { service, userPath, reqId, search, url, headers } = ctx;
    const query = search.startsWith("?") ? search.slice(1) : search;
    const bodyBuffer =
        req.method === "GET" || req.method === "HEAD"
            ? undefined
            : await req.arrayBuffer();

    const forwardHeaders = cloneAllowedHeaders(headers);
    forwardHeaders.set("x-gateway-target-service", service);
    forwardHeaders.set("x-gateway-target-path", userPath);
    forwardHeaders.set("x-request-id", reqId);
    if (query) forwardHeaders.set("x-gateway-target-query", query);
    forwardHeaders.set("x-gateway-dispatcher", "edge");

    const backgroundUrl = new URL(BACKGROUND_ENDPOINT, url.origin);
    const response = await fetch(backgroundUrl.toString(), {
        method: req.method,
        headers: forwardHeaders,
        body: bodyBuffer ? new Uint8Array(bodyBuffer) : undefined,
    });

    const processedHeaders = processResponseHeaders(response.headers, reqId);
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: processedHeaders,
    });
}

function enforceStreamLimit(
    stream: ReadableStream<Uint8Array>,
    limit: number,
    reqId: string,
) {
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
    ctx: {
        service: string;
        userPath: string;
        reqId: string;
        search: string;
        headers: Headers;
    },
) {
    const { service, userPath, reqId, search, headers } = ctx;
    const proxy = PROXIES[service];
    if (!proxy) return createErrorResponse(404, `未找到服务 ${service}`, reqId);

    const upstreamURL = buildUpstreamURL(
        proxy.host,
        proxy.basePath,
        userPath,
        search,
    );
    const forwardHeaders = buildForwardHeaders(headers, proxy);
    forwardHeaders.set("X-Request-Id", reqId);

    const effectiveTimeout = resolveEffectiveTimeout(service);
    logDebug("准备发起流式请求", {
        reqId,
        upstreamURL,
        timeout: effectiveTimeout,
    });

    try {
        const response = await fetchWithRetry(
            upstreamURL,
            {
                method: req.method,
                headers: forwardHeaders,
                body:
                    req.method === "GET" || req.method === "HEAD"
                        ? undefined
                        : req.body,
            },
            {
                retries: proxy.retryable ? 2 : 0,
                retryableMethods: proxy.retryableMethods ?? [
                    "GET",
                    "HEAD",
                    "OPTIONS",
                    "POST",
                ],
                retryStatusCodes: RETRY_HTTP_CODES,
                timeoutPerAttempt: effectiveTimeout,
                baseDelay: 200,
                maxDelay: 2000,
                jitter: 0.25,
                reqId,
                label: service,
            },
        );

        const limit = proxy.maxResponseSize ?? EDGE_MAX_RESPONSE_SIZE;
        const contentLength = response.headers.get("content-length");
        if (contentLength && Number(contentLength) > limit) {
            logWarn("响应 Content-Length 超限", {
                reqId,
                limit,
                contentLength,
            });
            return createErrorResponse(
                413,
                "响应体超过 Edge 允许的大小限制",
                reqId,
                {
                    limit,
                    content_length: Number(contentLength),
                },
            );
        }

        const processedHeaders = processResponseHeaders(
            response.headers,
            reqId,
        );
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
            return createErrorResponse(
                413,
                "响应体超过 Edge 允许的大小限制",
                reqId,
                {
                    limit: err.maxBytes,
                    actual: err.actualBytes,
                },
            );
        }
        const { status, message } = categorizeError(err as Error);
        logError("流式请求失败", { reqId, message, status, service });
        return createErrorResponse(status, message, reqId, { service });
    }
}

export default async function handler(req: Request) {
    if (req.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: createCorsHeaders(),
        });
    }

    const incomingHeaders = new Headers(req.headers);
    const reqId = getRequestId(incomingHeaders);

    const parsed = parseRequestPath(req, incomingHeaders);
    if (!parsed) {
        return createErrorResponse(400, "无效的请求路径", reqId);
    }

    const { service, userPath, search, url, rawPath } = parsed;
    const proxy = PROXIES[service];
    if (!proxy) {
        return createErrorResponse(404, `服务 ${service} 未配置`, reqId);
    }

    logInfo("Edge 收到请求", {
        reqId,
        method: req.method,
        service,
        path: rawPath,
        streamCheck: "pending",
    });

    const streamIntent = await detectStreamIntent(req, incomingHeaders);
    logDebug("流式判定结果", { reqId, stream: streamIntent });

    if (!streamIntent) {
        return handoffToBackground(req, {
            service,
            userPath,
            reqId,
            search,
            url,
            headers: incomingHeaders,
        });
    }

    return handleStreamRequest(req, {
        service,
        userPath,
        reqId,
        search,
        headers: incomingHeaders,
    });
}
