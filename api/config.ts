/**
 * API 代理服务配置模块
 * 提供 BUILTIN_PROXIES + loadProxyConfig
 */

export function getEnv(key: string, def?: string) {
  return (globalThis as any).process?.env[key] ?? process.env[key] ?? def;
}

/**
 * 内置代理服务配置
 */
export const BUILTIN_PROXIES: Record<string, any> = {
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
 * 合并环境变量配置
 */
export function loadProxyConfig() {
  const raw = getEnv("PROXY_CONFIG");
  if (!raw) return BUILTIN_PROXIES;
  try {
    const parsed = JSON.parse(raw);
    const merged = { ...BUILTIN_PROXIES };
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val === "object" && val !== null) {
        merged[key] = { ...BUILTIN_PROXIES[key], ...val };
      }
    }
    return merged;
  } catch (e) {
    console.error("⚠️ 无效的 PROXY_CONFIG JSON，使用内置配置", e);
    return BUILTIN_PROXIES;
  }
}

export const PROXIES = loadProxyConfig();

// 全局环境配置
export const ALLOWED_ORIGIN = getEnv("ALLOWED_ORIGIN", "*");
export const DEFAULT_TIMEOUT = parseInt(getEnv("DEFAULT_TIMEOUT", "60000")!, 10);
export const ENABLE_RETRY = getEnv("ENABLE_RETRY", "true") !== "false";
export const MAX_RESPONSE_SIZE = parseInt(getEnv("MAX_RESPONSE_SIZE", "6291456")!, 10); // 默认 6MB
export const DEFAULT_RETRY_METHODS = ["GET", "HEAD", "OPTIONS", "POST"];
