import type { VercelRequest, VercelResponse } from "@vercel/node";
import fetch from "node-fetch";
import { PROXIES } from "./config";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const reqId =
    (req.headers["x-request-id"] as string) ||
    (globalThis.crypto?.randomUUID?.() ?? Date.now().toString());

  const url = req.url || "";
  const segments = url.replace(/^\/api\/background/, "").split("/").filter(Boolean);

  if (segments.length < 2) {
    return res.status(400).json({
      error: "无效路径，格式: /api/background/{service}/{path}",
      request_id: reqId,
    });
  }

  const [serviceAlias, ...pathParts] = segments;
  const proxy = PROXIES[serviceAlias];
  if (!proxy) {
    return res.status(404).json({
      error: `服务 '${serviceAlias}' 未找到`,
      request_id: reqId,
      available: Object.keys(PROXIES),
    });
  }

  // 构造上游 URL
  const cleanBase = proxy.basePath ? `/${proxy.basePath.replace(/^\/|\/$/g, "")}` : "";
  const upstreamUrl =
    `https://${proxy.host}${cleanBase}/${pathParts.join("/")}` +
    (url.includes("?") ? url.substring(url.indexOf("?")) : "");

  console.log(
    `[Background] 路由请求: service=${serviceAlias} upstream=${upstreamUrl} reqId=${reqId}`
  );

  try {
    const upstreamResp = await fetch(upstreamUrl, {
      method: req.method,
      headers: filterHeaders(req.headers as any, proxy),
      body: ["GET", "HEAD"].includes(req.method!) ? undefined : tryStringify(req.body),
    });

    res.setHeader("X-Request-Id", String(reqId));

    // JSON 响应
    const ct = upstreamResp.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const data = await upstreamResp.json();
      return res.status(upstreamResp.status).json(data);
    }

    // 非 JSON 响应 → 透传 buffer + headers
    const buf = Buffer.from(await upstreamResp.arrayBuffer());
    for (const [k, v] of upstreamResp.headers.entries()) {
      res.setHeader(k, v);
    }
    return res.status(upstreamResp.status).end(buf);
  } catch (err: any) {
    console.error("[Background] 上游请求失败:", err);
    return res.status(502).json({
      error: { message: err.message || "网络错误" },
      type: "NETWORK",
      request_id: reqId,
    });
  }
}

// =================== 工具函数 ===================

function filterHeaders(headers: Record<string, any>, proxy: any) {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!v) continue;
    const lower = k.toLowerCase();
    if (
      ["authorization", "content-type", "accept"].includes(lower) ||
      lower.startsWith("x-")
    ) {
      h[k] = Array.isArray(v) ? v[0] : String(v);
    }
  }

  // ⚠️ 不主动设置 user-agent，保持客户端/Node fetch 默认值
  if (proxy.defaultHeaders) Object.assign(h, proxy.defaultHeaders);
  return h;
}

function tryStringify(body: any): string | undefined {
  if (!body) return undefined;
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    return undefined;
  }
}
