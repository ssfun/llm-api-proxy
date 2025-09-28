/**
 * /lib/config.ts
 *
 * @format
 */

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface ProxyConfig {
    host: string;
    basePath?: string;
    defaultHeaders?: Record<string, string>;
    retryable?: boolean;
    retryableMethods?: string[];
    timeout?: number;
    maxResponseSize?: number;
}

export interface FetchRetryOptions {
    retries: number;
    retryableMethods: string[];
    retryStatusCodes: number[];
    timeoutPerAttempt: number;
    baseDelay: number;
    maxDelay: number;
    jitter: number;
    reqId: string;
    label?: string;
}

const RESET = "\x1b[0m";
const COLOR: Record<LogLevel, string> = {
    DEBUG: "\x1b[36m",
    INFO: "\x1b[32m",
    WARN: "\x1b[33m",
    ERROR: "\x1b[31m",
};

const shanghaiFormatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
});

export function toShanghaiTime() {
    return shanghaiFormatter.format(new Date()).replace(/\//g, "-");
}

export function log(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
) {
    const time = toShanghaiTime();
    const colour = COLOR[level] ?? "";
    let line = `[${time}]${colour}[${level}]${RESET} ${message}`;
    if (context) {
        const detail = Object.entries(context)
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) =>
                typeof v === "object"
                    ? `${k}=${JSON.stringify(v)}`
                    : `${k}=${v}`,
            )
            .join(" ");
        if (detail) line += ` | ${detail}`;
    }
    console.log(line);
}

export const logDebug = (msg: string, ctx?: Record<string, unknown>) =>
    log("DEBUG", msg, ctx);
export const logInfo = (msg: string, ctx?: Record<string, unknown>) =>
    log("INFO", msg, ctx);
export const logWarn = (msg: string, ctx?: Record<string, unknown>) =>
    log("WARN", msg, ctx);
export const logError = (msg: string, ctx?: Record<string, unknown>) =>
    log("ERROR", msg, ctx);

function getEnv(key: string, fallback?: string) {
    return (globalThis as any).process?.env?.[key] ?? fallback;
}

const BUILTIN_PROXIES: Record<string, ProxyConfig> = {
  openai: { 
    host: "api.openai.com", 
    retryable: true, 
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"], 
    timeout: 120000, 
    maxResponseSize: 10 * 1024 * 1024 
  },
  claude: { 
    host: "api.anthropic.com", 
    retryable: true, 
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"], 
    defaultHeaders: { "anthropic-version": "2023-06-01" } 
  },
  groq: { 
    host: "api.groq.com", 
    basePath: "openai", 
    retryable: true, 
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"] 
  },
  gemini: { 
    host: "generativelanguage.googleapis.com", 
    retryable: true, 
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"] 
  },
  cohere: { 
    host: "api.cohere.ai", 
    retryable: true, 
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"] 
  },
  huggingface: { 
    host: "api-inference.huggingface.co", 
    retryable: true, 
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"] 
  },
  together: { 
    host: "api.together.xyz", 
    retryable: true, 
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"] 
  },
  fireworks: { 
    host: "api.fireworks.ai", 
    basePath: "inference", 
    retryable: true, 
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"] 
  },
  siliconflow: { 
    host: "api.siliconflow.cn", 
    retryable: true, 
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"] 
  },
  pplx: { 
    host: "api.perplexity.ai", 
    retryable: true, 
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"] 
  },
  openrouter: { 
    host: "openrouter.ai", 
    basePath: "api", 
    retryable: true, 
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"] 
  },
  meta: { 
    host: "www.meta.ai", 
    basePath: "api", 
    retryable: true, 
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"] 
  },
  friendli: { 
    host: "api.friendli.ai", 
    basePath: "serverless", 
    retryable: true, 
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"] 
  },
  github: { 
    host: "models.github.ai", 
    retryable: true, 
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"], 
    defaultHeaders: { Accept: "application/vnd.github+json" } 
  },
  azure: { 
    host: "models.inference.ai.azure.com", 
    retryable: true, 
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST", "PUT"] 
  },
  dmxcn: { 
    host: "www.dmxapi.cn" 
  },
  dmxcom: { 
    host: "www.dmxapi.com" 
  },
  novita: { 
    host: "api.novita.ai", 
    retryable: true, 
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"] 
  },
  portkey: { 
    host: "api.portkey.ai", 
    retryable: true, 
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"] 
  },
  xai: { 
    host: "api.x.ai", 
    retryable: true, 
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"] 
  },
  telegram: { 
    host: "api.telegram.org", 
    retryable: true, 
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"] 
  },
  discord: { 
    host: "discord.com", 
    basePath: "api" 
  },
  chataw: { 
    host: "api.chatanywhere.tech", 
    retryable: true, 
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"] 
  },
  httpbin: { 
    host: "httpbin.org", 
    retryable: true, 
    retryableMethods: ["GET", "HEAD", "OPTIONS", "POST"] 
  },
};

export const ALLOWED_ORIGIN = getEnv("ALLOWED_ORIGIN", "*");
export const DEFAULT_TIMEOUT = parseInt(
    getEnv("DEFAULT_TIMEOUT", "60000")!,
    10,
);
export const MAX_RESPONSE_SIZE = parseInt(
    getEnv("MAX_RESPONSE_SIZE", "6291456")!,
    10,
);
export const ENABLE_RETRY = getEnv("ENABLE_RETRY", "true") !== "false";
const PROXY_CONFIG_OVERRIDES = getEnv("PROXY_CONFIG");

function loadProxyConfig() {
    if (!PROXY_CONFIG_OVERRIDES) return { ...BUILTIN_PROXIES };
    try {
        const overrides = JSON.parse(PROXY_CONFIG_OVERRIDES);
        const merged: Record<string, ProxyConfig> = { ...BUILTIN_PROXIES };
        Object.entries(overrides).forEach(([key, value]) => {
            if (typeof value === "object" && value)
                merged[key] = { ...merged[key], ...(value as ProxyConfig) };
        });
        return merged;
    } catch (err) {
        logWarn("解析 PROXY_CONFIG 失败，使用内置配置", { error: `${err}` });
        return { ...BUILTIN_PROXIES };
    }
}

export const PROXIES = loadProxyConfig();

const ALLOWED_HEADERS = new Set([
    "accept",
    "accept-language",
    "content-type",
    "content-length",
    "authorization",
    "x-api-key",
    "x-goog-api-key",
    "user-agent",
    "anthropic-version",
    "openai-organization",
    "openai-beta",
    "accept-charset",
    "if-none-match",
    "if-modified-since",
]);
const BLACKLISTED_HEADERS = new Set([
    "host",
    "connection",
    "cookie",
    "cf-connecting-ip",
    "cf-ipcountry",
    "x-forwarded-for",
    "x-real-ip",
    "via",
    "x-vercel-proxy-signature",
]);
const CUSTOM_HEADER_PATTERN = /^x-[\w-]+$/i;

export function isStreamRequested(request: Request, parsedBody?: any) {
    const accept = request.headers.get("accept") ?? "";
    if (
        accept.includes("text/event-stream") ||
        accept.includes("application/x-ndjson")
    )
        return true;
    if (request.headers.get("x-enable-stream") === "1") return true;
    if (!parsedBody || typeof parsedBody !== "object") return false;
    if (parsedBody.stream === true) return true;
    if (parsedBody.stream?.enable === true) return true;
    if (parsedBody.response_format?.stream === true) return true;
    return false;
}

export function sanitizePath(frags: string[]) {
    return frags
        .filter(Boolean)
        .filter((seg) => seg !== "." && seg !== "..")
        .map((seg) =>
            seg
                .split("/")
                .map((s) => encodeURIComponent(s).replace(/%3A/gi, ":"))
                .join("/"),
        )
        .join("/");
}

export function buildUpstreamURL(
    host: string,
    basePath: string | undefined,
    userPath: string,
    search: string,
) {
    const cleanBase = basePath ? basePath.replace(/^\/+|\/+$/g, "") : "";
    const cleanUser = userPath.replace(/^\/+|\/+$/g, "");
    const merged = [cleanBase, cleanUser].filter(Boolean).join("/");
    return `https://${host}${merged ? `/${merged}` : ""}${search}`;
}

export function createCorsHeaders(origin = ALLOWED_ORIGIN) {
    const headers = new Headers();
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD",
    );
    headers.set(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-Requested-With, anthropic-version, X-Api-Key, X-Client-Id, X-Gateway-Target-Service, X-Gateway-Target-Path, X-Gateway-Target-Query, X-Enable-Stream, X-Requested-By",
    );
    headers.set(
        "Access-Control-Expose-Headers",
        "Content-Type, Content-Length, X-Request-Id, X-Upstream-Status, X-Upstream-Trace",
    );
    headers.set("Access-Control-Max-Age", "86400");
    return headers;
}

export function getRequestId(headers: Headers) {
    return (
        headers.get("x-request-id") ??
        headers.get("sb-request-id") ??
        crypto.randomUUID()
    );
}

export class SizeLimitExceededError extends Error {
    override name = "SizeLimitExceededError";
    constructor(
        public readonly maxBytes: number,
        public readonly actualBytes: number,
    ) {
        super(`Response size ${actualBytes} exceeds limit ${maxBytes}`);
    }
}

export function createErrorResponse(
    status: number,
    message: string,
    reqId: string,
    detail?: Record<string, unknown>,
) {
    const headers = createCorsHeaders();
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("X-Request-Id", reqId);
    const body = {
        error: { message, type: "gateway_error", request_id: reqId },
        status,
        ...(detail ?? {}),
    };
    return new Response(JSON.stringify(body), { status, headers });
}

export function processResponseHeaders(
    upstreamHeaders: Headers,
    reqId: string,
) {
    const headers = new Headers(upstreamHeaders);
    const cors = createCorsHeaders();
    cors.forEach((value, key) => headers.set(key, value));
    headers.set("X-Request-Id", reqId);
    headers.delete("content-encoding");
    headers.delete("transfer-encoding");
    headers.delete("server");
    headers.delete("x-powered-by");
    return headers;
}

export function buildForwardHeaders(
    clientHeaders: Headers,
    proxy?: ProxyConfig,
) {
    const headers = new Headers();
    if (proxy?.defaultHeaders) {
        Object.entries(proxy.defaultHeaders).forEach(([key, value]) =>
            headers.set(key, value),
        );
    }
    for (const [key, value] of clientHeaders.entries()) {
        const lower = key.toLowerCase();
        if (BLACKLISTED_HEADERS.has(lower)) continue;
        if (ALLOWED_HEADERS.has(lower) || CUSTOM_HEADER_PATTERN.test(lower))
            headers.set(key, value);
    }
    if (!headers.has("User-Agent"))
        headers.set("User-Agent", "CAN-Gateway/1.0 (Edge)");
    headers.delete("accept-encoding");
    return headers;
}

export function categorizeError(error: Error) {
    const msg = (error.message ?? "").toLowerCase();
    if (error.name === "AbortError" || msg.includes("timeout"))
        return { type: "TIMEOUT", status: 504, message: "请求超时或被终止" };
    if (
        msg.includes("fetch failed") ||
        msg.includes("network") ||
        msg.includes("socket hang up")
    )
        return {
            type: "NETWORK",
            status: 502,
            message: "网络异常：无法连接上游服务",
        };
    if (msg.includes("dns") || msg.includes("getaddrinfo"))
        return {
            type: "DNS",
            status: 502,
            message: "DNS 解析失败，无法定位上游主机",
        };
    if (
        msg.includes("certificate") ||
        msg.includes("tls") ||
        msg.includes("ssl")
    )
        return {
            type: "SSL",
            status: 502,
            message: "TLS/SSL 握手失败，请检验证书",
        };
    if (msg.includes("econnrefused") || msg.includes("connection refused"))
        return { type: "CONNECTION", status: 503, message: "上游连接被拒绝" };
    return {
        type: "UNKNOWN",
        status: 500,
        message: `未知错误：${error.message}`,
    };
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(
    base: number,
    factor: number,
    attempt: number,
    max: number,
    jitter: number,
) {
    const exp = base * Math.pow(factor, attempt - 1);
    const capped = Math.min(exp, max);
    if (jitter <= 0) return capped;
    const spread = capped * jitter;
    const min = capped - spread;
    const maxDelay = capped + spread;
    return Math.random() * (maxDelay - min) + min;
}

function mergeAbortSignals(
    incoming: AbortSignal | null | undefined,
    timeoutMs: number,
) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs > 0) {
        timer = setTimeout(
            () => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)),
            timeoutMs,
        );
    }

    if (incoming) {
        if (incoming.aborted) {
            controller.abort(incoming.reason);
        } else {
            const listener = () => controller.abort(incoming.reason);
            incoming.addEventListener("abort", listener, { once: true });
            controller.signal.addEventListener(
                "abort",
                () => incoming.removeEventListener("abort", listener),
                { once: true },
            );
        }
    }

    return {
        signal: controller.signal,
        dispose() {
            if (timer) clearTimeout(timer as number);
        },
    };
}

export async function fetchWithRetry(
    url: string,
    init: RequestInit = {},
    options: FetchRetryOptions,
) {
    const method = (init.method ?? "GET").toUpperCase();
    const retryable = options.retryableMethods.includes(method);
    const attempts = ENABLE_RETRY && retryable ? options.retries + 1 : 1;
    let attempt = 0;
    let lastError: unknown;

    while (attempt < attempts) {
        attempt += 1;
        const composed = mergeAbortSignals(
            init.signal as AbortSignal | undefined,
            options.timeoutPerAttempt,
        );
        try {
            const response = await fetch(url, {
                ...init,
                signal: composed.signal,
            } as RequestInit);
            composed.dispose();

            if (!retryable) return response;
            if (!options.retryStatusCodes.includes(response.status))
                return response;

            lastError = new Error(
                `Retryable status ${response.status} for ${url}`,
            );
            logWarn("检测到需要重试的状态码", {
                reqId: options.reqId,
                attempt,
                status: response.status,
                label: options.label ?? "upstream",
            });

            if (attempt >= attempts) return response;
            const delay = backoffDelay(
                options.baseDelay,
                2,
                attempt,
                options.maxDelay,
                options.jitter,
            );
            await sleep(delay);
            continue;
        } catch (err) {
            composed.dispose();
            lastError = err;
            const { type, status, message } = categorizeError(err as Error);
            logWarn("请求失败，准备重试", {
                reqId: options.reqId,
                attempt,
                type,
                status,
                label: options.label ?? "upstream",
                error: message,
            });

            if (!retryable || attempt >= attempts) throw err;
            const delay = backoffDelay(
                options.baseDelay,
                2,
                attempt,
                options.maxDelay,
                options.jitter,
            );
            await sleep(delay);
        }
    }
    throw lastError ?? new Error("未知错误");
}

logInfo("🚀 网关配置初始化完成", {
    proxies: Object.keys(PROXIES).length,
    defaultTimeout: DEFAULT_TIMEOUT,
    maxResponseSize: MAX_RESPONSE_SIZE,
});
