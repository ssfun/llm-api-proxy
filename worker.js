/**
 * LLM API Proxy
 * @version 1.0.0
 * @license MIT
 *
 * 环境变量配置：
 * - AUTH_TOKEN: 认证令牌 (通用代理模式必需, 预设端点模式可选)
 * - DEBUG_MODE: 调试模式 (默认: false)
 * - PRESET_AUTH_ENABLED: 是否对预设端点强制认证 (默认: false)
 * - GEMINI_SPECIAL_HANDLING_ENABLED: 是否启用 Gemini 特殊处理逻辑 (默认: true)
 * - DEFAULT_DST_URL: "https://httpbin.org/get" (用于 /test 路由)
 * - FORCE_FETCH_DEFAULT: 强制使用 Fetch 连接（默认：false）
 * - AGGRESSIVE_FALLBACK: 激进回退模式 (默认: true)
 * - GEMINI_RETRY_PROMPT_CN: 中文续写提示
 * - GEMINI_RETRY_PROMPT_EN: 英文续写提示
 */

import { connect } from 'cloudflare:sockets';

/**
 * 净化工具函数，用于保护日志中的隐私信息
 */
function sanitizeHeaders(headers) {
  const sensitiveKeys = ['authorization', 'x-api-key', 'x-goog-api-key', 'cookie'];
  const sanitized = new Headers(headers);
  for (const key of sensitiveKeys) {
    if (sanitized.has(key)) {
      sanitized.set(key, '***REDACTED***');
    }
  }
  return sanitized;
}

function sanitizeBody(body) {
  try {
    let bodyObject = body;
    if (typeof bodyObject !== 'object' || bodyObject === null) {
      bodyObject = JSON.parse(bodyObject);
    }

    const sanitized = JSON.parse(JSON.stringify(bodyObject));

    // 净化常见的内容字段
    if (Array.isArray(sanitized.contents)) {
      sanitized.contents = `[${sanitized.contents.length} messages, content redacted]`;
    }
    if (Array.isArray(sanitized.messages)) {
      sanitized.messages = `[${sanitized.messages.length} messages, content redacted]`;
    }
    if (sanitized.prompt) {
      sanitized.prompt = "[Prompt content redacted]";
    }
    if (sanitized.systemInstruction) {
      sanitized.systemInstruction = "[System instruction redacted]";
    }

    return sanitized;
  } catch (e) {
    return "[Non-JSON or unparsable body, content redacted]";
  }
}

function sanitizeUrl(urlString) {
  try {
    const url = new URL(urlString);
    const sensitiveParams = ['key', 'api_key', 'token', 'auth_token'];
    sensitiveParams.forEach(param => {
      if (url.searchParams.has(param)) {
        url.searchParams.set(param, '***REDACTED***');
      }
    });
    return url.toString();
  } catch (e) {
    return "[Invalid URL, unable to sanitize]";
  }
}

// API 路由映射表
const API_MAPPING = {
  '/discord': {
    name: 'Discord',
    icon: '💬',
    description: 'Discord Bot & OAuth API',
    displayUrl: 'discord.com/api',
    targets: ['https://discord.com/api'],
    forceFetch: true
  },
  '/telegram': {
    name: 'Telegram',
    icon: '✈️',
    description: 'Telegram Bot API',
    displayUrl: 'api.telegram.org',
    targets: ['https://api.telegram.org'],
    forceFetch: false
  },
  '/openai': {
    name: 'OpenAI',
    icon: '🤖',
    description: 'GPT, DALL-E, Whisper API',
    displayUrl: 'api.openai.com',
    targets: ['https://api.openai.com'],
    forceFetch: true
  },
  '/claude': {
    name: 'Anthropic',
    icon: '🧠',
    description: 'Anthropic Claude API',
    displayUrl: 'api.anthropic.com',
    targets: ['https://api.anthropic.com'],
    forceFetch: true
  },
  '/gemini': {
    name: 'Google Gemini',
    icon: '✨',
    description: 'Google Gemini API',
    displayUrl: 'generativelanguage.googleapis.com',
    targets: ['https://generativelanguage.googleapis.com'],
    forceFetch: false
  },
  '/cerebras': {
    name: 'Cerebras',
    icon: '🧬',
    description: 'Cerebras Cloud API',
    displayUrl: 'api.cerebras.ai',
    targets: ['https://api.cerebras.ai'],
    forceFetch: true
  },
  '/chutes': {
    name: 'Chutes',
    icon: '〽️',
    description: 'Chutes Cloud API',
    displayUrl: 'llm.chutes.ai',
    targets: ['https://llm.chutes.ai'],
    forceFetch: false
  },
  '/cohere': {
    name: 'Cohere',
    icon: '🔮',
    description: 'Cohere NLP API',
    displayUrl: 'api.cohere.ai',
    targets: ['https://api.cohere.ai'],
    forceFetch: false
  },
  '/deepinfra': {
    name: 'Deepinfra',
    icon: '🌴',
    description: 'Deepinfra Systems API',
    displayUrl: 'api.deepinfra.ai',
    targets: ['https://deepinfra.ssfun.nyc.mn'],
    forceFetch: true
  },
  '/fireworks': {
    name: 'Fireworks',
    icon: '🎆',
    description: 'Fireworks AI API',
    displayUrl: 'api.fireworks.ai/inference',
    targets: ['https://api.fireworks.ai/inference'],
    forceFetch: true
  },
  '/friendli': {
    name: 'Friendli',
    icon: '🥗',
    description: 'Friendli AI API',
    displayUrl: 'api.friendli.ai/serverless',
    targets: ['https://api.friendli.ai/serverless'],
    forceFetch: true
  },
  '/github': {
    name: 'GitHub',
    icon: '🐙',
    description: 'GitHub Models API',
    displayUrl: 'models.github.ai',
    targets: ['https://models.github.ai'],
    forceFetch: false
  },
  '/groq': {
    name: 'Groq',
    icon: '⚡',
    description: 'Groq Cloud API',
    displayUrl: 'api.groq.com/openai',
    targets: ['https://api.groq.com/openai'],
    forceFetch: true
  },
  '/huggingface': {
    name: 'HuggingFace',
    icon: '🤗',
    description: 'HuggingFace Inference API',
    displayUrl: 'api-inference.huggingface.co',
    targets: ['https://api-inference.huggingface.co'],
    forceFetch: false
  },
  '/meta': {
    name: 'Meta AI',
    icon: '🌐',
    description: 'Meta AI Platform',
    displayUrl: 'www.meta.ai/api',
    targets: ['https://www.meta.ai/api'],
    forceFetch: false
  },
  '/novita': {
    name: 'Novita',
    icon: '🆕',
    description: 'Novita AI API',
    displayUrl: 'api.novita.ai',
    targets: ['https://api.novita.ai'],
    forceFetch: false
  },
  '/openrouter': {
    name: 'OpenRouter',
    icon: '🛣️',
    description: 'OpenRouter API Gateway',
    displayUrl: 'openrouter.ai/api',
    targets: ['https://openrouter.ai/api'],
    forceFetch: true
  },
  '/poe': {
    name: 'Poe',
    icon: '☁️',
    description: 'Poe - Fast, Helpful AI Chat',
    displayUrl: 'api.poe.com',
    targets: ['https://api.poe.com'],
    forceFetch: false
  },
  '/portkey': {
    name: 'Portkey',
    icon: '🔑',
    description: 'Portkey Gateway API',
    displayUrl: 'api.portkey.ai',
    targets: ['https://api.portkey.ai'],
    forceFetch: true
  },
  '/sambanova': {
    name: 'SambaNova',
    icon: '🚀',
    description: 'SambaNova Systems API',
    displayUrl: 'api.sambanova.ai',
    targets: ['https://api.sambanova.ai'],
    forceFetch: false
  },
  '/targon': {
    name: 'Targon',
    icon: '🌊',
    description: 'Targon Systems API',
    displayUrl: 'api.targon.ai',
    targets: ['https://api.targon.ai'],
    forceFetch: false,
    forceStream: true
  },
  '/together': {
    name: 'Together',
    icon: '🤝',
    description: 'Together AI API',
    displayUrl: 'api.together.xyz',
    targets: ['https://api.together.xyz'],
    forceFetch: true
  },
  '/xai': {
    name: 'X.AI',
    icon: '🎯',
    description: 'X.AI Grok API',
    displayUrl: 'api.x.ai',
    targets: ['https://api.x.ai'],
    forceFetch: true
  }
};

// Gemini 特殊处理配置
const GEMINI_CONFIG = {
  upstream_url_base: "https://generativelanguage.googleapis.com",
  max_consecutive_retries: 5,
  max_network_retries: 3,
  debug_mode: false,
  retry_delay_ms: 750,
  log_truncation_limit: 8000,
  retry_prompts: {
    'en': "Continue exactly where you left off, providing the final answer without repeating the previous thinking steps.",
    'zh': "请从刚才中断的地方继续，直接提供最终答案，不要重复之前的思考步骤。",
    'ja': "中断したところから続けて、以前の思考ステップを繰り返せずに最終的な答えを提供してください。",
    'ko': "중단된 부분부터 계속하여 이전 사고 단계를 반복하지 말고 최종 답변을 제공하세요。",
    'es': "Continúa exactamente donde lo dejaste, proporcionando la respuesta final sin repetir los pasos de pensamiento anteriores.",
    'fr': "Continuez exactement où vous vous êtes arrêté, en fournissant la réponse finale sans répéter les étapes de réflexion précédentes.",
    'de': "Fahren Sie genau dort fort, wo Sie aufgehört haben, und geben Sie die endgültige Antwort, ohne die vorherigen Denkschritte zu wiederholen.",
    'default': "Continue from where you stopped. Provide the final answer directly."
  }
};

const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404, 429]);

class ErrorResponse {
  static create(status, message, details = null, headers = {}) {
    const errorBody = {
      error: {
        code: status,
        message: message,
        timestamp: new Date().toISOString()
      }
    };
    
    if (details) {
      errorBody.error.details = details;
    }
    
    const defaultHeaders = {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Proxy-Error': 'true',
      'Access-Control-Allow-Origin': '*'
    };
    
    return new Response(JSON.stringify(errorBody), {
      status: status,
      headers: { ...defaultHeaders, ...headers }
    });
  }
  
  static unauthorized(message = 'Unauthorized') {
    return this.create(401, message);
  }
  
  static badRequest(message = 'Bad Request', details = null) {
    return this.create(400, message, details);
  }

  static notFound(message = 'Not Found') {
    return this.create(404, message);
  }
  
  static serverError(message = 'Internal Server Error', details = null) {
    return this.create(500, message, details);
  }
  
  static badGateway(message = 'Bad Gateway', details = null) {
    return this.create(502, message, details);
  }
  
  static serviceUnavailable(message = 'Service Unavailable', details = null) {
    return this.create(503, message, details);
  }
}

class ConfigManager {
  static DEFAULT_CONFIG = {
    AUTH_TOKEN: "your-auth-token",
    DEFAULT_DST_URL: "https://httpbin.org/get",
    DEBUG_MODE: false,
    FORCE_FETCH_DEFAULT: false,
    AGGRESSIVE_FALLBACK: true,
    // 控制预设端点是否需要认证
    PRESET_AUTH_ENABLED: false,
    // 控制是否启用 Gemini 特殊处理
    GEMINI_SPECIAL_HANDLING_ENABLED: true,
    GEMINI_RETRY_PROMPT_CN: null,
    GEMINI_RETRY_PROMPT_EN: null,
  };

  static updateConfigFromEnv(env) {
    if (!env) return { ...this.DEFAULT_CONFIG };
    
    const config = { ...this.DEFAULT_CONFIG };
    
    for (const key of Object.keys(config)) {
      if (key in env) {
        if (typeof config[key] === 'boolean') {
          config[key] = env[key] === 'true';
        } else {
          config[key] = env[key];
        }
      }
    }
        
    if (config.GEMINI_RETRY_PROMPT_CN) {
      GEMINI_CONFIG.retry_prompts.zh = config.GEMINI_RETRY_PROMPT_CN;
    }
    if (config.GEMINI_RETRY_PROMPT_EN) {
      GEMINI_CONFIG.retry_prompts.en = config.GEMINI_RETRY_PROMPT_EN;
    }
    
    return config;
  }
}

class RouteSelector {
  static selectTarget(targets) {
    if (!targets || targets.length === 0) {
      return null;
    }
    if (targets.length === 1) {
      return targets[0];
    }
    const index = Math.floor(Math.random() * targets.length);
    return targets[index];
  }
}

class GeminiHandler {
  constructor(config, proxy) {
    this.config = { ...GEMINI_CONFIG, debug_mode: config.DEBUG_MODE };
    this.proxy = proxy; 
    this.networkRetryCount = 0;
  }

  logDebug(...args) { 
    if (this.config.debug_mode) console.log(`[GEMINI DEBUG ${new Date().toISOString()}]`, ...args); 
  }
  
  logInfo(...args) { 
    console.log(`[GEMINI INFO ${new Date().toISOString()}]`, ...args); 
  }
  
  logError(...args) { 
    console.error(`[GEMINI ERROR ${new Date().toISOString()}]`, ...args); 
  }

  truncate(s, n = this.config.log_truncation_limit) {
    if (typeof s !== "string") return s;
    return s.length > n ? `${s.slice(0, n)}... [truncated ${s.length - n} chars]` : s;
  }

  statusToGoogleStatus(code) {
    if (code === 400) return "INVALID_ARGUMENT";
    if (code === 401) return "UNAUTHENTICATED";
    if (code === 403) return "PERMISSION_DENIED";
    if (code === 404) return "NOT_FOUND";
    if (code === 429) return "RESOURCE_EXHAUSTED";
    if (code === 500) return "INTERNAL";
    if (code === 503) return "UNAVAILABLE";
    if (code === 504) return "DEADLINE_EXCEEDED";
    return "UNKNOWN";
  }

  buildUpstreamHeaders(reqHeaders) {
    const h = new Headers();
    const copy = (k) => { const v = reqHeaders.get(k); if (v) h.set(k, v); };
    copy("authorization");
    copy("x-goog-api-key");
    copy("content-type");
    copy("accept");
    return h;
  }

  async standardizeInitialError(initialResponse) {
    let upstreamText = "";
    try {
      upstreamText = await initialResponse.clone().text();
      this.logError(`Upstream error body: ${this.truncate(upstreamText)}`);
    } catch (e) {
      this.logError(`Failed to read upstream error text: ${e.message}`);
    }

    let standardized = null;
    if (upstreamText) {
      try {
        const parsed = JSON.parse(upstreamText);
        if (parsed && parsed.error && typeof parsed.error === "object" && typeof parsed.error.code === "number") {
          if (!parsed.error.status) parsed.error.status = this.statusToGoogleStatus(parsed.error.code);
          standardized = parsed;
        }
      } catch (_) {}
    }

    if (!standardized) {
      const code = initialResponse.status;
      const message = code === 429 ? "Resource has been exhausted (e.g. check quota)." : (initialResponse.statusText || "Request failed");
      const status = this.statusToGoogleStatus(code);
      standardized = {
        error: {
          code,
          message,
          status,
          details: upstreamText ? [{ "@type": "proxy.upstream", upstream_error: this.truncate(upstreamText) }] : undefined
        }
      };
    }

    const safeHeaders = new Headers();
    safeHeaders.set("Content-Type", "application/json; charset=utf-8");
    safeHeaders.set("Access-Control-Allow-Origin", "*");
    safeHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Goog-Api-Key");
    const retryAfter = initialResponse.headers.get("Retry-After");
    if (retryAfter) safeHeaders.set("Retry-After", retryAfter);

    return new Response(JSON.stringify(standardized), {
      status: initialResponse.status,
      statusText: initialResponse.statusText,
      headers: safeHeaders
    });
  }

  async writeSSEErrorFromUpstream(writer, upstreamResp) {
    const SSE_ENCODER = new TextEncoder();
    const std = await this.standardizeInitialError(upstreamResp);
    let text = await std.text();
    const ra = upstreamResp.headers.get("Retry-After");
    if (ra) {
      try {
        const obj = JSON.parse(text);
        obj.error.details = (obj.error.details || []).concat([{ "@type": "proxy.retry", retry_after: ra }]);
        text = JSON.stringify(obj);
      } catch (_) {}
    }
    await writer.write(SSE_ENCODER.encode(`event: error\ndata: ${text}\n\n`));
  }

  async* sseLineIterator(reader) {
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    this.logDebug("Starting SSE line iteration.");
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        this.logDebug(`SSE stream ended. Remaining buffer: "${buffer.trim()}"`);
        if (buffer.trim()) yield buffer;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          yield line;
        }
      }
    }
  }

  detectLanguage(text) {
    if (!text || text.length < 10) return 'en';
    
    const patterns = {
      'zh': /[\u4e00-\u9fa5]/g,
      'ja': /[\u3040-\u309f\u30a0-\u30ff]/g,
      'ko': /[\uac00-\ud7af\u1100-\u11ff]/g,
      'ar': /[\u0600-\u06ff]/g,
      'ru': /[\u0400-\u04ff]/g
    };
    
    let maxCount = 0;
    let detectedLang = 'en';
    
    for (const [lang, pattern] of Object.entries(patterns)) {
      const matches = text.match(pattern);
      const count = matches ? matches.length : 0;
      if (count > maxCount) {
        maxCount = count;
        detectedLang = lang;
      }
    }
    
    if (maxCount > text.length * 0.1) {
      return detectedLang;
    }
    
    if (/[àâäæãåāèéêëēėęîïíīįìôöòóœøōõûüùúūÿñńß]/i.test(text)) {
      if (/[àâæçèéêëîïôœùûüÿ]/i.test(text)) return 'fr';
      if (/[äöüß]/i.test(text)) return 'de';
      if (/[áéíóúñ¿¡]/i.test(text)) return 'es';
    }
    
    return 'en';
  }

  buildRetryRequestBody(originalBody, accumulatedText) {
    this.logDebug(`Building retry request. Accumulated text length: ${accumulatedText.length}`);
    this.logDebug(`Accumulated text preview (includes thoughts): ${this.truncate(accumulatedText, 500)}`);
    
    const retryBody = JSON.parse(JSON.stringify(originalBody));
    if (!retryBody.contents) retryBody.contents = [];

    const detectedLang = this.detectLanguage(accumulatedText);
    this.logInfo(`Detected language: ${detectedLang}`);
    
    const retryPrompt = this.config.retry_prompts[detectedLang] || 
                      this.config.retry_prompts['default'];
    
    this.logDebug(`Using retry prompt: ${retryPrompt}`);

    const lastUserIndex = retryBody.contents.map(c => c.role).lastIndexOf("user");

    const history = [
      { role: "model", parts: [{ text: accumulatedText }] },
      { role: "user", parts: [{ text: retryPrompt }] }
    ];

    if (lastUserIndex !== -1) {
      retryBody.contents.splice(lastUserIndex + 1, 0, ...history);
    } else {
      retryBody.contents.push(...history);
    }
    
    this.logDebug(`Constructed retry request body (sanitized):`, sanitizeBody(retryBody));
    return retryBody;
  }

  async processStreamAndRetryInternally({ initialReader, writer, originalRequestBody, upstreamUrl, originalHeaders }) {
    let accumulatedText = "";
    let consecutiveRetryCount = 0;
    let currentReader = initialReader;
    const sessionStartTime = Date.now();

    this.logInfo(`Starting stream processing session. Max retries: ${this.config.max_consecutive_retries}`);

    const cleanup = (reader) => { 
      if (reader) { 
        this.logDebug("Cancelling reader"); 
        reader.cancel().catch(() => {}); 
      } 
    };

    while (true) {
      let interruptionReason = null;
      const streamStartTime = Date.now();
      let linesInThisStream = 0;
      let textInThisStream = "";
      let hasReceivedFinalAnswerContent = false;
      let hasReceivedToolCalls = false;

      this.logInfo(`=== Starting stream attempt ${consecutiveRetryCount + 1}/${this.config.max_consecutive_retries + 1} ===`);

      try {
        let finishReasonArrived = false;

        for await (const line of this.sseLineIterator(currentReader)) {
          linesInThisStream++;
          await writer.write(new TextEncoder().encode(line + "\n\n"));
          this.logDebug(`SSE Line ${linesInThisStream}: ${this.truncate(line, 500)}`);

          if (!line.startsWith("data: ")) continue;

          let payload;
          try {
            payload = JSON.parse(line.slice(6));
          } catch (e) {
            this.logDebug("Ignoring non-JSON data line.");
            continue;
          }

          const candidate = payload?.candidates?.[0];
          if (!candidate) continue;

          const parts = candidate.content?.parts;
          if (parts && Array.isArray(parts)) {
            for (const part of parts) {
              if (typeof part.text === 'string') {
                accumulatedText += part.text;
                textInThisStream += part.text;

                if (part.thought !== true) {
                  hasReceivedFinalAnswerContent = true;
                  this.logDebug("Received final answer content (non-thought part).");
                } else {
                  this.logDebug("Received 'thought' content part.");
                }
              } else if (part.functionCall || part.toolCode) {
                hasReceivedToolCalls = true;
                this.logInfo(`Tool/function call detected: ${this.truncate(JSON.stringify(part))}`);
              }
            }
          }

          const finishReason = candidate.finishReason;
          if (finishReason) {
            finishReasonArrived = true;
            this.logInfo(`Finish reason received: ${finishReason}`);

            if (finishReason === "STOP") {
              if (hasReceivedFinalAnswerContent || hasReceivedToolCalls) {
                const sessionDuration = Date.now() - sessionStartTime;
                this.logInfo(`=== STREAM COMPLETED SUCCESSFULLY ===`);
                this.logInfo(`  - Total session duration: ${sessionDuration}ms, Retries: ${consecutiveRetryCount}`);
                return writer.close();
              } else if (accumulatedText.length > 100) {
                this.logInfo(`Stream finished with STOP, accumulated text length: ${accumulatedText.length}`);
                return writer.close();
              } else {
                this.logError(`Stream finished with STOP but insufficient content received.`);
                interruptionReason = "STOP_WITHOUT_SUFFICIENT_CONTENT";
                break;
              }
            } else if (finishReason === "MAX_TOKENS" || finishReason === "TOOL_CODE" || finishReason === "SAFETY" || finishReason === "RECITATION") {
              this.logInfo(`Stream terminated with reason: ${finishReason}. Closing stream.`);
              return writer.close();
            } else {
              this.logError(`Abnormal/unknown finish reason: ${finishReason}`);
              interruptionReason = "FINISH_ABNORMAL";
              break;
            }
          }
        }

        if (!finishReasonArrived && !interruptionReason) {
          this.logError(`Stream ended prematurely without a finish reason (DROP).`);
          interruptionReason = hasReceivedToolCalls ? "DROP_DURING_TOOL_USE" : "DROP";
        }

      } catch (e) {
        this.logError(`Exception during stream processing:`, e.message, e.stack);
        interruptionReason = "FETCH_ERROR";
      } finally {
        cleanup(currentReader);
        this.logInfo(`Stream attempt ${consecutiveRetryCount + 1} summary: Duration: ${Date.now() - streamStartTime}ms, ` + 
          `Lines: ${linesInThisStream}, Chars: ${textInThisStream.length}, Total Chars: ${accumulatedText.length}`);
      }

      if (!interruptionReason) {
        this.logInfo("Stream finished without interruption. Closing.");
        return writer.close();
      }

      this.logError(`=== STREAM INTERRUPTED (Reason: ${interruptionReason}) ===`);
      
      if (consecutiveRetryCount >= this.config.max_consecutive_retries) {
        this.logError("Retry limit exceeded. Sending final error to client.");
        const SSE_ENCODER = new TextEncoder();
        const payload = {
          error: { 
            code: 504, 
            status: "DEADLINE_EXCEEDED", 
            message: `Proxy retry limit (${this.config.max_consecutive_retries}) exceeded. Last interruption: ${interruptionReason}.`
          }
        };
        await writer.write(SSE_ENCODER.encode(`event: error\ndata: ${JSON.stringify(payload)}\n\n`));
        return writer.close();
      }

      consecutiveRetryCount++;
      this.logInfo(`Proceeding to retry attempt ${consecutiveRetryCount}...`);

      try {
        if (this.config.retry_delay_ms > 0) {
          this.logDebug(`Waiting ${this.config.retry_delay_ms}ms before retrying...`);
          await new Promise(res => setTimeout(res, this.config.retry_delay_ms));
        }
        
        const retryBody = this.buildRetryRequestBody(originalRequestBody, accumulatedText);
        const retryHeaders = this.buildUpstreamHeaders(originalHeaders);

        this.logDebug(`Making retry request to: ${sanitizeUrl(upstreamUrl)}`);
        
        const retryRequest = new Request(upstreamUrl, {
            method: "POST",
            headers: retryHeaders,
            body: JSON.stringify(retryBody)
        });
        const retryResponse = await this.proxy.connectHttp(retryRequest, upstreamUrl);

        this.logInfo(`Retry request completed. Status: ${retryResponse.status} ${retryResponse.statusText}`);

        if (NON_RETRYABLE_STATUSES.has(retryResponse.status)) {
          this.logError(`FATAL: Received non-retryable status ${retryResponse.status} during retry.`);
          await this.writeSSEErrorFromUpstream(writer, retryResponse);
          return writer.close();
        }

        if (!retryResponse.ok || !retryResponse.body) {
          throw new Error(`Upstream server error on retry: ${retryResponse.status}`);
        }
        
        this.logInfo(`✓ Retry successful. Got new stream.`);
        currentReader = retryResponse.body.getReader();
        this.networkRetryCount = 0;
        
      } catch (e) {
        this.logError(`Exception during retry setup:`, e.message);
        this.networkRetryCount++;
        
        if (this.networkRetryCount >= this.config.max_network_retries) {
          this.logError(`Network retry limit (${this.config.max_network_retries}) exceeded. Terminating.`);
          const SSE_ENCODER = new TextEncoder();
          const payload = {
            error: { 
              code: 502, 
              status: "BAD_GATEWAY", 
              message: `Network error during retry: ${e.message}. Max network retries exceeded.`
            }
          };
          await writer.write(SSE_ENCODER.encode(`event: error\ndata: ${JSON.stringify(payload)}\n\n`));
          return writer.close();
        }
        
        const backoffDelay = Math.min(this.networkRetryCount * 2000, 10000);
        this.logInfo(`Network error, waiting ${backoffDelay}ms before retry ${this.networkRetryCount}/${this.config.max_network_retries}`);
        await new Promise(res => setTimeout(res, backoffDelay));
      }
    }
  }

  async handleStreamingPost(request, upstreamUrl) {
    this.logInfo(`=== NEW GEMINI STREAMING REQUEST (via SocketProxy): ${request.method} ${sanitizeUrl(upstreamUrl)} ===`);

    let originalRequestBody;
    try {
      const requestText = await request.clone().text();
      originalRequestBody = JSON.parse(requestText);
      this.logInfo(`Request body (sanitized):`, sanitizeBody(originalRequestBody));

      if (Array.isArray(originalRequestBody.contents)) {
        this.logInfo(`Request contains ${originalRequestBody.contents.length} messages`);
      }

    } catch (e) {
      this.logError("Failed to parse request body:", e.message);
      return this.jsonError(400, "Invalid JSON in request body", e.message);
    }

    this.logInfo("=== MAKING INITIAL REQUEST TO GEMINI (via SocketProxy) ===");
    const initialRequest = new Request(upstreamUrl, {
      method: request.method,
      headers: this.buildUpstreamHeaders(request.headers),
      body: JSON.stringify(originalRequestBody)
    });

    const t0 = Date.now();
    
    const initialResponse = await this.proxy.connectHttp(initialRequest, upstreamUrl);

    this.logInfo(`Initial Gemini response received in ${Date.now() - t0}ms. Status: ${initialResponse.status}`);

    if (!initialResponse.ok) {
      this.logError(`Initial request failed with status ${initialResponse.status}.`);
      return await this.standardizeInitialError(initialResponse);
    }

    const initialReader = initialResponse.body?.getReader();
    if (!initialReader) {
      return this.jsonError(502, "Bad Gateway", "Gemini returned a success code but the response body is missing.");
    }

    this.logInfo("✓ Initial request successful. Starting stream processing.");
    const { readable, writable } = new TransformStream();
    
    this.processStreamAndRetryInternally({
      initialReader,
      writer: writable.getWriter(),
      originalRequestBody,
      upstreamUrl,
      originalHeaders: request.headers
    }).catch(e => {
      this.logError("!!! UNHANDLED CRITICAL EXCEPTION IN STREAM PROCESSOR !!!", e.message, e.stack);
      try { writable.getWriter().close(); } catch (_) {}
    });

    return new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }

  async handleNonStreaming(request, upstreamUrl) {
    this.logInfo(`=== NEW GEMINI NON-STREAMING REQUEST (via SocketProxy): ${request.method} ${sanitizeUrl(upstreamUrl)} ===`);

    const upstreamReq = new Request(upstreamUrl, {
      method: request.method,
      headers: this.buildUpstreamHeaders(request.headers),
      body: request.body
    });

    const resp = await this.proxy.connectHttp(upstreamReq, upstreamUrl);
    
    if (!resp.ok) return await this.standardizeInitialError(resp);

    const headers = new Headers(resp.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    return new Response(resp.body, { 
      status: resp.status, 
      statusText: resp.statusText, 
      headers 
    });
  }

  jsonError(status, message, details = null) {
    return ErrorResponse.create(status, message, details);
  }

  async handle(request, dstUrl) {
    try {
      const url = new URL(dstUrl);
      const isStream = url.searchParams.get("alt") === "sse";
      
      if (request.method === "POST" && isStream) {
        return await this.handleStreamingPost(request, dstUrl);
      }
      return await this.handleNonStreaming(request, dstUrl);
    } catch (e) {
      this.logError("!!! GEMINI HANDLER EXCEPTION !!!", e.message, e.stack);
      return ErrorResponse.serverError("The Gemini proxy handler encountered a critical error.", e.message);
    }
  }
}

class BaseProxy {
  constructor(config) {
    this.config = config;
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
    this.activeConnections = new Set();
    
    this.log = config.DEBUG_MODE
      ? (message, ...data) => console.log(`[DEBUG] ${message}`, ...data)
      : () => {};
  }

  cleanupResources(...resources) {
    for (const resource of resources) {
      if (!resource) continue;
      
      try {
        if (resource.close) {
          resource.close();
        } else if (resource.cancel) {
          resource.cancel();
        } else if (resource.releaseLock) {
          resource.releaseLock();
        }
      } catch (e) {
        this.log("Resource cleanup error", e.message);
      }
    }
  }

  handleError(error, context, status = 500) {
    this.log(`${context} failed`, error.message);
    return ErrorResponse.create(status, `Error ${context.toLowerCase()}: ${error.message}`);
  }

  filterHeaders(headers) {
    const HEADER_FILTER_RE = /^(host|accept-encoding|cf-|cdn-|referer|referrer)/i;
    const cleanedHeaders = new Headers();
    
    for (const [k, v] of headers) {
      if (!HEADER_FILTER_RE.test(k)) {
        cleanedHeaders.set(k, v);
      }
    }
    
    return cleanedHeaders;
  }

  generateWebSocketKey() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes));
  }

  concatUint8Arrays(...arrays) {
    const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const arr of arrays) {
      result.set(arr, offset);
      offset += arr.length;
    }
    return result;
  }

  parseHttpHeaders(buff) {
    const text = this.decoder.decode(buff);
    const headerEnd = text.indexOf("\r\n\r\n");
    if (headerEnd === -1) return null;
    const headerSection = text.slice(0, headerEnd).split("\r\n");
    const statusLine = headerSection[0];
    const statusMatch = statusLine.match(/HTTP\/1\.[01] (\d+) (.*)/);
    if (!statusMatch) throw new Error(`Invalid status line: ${statusLine}`);
    const headers = new Headers();
    for (let i = 1; i < headerSection.length; i++) {
      const line = headerSection[i];
      const idx = line.indexOf(": ");
      if (idx !== -1) {
        headers.append(line.slice(0, idx), line.slice(idx + 2));
      }
    }
    return { status: Number(statusMatch[1]), statusText: statusMatch[2], headers, headerEnd };
  }

  async readUntilDoubleCRLF(reader) {
    let respText = "";
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        respText += this.decoder.decode(value, { stream: true });
        if (respText.includes("\r\n\r\n")) break;
      }
      if (done) break;
    }
    return respText;
  }

  async parseResponse(reader, socket) {
    let buff = new Uint8Array();
    
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (value) {
          buff = this.concatUint8Arrays(buff, value);
          const parsed = this.parseHttpHeaders(buff);
          if (parsed) {
            const { status, statusText, headers, headerEnd } = parsed;
            const isChunked = headers.get("transfer-encoding")?.includes("chunked");
            const contentLength = parseInt(headers.get("content-length") || "0", 10);
            const data = buff.slice(headerEnd + 4);
            const self = this;
            
            return new Response(
              new ReadableStream({
                async start(ctrl) {
                  try {
                    if (isChunked) {
                      for await (const chunk of self.readChunks(reader, data)) {
                        ctrl.enqueue(chunk);
                      }
                    } else {
                      let received = data.length;
                      if (data.length) ctrl.enqueue(data);
                      while (received < contentLength) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        received += value.length;
                        ctrl.enqueue(value);
                      }
                    }
                    ctrl.close();
                  } catch (err) {
                    ctrl.error(err);
                  } finally {
                    self.cleanupResources(socket);
                  }
                },
              }),
              { status, statusText, headers }
            );
          }
        }
        if (done) break;
      }
      throw new Error("Unable to parse response headers");
    } catch (error) {
      this.cleanupResources(socket);
      throw error;
    }
  }

  async *readChunks(reader, buff = new Uint8Array()) {
    while (true) {
      let pos = -1;
      for (let i = 0; i < buff.length - 1; i++) {
        if (buff[i] === 13 && buff[i + 1] === 10) {
          pos = i;
          break;
        }
      }
      if (pos === -1) {
        const { value, done } = await reader.read();
        if (done) break;
        buff = this.concatUint8Arrays(buff, value);
        continue;
      }
      const sizeStr = this.decoder.decode(buff.slice(0, pos));
      const size = parseInt(sizeStr, 16);
      this.log("Read chunk size", size);
      if (!size) break;
      buff = buff.slice(pos + 2);
      while (buff.length < size + 2) {
        const { value, done } = await reader.read();
        if (done) throw new Error("Unexpected EOF in chunked encoding");
        buff = this.concatUint8Arrays(buff, value);
      }
      yield buff.slice(0, size);
      buff = buff.slice(size + 2);
    }
  }

  relayWebSocketFrames(ws, socket, writer, reader) {
    this.wsWriter = writer;
    
    const TIMEOUT_MS = 300000;
    let timeoutId = setTimeout(() => {
      this.log("WebSocket connection timeout, cleaning up");
      cleanup();
    }, TIMEOUT_MS);
    
    const cleanup = () => {
      clearTimeout(timeoutId);
      this.cleanupResources(ws, socket, writer, reader);
      this.activeConnections.delete(connectionId);
    };
    
    const connectionId = Date.now() + Math.random();
    this.activeConnections.add(connectionId);
    
    const resetTimeout = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        this.log("WebSocket connection timeout, cleaning up");
        cleanup();
      }, TIMEOUT_MS);
    };
    
    const messageHandler = async (event) => {
      try {
        resetTimeout();
        
        let payload;
        if (typeof event.data === "string") {
          payload = this.encoder.encode(event.data);
        } else if (event.data instanceof ArrayBuffer) {
          payload = new Uint8Array(event.data);
        } else {
          payload = event.data;
        }
        const frame = this.packTextFrame(payload);
        await writer.write(frame);
      } catch (e) {
        this.log("Remote write error", e);
        cleanup();
      }
    };
    
    ws.addEventListener("message", messageHandler);
    
    const errorHandler = (error) => {
      this.log("WebSocket error", error);
      cleanup();
    };
    
    ws.addEventListener("error", errorHandler);
    
    const closeHandler = () => {
      this.log("WebSocket closed");
      cleanup();
    };
    
    ws.addEventListener("close", closeHandler);
    
    (async () => {
      const frameReader = new this.SocketFramesReader(reader, this, writer);
      try {
        while (true) {
          const frame = await frameReader.nextFrame();
          if (!frame) break;
          
          resetTimeout();
          
          switch (frame.opcode) {
            case 1:
            case 2:
              ws.send(frame.payload);
              break;
            case 8:
              this.log("Received Close frame, closing WebSocket");
              ws.close(1000);
              cleanup();
              return;
            case 9:
            case 10:
              break;
            default:
              this.log(`Received unknown frame type, Opcode: ${frame.opcode}`);
          }
        }
      } catch (e) {
        this.log("Error reading remote frame", e);
      } finally {
        cleanup();
      }
    })();
  }

  _packFrame(opcode, payload = new Uint8Array(0)) {
    const FIN = 0x80;
    const FIN_AND_OP = FIN | opcode;
    const maskBit = 0x80;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = new Uint8Array(2);
      header[0] = FIN_AND_OP;
      header[1] = maskBit | len;
    } else if (len < 65536) {
      header = new Uint8Array(4);
      header[0] = FIN_AND_OP;
      header[1] = maskBit | 126;
      header[2] = (len >> 8) & 0xff;
      header[3] = len & 0xff;
    } else {
      throw new Error("Payload too large");
    }
    const mask = new Uint8Array(4);
    crypto.getRandomValues(mask);
    const maskedPayload = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      maskedPayload[i] = payload[i] ^ mask[i % 4];
    }
    return this.concatUint8Arrays(header, mask, maskedPayload);
  }

  packTextFrame(payload) {
    return this._packFrame(0x1, payload);
  }

  packPongFrame(payload = new Uint8Array(0)) {
    return this._packFrame(0xa, payload);
  }

  packPingFrame(payload = new Uint8Array(0)) {
    return this._packFrame(0x9, payload);
  }

  SocketFramesReader = class {
    constructor(reader, parent, writer) {
      this.reader = reader;
      this.parent = parent;
      this.writer = writer;
      this.buffer = new Uint8Array();
      this.fragmentedPayload = null;
      this.fragmentedOpcode = null;
    }
    
    async ensureBuffer(length) {
      while (this.buffer.length < length) {
        const { value, done } = await this.reader.read();
        if (done) return false;
        this.buffer = this.parent.concatUint8Arrays(this.buffer, value);
      }
      return true;
    }
    
    async nextFrame() {
      while (true) {
        if (!(await this.ensureBuffer(2))) return null;
        const first = this.buffer[0],
          second = this.buffer[1],
          fin = (first >> 7) & 1,
          opcode = first & 0x0f,
          isMasked = (second >> 7) & 1;
        let payloadLen = second & 0x7f,
          offset = 2;
        if (payloadLen === 126) {
          if (!(await this.ensureBuffer(offset + 2))) return null;
          payloadLen = (this.buffer[offset] << 8) | this.buffer[offset + 1];
          offset += 2;
        } else if (payloadLen === 127) {
          throw new Error("127 length mode is not supported");
        }
        let mask;
        if (isMasked) {
          if (!(await this.ensureBuffer(offset + 4))) return null;
          mask = this.buffer.slice(offset, offset + 4);
          offset += 4;
        }
        if (!(await this.ensureBuffer(offset + payloadLen))) return null;
        let payload = this.buffer.slice(offset, offset + payloadLen);
        if (isMasked && mask) {
          for (let i = 0; i < payload.length; i++) {
            payload[i] ^= mask[i % 4];
          }
        }
        this.buffer = this.buffer.slice(offset + payloadLen);
        
        if (opcode === 9) {
          this.parent.log("Received Ping frame, sending Pong response");
          try {
            const pongFrame = this.parent.packPongFrame(payload);
            await this.writer.write(pongFrame);
            this.parent.log("Pong frame sent successfully");
          } catch (e) {
            this.parent.log("Failed to send Pong frame", e);
          }
          continue;
        }
        
        if (opcode === 10) {
          this.parent.log("Received Pong frame");
          continue;
        }
        
        if (opcode === 0) {
          if (this.fragmentedPayload === null)
            throw new Error("Received continuation frame without initiation");
          this.fragmentedPayload = this.parent.concatUint8Arrays(this.fragmentedPayload, payload);
          if (fin) {
            const completePayload = this.fragmentedPayload;
            const completeOpcode = this.fragmentedOpcode;
            this.fragmentedPayload = this.fragmentedOpcode = null;
            return { fin: true, opcode: completeOpcode, payload: completePayload };
          }
        } else {
          if (!fin) {
            this.fragmentedPayload = payload;
            this.fragmentedOpcode = opcode;
            continue;
          } else {
            if (this.fragmentedPayload) {
              this.fragmentedPayload = this.fragmentedOpcode = null;
            }
            return { fin, opcode, payload };
          }
        }
      }
    }
  };
}

class SocketProxy extends BaseProxy {
  async connectWebSocket(req, dstUrl) {
    const targetUrl = new URL(dstUrl);
    
    if (!/^wss?:\/\//i.test(dstUrl)) {
      return ErrorResponse.badRequest("Target does not support WebSocket");
    }
    
    const isSecure = targetUrl.protocol === "wss:";
    const port = targetUrl.port || (isSecure ? 443 : 80);
    
    let socket;
    try {
      socket = await connect(
        { hostname: targetUrl.hostname, port: Number(port) },
        { secureTransport: isSecure ? "on" : "off", allowHalfOpen: false }
      );
    } catch (error) {
      this.log("Failed to connect socket", error);
      return ErrorResponse.badGateway("Failed to establish WebSocket connection", error.message);
    }
  
    const key = this.generateWebSocketKey();
    const cleanedHeaders = this.filterHeaders(req.headers);
    
    cleanedHeaders.set('Host', targetUrl.hostname);
    cleanedHeaders.set('Connection', 'Upgrade');
    cleanedHeaders.set('Upgrade', 'websocket');
    cleanedHeaders.set('Sec-WebSocket-Version', '13');
    cleanedHeaders.set('Sec-WebSocket-Key', key);
  
    const handshakeReq =
      `GET ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n` +
      Array.from(cleanedHeaders.entries())
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n') +
      '\r\n\r\n';

    this.log("Sending WebSocket handshake request", handshakeReq);
    
    try {
      const writer = socket.writable.getWriter();
      await writer.write(this.encoder.encode(handshakeReq));
    
      const reader = socket.readable.getReader();
      const handshakeResp = await this.readUntilDoubleCRLF(reader);
      this.log("Received handshake response", handshakeResp);
      
      if (!handshakeResp.includes("101") || !handshakeResp.includes("Switching Protocols")) {
        throw new Error("WebSocket handshake failed: " + handshakeResp);
      }
    
      const webSocketPair = new WebSocketPair();
      const client = webSocketPair[0];
      const server = webSocketPair[1];
      client.accept();
      
      this.relayWebSocketFrames(client, socket, writer, reader);
      return new Response(null, { status: 101, webSocket: server });
      
    } catch (error) {
      this.cleanupResources(socket);
      return ErrorResponse.badGateway("WebSocket handshake failed", error.message);
    }
  }

  async connectHttp(req, dstUrl) {
    const reqForFallback = req.clone();
    const targetUrl = new URL(dstUrl);
    
    const cleanedHeaders = this.filterHeaders(req.headers);
    cleanedHeaders.set("Host", targetUrl.hostname);
    cleanedHeaders.set("accept-encoding", "identity");
    
    const startTime = Date.now();
    let socketError = null;
    let socket = null; 
    
    try {
      const port = targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80);
      socket = await connect(
        { hostname: targetUrl.hostname, port: Number(port) },
        { secureTransport: targetUrl.protocol === "https:" ? "on" : "off", allowHalfOpen: false }
      );
      const writer = socket.writable.getWriter();

      let bodyBuffer = null;
      if (req.body) {
        const bodyArrayBuffer = await req.arrayBuffer(); 
        if (bodyArrayBuffer.byteLength > 0) {
            bodyBuffer = new Uint8Array(bodyArrayBuffer);
            cleanedHeaders.set('Content-Length', bodyBuffer.byteLength.toString()); 
        } else if (req.method === 'POST' || req.method === 'PUT') {
            cleanedHeaders.set('Content-Length', '0');
        }
      }
      
      const requestLine =
        `${req.method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n` +
        Array.from(cleanedHeaders.entries())
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n";
      
      const safeRequestLineForLog =
        `${req.method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n` +
        Array.from(sanitizeHeaders(cleanedHeaders).entries())
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n";
            
      this.log("Sending request via Socket", safeRequestLineForLog);
      await writer.write(this.encoder.encode(requestLine));
    
      if (bodyBuffer) {
        this.log("Forwarding request body from buffer");
        await writer.write(bodyBuffer);
      }
      
      const response = await this.parseResponse(socket.readable.getReader(), socket);
      
      if (this.config.DEBUG_MODE) {
        console.log(`Socket connection successful in ${Date.now() - startTime}ms`);
      }
      
      return response;
      
    } catch (error) {
      socketError = error;
      const socketTime = Date.now() - startTime;
      
      if (socket) {
        this.cleanupResources(socket);
      }
      
      this.log(`Socket connection failed after ${socketTime}ms`, {
        error: error.message,
        target: dstUrl,
        method: req.method
      });
      
      if (this.config.AGGRESSIVE_FALLBACK || this.shouldFallbackToFetch(error)) {
        const fallbackStartTime = Date.now();
        
        try {
          this.log("Attempting Fetch API fallback");
          const fallbackProxy = new FetchProxy(this.config);
          const response = await fallbackProxy.connectHttp(reqForFallback, dstUrl);
          
          if (this.config.DEBUG_MODE) {
            console.log(`Fetch fallback successful in ${Date.now() - fallbackStartTime}ms`);
          }
          
          return response;
          
        } catch (fetchError) {
          const fetchTime = Date.now() - fallbackStartTime;
          
          console.error("Both Socket and Fetch failed", {
            socketError: {
              message: socketError.message,
              time: `${socketTime}ms`
            },
            fetchError: {
              message: fetchError.message,
              time: `${fetchTime}ms`
            },
            targetUrl: dstUrl,
            totalTime: `${Date.now() - startTime}ms`
          });
          
          return ErrorResponse.badGateway(
            "Proxy connection failed",
            {
              socket: {
                error: socketError.message,
                duration: socketTime
              },
              fetch: {
                error: fetchError.message,
                duration: fetchTime
              },
              target: dstUrl,
              timestamp: new Date().toISOString()
            }
          );
        }
      } else {
        return this.handleError(socketError, "Socket connection");
      }
    }
  }

  shouldFallbackToFetch(error) {
    if (!error || !error.message) return false;
    
    const errorMessage = error.message.toLowerCase();
    
    const networkErrorKeywords = [
      'network', 'connection', 'connect', 'socket', 'tcp', 'timeout', 
      'timed out', 'refused', 'reset', 'aborted', 'closed', 'lost', 
      'unreachable', 'econnrefused', 'econnreset', 'etimedout', 
      'enetunreach', 'ehostunreach', 'epipe', 'stream'
    ];
    
    return networkErrorKeywords.some(keyword => errorMessage.includes(keyword));
  }
}

class FetchProxy extends BaseProxy {
  async connectHttp(req, dstUrl) {
    const targetUrl = new URL(dstUrl);
    const cleanedHeaders = this.filterHeaders(req.headers);
    cleanedHeaders.set("Host", targetUrl.hostname);
    
    try {
      const fetchRequest = new Request(dstUrl, {
        method: req.method,
        headers: cleanedHeaders,
        body: req.body,
        redirect: 'follow',
        signal: AbortSignal.timeout(30000)
      });
      
      this.log("Using Fetch API to connect to", dstUrl);
      const response = await fetch(fetchRequest);
      
      if (this.config.DEBUG_MODE) {
        console.log(`Fetch response: ${response.status} ${response.statusText}`);
      }
      
      return response;
    } catch (error) {
      this.log("Fetch connection failed", {
        error: error.message,
        target: dstUrl
      });
      
      return ErrorResponse.badGateway(
        "Fetch connection failed",
        {
          message: error.message,
          target: dstUrl,
          timestamp: new Date().toISOString()
        }
      );
    }
  }

  async connectWebSocket(req, dstUrl) {
    return ErrorResponse.badRequest("Fetch proxy does not support WebSocket");
  }
}

function generateIndexPage(authToken, workerUrl) {
  const endpointsHtml = Object.entries(API_MAPPING).map(([route, config]) => {
    const fullUrl = `https://${workerUrl}${route}`;
    const strategyBadge = config.forceFetch 
      ? '<span class="strategy-badge fetch">Fetch</span>' 
      : '<span class="strategy-badge socket">Socket</span>';
    
    return `
      <div class="endpoint-card">
        <div class="endpoint-icon-wrapper">${config.icon}</div>
        <div class="endpoint-info">
          <div class="endpoint-header">
            <div class="endpoint-name">${config.name}</div>
            ${strategyBadge}
          </div>
          <div class="endpoint-route">${route}</div>
          <div class="endpoint-target">→ ${config.displayUrl}</div>
        </div>
        <button class="copy-endpoint-btn" onclick="copyToClipboard(this, '${fullUrl}')" title="复制端点链接">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="check"><polyline points="20 6 9 17 4 12"></polyline></svg>
        </button>
      </div>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LLM API Proxy - 企业级 LLM API 代理解决方案</title>
    <style>
        :root {
            --primary-gradient: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            --dark-bg: #0B0F19;
            --card-bg: rgba(255, 255, 255, 0.03);
            --card-border: rgba(255, 255, 255, 0.1);
            --card-hover-border: rgba(102, 126, 234, 0.5);
            --text-primary: #F0F0F0;
            --text-secondary: #A0A0B0;
            --accent-color: #667eea;
            --success-color: #10b981;
            --code-bg: #1A1D2A;
            --transition-speed: 0.3s;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html { scroll-behavior: smooth; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background-color: var(--dark-bg);
            color: var(--text-primary);
            overflow-x: hidden;
        }
        .container { max-width: 1200px; margin: 0 auto; padding: 2rem; }
        header { text-align: center; padding: 4rem 0 3rem; }
        .logo {
            width: 80px; height: 80px;
            background: var(--primary-gradient);
            border-radius: 20px;
            display: flex; align-items: center; justify-content: center;
            box-shadow: 0 10px 30px rgba(102, 126, 234, 0.3);
            animation: float 4s ease-in-out infinite;
            margin: 0 auto 1.5rem;
        }
        @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-12px); } }
        h1 {
            font-size: clamp(2.5rem, 5vw, 3.5rem);
            font-weight: 700;
            margin-bottom: 0.8rem;
            background: linear-gradient(135deg, #fff 0%, #c2b2ff 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .subtitle { font-size: clamp(1rem, 2.5vw, 1.2rem); color: var(--text-secondary); }
        
        .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1.5rem; margin: 4rem 0; }
        .feature-card {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 16px; padding: 2rem;
            backdrop-filter: blur(10px);
            transition: all var(--transition-speed) ease;
            position: relative; overflow: hidden;
        }
        .feature-card:hover {
            transform: translateY(-8px);
            border-color: var(--card-hover-border);
            background: rgba(255, 255, 255, 0.05);
        }
        .feature-icon { color: var(--accent-color); margin-bottom: 1rem; }
        .feature-title { font-size: 1.15rem; font-weight: 600; margin-bottom: 0.6rem; color: var(--text-primary); }
        .feature-description { color: var(--text-secondary); line-height: 1.6; font-size: 0.9rem; }

        .section-header { text-align: center; margin-bottom: 3rem; }
        .section-title {
            font-size: clamp(2rem, 4vw, 2.5rem);
            font-weight: 600; margin-bottom: 0.8rem;
            background: linear-gradient(135deg, #fff 0%, #c2b2ff 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .section-subtitle { color: var(--text-secondary); font-size: 1rem; }

        .endpoints-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 1.5rem; }
        .endpoint-card {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 12px; padding: 1.5rem;
            display: flex; align-items: center; gap: 1.2rem;
            transition: all var(--transition-speed) ease;
        }
        .endpoint-card:hover { border-color: var(--card-hover-border); transform: translateX(5px); }
        .endpoint-icon-wrapper {
            width: 48px; height: 48px;
            background: rgba(102, 126, 234, 0.1);
            border-radius: 10px; display: flex; align-items: center; justify-content: center;
            font-size: 1.5rem; flex-shrink: 0;
        }
        .endpoint-info { flex: 1; min-width: 0; }
        .endpoint-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.3rem; }
        .endpoint-name { font-weight: 600; font-size: 1rem; color: var(--text-primary); }
        .strategy-badge { font-size: 0.7rem; padding: 0.2rem 0.5rem; border-radius: 6px; font-weight: 500; text-transform: uppercase; }
        .strategy-badge.socket { background: rgba(102, 126, 234, 0.2); color: #a78bfa; border: 1px solid rgba(102, 126, 234, 0.3); }
        .strategy-badge.fetch { background: rgba(16, 185, 129, 0.2); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); }
        .endpoint-route { color: var(--accent-color); font-family: 'SF Mono', Monaco, monospace; font-size: 0.9rem; margin-bottom: 0.3rem; }
        .endpoint-target { color: var(--text-secondary); font-size: 0.85rem; word-break: break-all; }
        
        .copy-endpoint-btn {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid var(--card-border);
            color: var(--text-secondary);
            width: 40px; height: 40px; border-radius: 8px;
            cursor: pointer; transition: all var(--transition-speed) ease;
            display: flex; align-items: center; justify-content: center; flex-shrink: 0;
            position: relative;
        }
        .copy-endpoint-btn:hover { background: var(--accent-color); color: white; border-color: var(--accent-color); }
        .copy-endpoint-btn svg { position: absolute; transition: opacity 0.2s ease; }
        .copy-endpoint-btn svg.check { opacity: 0; }
        .copy-endpoint-btn.copied { background-color: var(--success-color); border-color: var(--success-color); }
        .copy-endpoint-btn.copied svg { opacity: 0; }
        .copy-endpoint-btn.copied svg.check { color: white; opacity: 1; }

        .usage-section { margin-top: 5rem; }
        .usage-container {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 16px; overflow: hidden; backdrop-filter: blur(10px);
        }
        .usage-tabs-wrapper { border-bottom: 1px solid var(--card-border); position: relative; }
        .usage-tabs { display: flex; gap: 0.5rem; padding: 0 1.5rem; overflow-x: auto; -webkit-overflow-scrolling: touch; }
        .usage-tabs::-webkit-scrollbar { display: none; }
        .usage-tab {
            padding: 1rem 1.2rem;
            background: transparent; border: none;
            color: var(--text-secondary);
            border-radius: 8px 8px 0 0;
            cursor: pointer; transition: color var(--transition-speed) ease;
            font-size: 0.95rem; white-space: nowrap; flex-shrink: 0; font-weight: 500;
        }
        .usage-tab:hover { color: var(--text-primary); }
        .usage-tab.active { color: var(--text-primary); }
        .usage-tabs-indicator {
            position: absolute; bottom: 0; left: 0;
            height: 2px; background-color: var(--accent-color);
            transition: all var(--transition-speed) cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        .usage-content-wrapper { padding: 2.5rem; }
        .usage-content { display: none; }
        .usage-content.active { display: block; animation: fadeIn 0.5s ease; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        
        .usage-example { margin-bottom: 2rem; }
        .usage-example:last-child { margin-bottom: 0; }
        .usage-description { color: var(--text-secondary); margin-bottom: 1.5rem; line-height: 1.7; font-size: 1rem; max-width: 70ch; }
        
        .code-block { background: var(--code-bg); border: 1px solid var(--card-border); border-radius: 10px; overflow: hidden; }
        .code-block-header {
            display: flex; justify-content: space-between; align-items: center;
            background: rgba(0,0,0,0.2);
            padding: 0.6rem 1rem;
            border-bottom: 1px solid var(--card-border);
        }
        .code-block-title { font-size: 0.85rem; color: var(--text-secondary); font-family: 'SF Mono', Monaco, monospace; }
        .code-block-copy-btn {
            background: none; border: none; color: var(--text-secondary);
            cursor: pointer; padding: 0.2rem; display: flex; align-items: center;
            transition: color var(--transition-speed) ease;
            position: relative;
        }
        .code-block-copy-btn:hover { color: var(--text-primary); }
        .code-block-copy-btn .copy-text { margin-left: 0.4rem; font-size: 0.8rem; }
        .code-block-copy-btn .copy-text:after { content: '复制'; }
        .code-block-copy-btn.copied .copy-text:after { content: '已复制!'; }
        
        .usage-code {
            font-family: 'SF Mono', Monaco, 'Fira Code', 'Inconsolata', monospace;
            font-size: 0.9rem; line-height: 1.7;
            color: #C1C2DA; white-space: pre-wrap; word-break: break-all;
            display: block; padding: 1.5rem;
        }
        .usage-code .comment { color: #6C7086; }
        .usage-code .keyword { color: #ff79c6; }
        .usage-code .string { color: #f1fa8c; }
        
        footer { text-align: center; padding: 3rem 0 2rem; border-top: 1px solid var(--card-border); margin-top: 4rem; }
        .footer-content { font-size: 0.95rem; color: var(--text-secondary); margin-bottom: 1rem; }
        .footer-links { display: flex; justify-content: center; gap: 1.5rem; }
        .footer-link { color: var(--text-secondary); text-decoration: none; transition: color var(--transition-speed) ease; display: flex; align-items: center; gap: 0.5rem; }
        .footer-link:hover { color: var(--accent-color); }
        
        .toast {
            position: fixed; bottom: 2rem; right: 2rem;
            background: #2D303E; border: 1px solid var(--card-border);
            color: var(--text-primary); padding: 0.8rem 1.2rem;
            border-radius: 8px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
            display: flex; align-items: center; gap: 0.7rem;
            animation: slideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
            z-index: 1000; font-size: 0.95rem;
        }
        @keyframes slideIn { from { transform: translateX(120%); } to { transform: translateX(0); } }
        @keyframes slideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(120%); opacity: 0; } }
        
        @media (max-width: 768px) {
            .container { padding: 1rem; }
            header { padding: 3rem 0 2rem; }
            .features, .endpoints-grid { grid-template-columns: 1fr; }
            .usage-content-wrapper { padding: 1.5rem; }
            .usage-tabs { padding: 0 1rem; }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <div class="logo">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
            </div>
            <h1>LLM API Proxy</h1>
            <p class="subtitle">企业级 LLM API 代理解决方案</p>
        </header>

        <main>
            <div class="features">
                <div class="feature-card">
                    <div class="feature-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg></div>
                    <h3 class="feature-title">零隐私泄露</h3>
                    <p class="feature-description">原生 TCP Socket 实现，完全消除 CF-* 请求头，保护真实身份。</p>
                </div>
                <div class="feature-card">
                    <div class="feature-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg></div>
                    <h3 class="feature-title">智能策略</h3>
                    <p class="feature-description">端点级策略控制，支持 Socket/Fetch 灵活切换与自动回退。</p>
                </div>
                <div class="feature-card">
                    <div class="feature-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg></div>
                    <h3 class="feature-title">全协议支持</h3>
                    <p class="feature-description">完整支持 HTTP/HTTPS 和 WebSocket，兼容所有 API 服务。</p>
                </div>
                <div class="feature-card">
                    <div class="feature-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect><rect x="9" y="9" width="6" height="6"></rect><line x1="9" y1="1" x2="9" y2="4"></line><line x1="15" y1="1" x2="15" y2="4"></line><line x1="9" y1="20" x2="9" y2="23"></line><line x1="15" y1="20" x2="15" y2="23"></line><line x1="20" y1="9" x2="23" y2="9"></line><line x1="20" y1="14" x2="23" y2="14"></line><line x1="1" y1="9" x2="4" y2="9"></line><line x1="1" y1="14" x2="4" y2="14"></line></svg></div>
                    <h3 class="feature-title">Gemini 优化</h3>
                    <p class="feature-description">多语言智能重试，确保长篇“思维链”推理的完整性。</p>
                </div>
            </div>

            <section class="endpoints-section">
                <div class="section-header">
                    <h2 class="section-title">预置 API 端点</h2>
                    <p class="section-subtitle">为主流 AI 服务预配置的快速访问路由</p>
                </div>
                <div class="endpoints-grid">${endpointsHtml}</div>
            </section>

            <section class="usage-section">
                <div class="section-header">
                    <h2 class="section-title">使用说明</h2>
                    <p class="section-subtitle">了解如何配置和使用代理的各项功能</p>
                </div>
                <div class="usage-container">
                    <div class="usage-tabs-wrapper">
                        <div class="usage-tabs">
                            <button class="usage-tab active" data-tab="standard">标准代理</button>
                            <button class="usage-tab" data-tab="preset">预置端点</button>
                            <button class="usage-tab" data-tab="strategy">连接策略</button>
                            <button class="usage-tab" data-tab="websocket">WebSocket</button>
                            <button class="usage-tab" data-tab="gemini">Gemini 优化</button>
                            <button class="usage-tab" data-tab="integration">集成示例</button>
                            <button class="usage-tab" data-tab="config">环境配置</button>
                        </div>
                        <div class="usage-tabs-indicator"></div>
                    </div>
                    
                    <div class="usage-content-wrapper">
                        <div id="standard" class="usage-content active">
                            <p class="usage-description">直接代理任何 HTTP/HTTPS 端点，灵活控制请求目标。支持完整的请求转发，包括 Headers、Body 和查询参数。此模式始终需要认证令牌。</p>
                            <div class="usage-example">
                               <div class="code-block">
                                    <div class="code-block-header"><span class="code-block-title">基本格式</span><button class="code-block-copy-btn" onclick="copyCode(this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg><span class="copy-text"></span></button></div>
                                    <code class="usage-code">https://${workerUrl}/<span class="keyword">{AUTH_TOKEN}</span>/https/api.example.com/v1/endpoint</code>
                                </div>
                            </div>
                             <div class="usage-example">
                               <div class="code-block">
                                    <div class="code-block-header"><span class="code-block-title">实际示例</span><button class="code-block-copy-btn" onclick="copyCode(this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg><span class="copy-text"></span></button></div>
                                    <code class="usage-code"><span class="comment"># 代理 HTTPBin 测试服务</span>
https://${workerUrl}/<span class="keyword">{AUTH_TOKEN}</span>/https/httpbin.org/get

<span class="comment"># 代理 IP 查询服务</span>
https://${workerUrl}/<span class="keyword">{AUTH_TOKEN}</span>/https/api.ipify.org?format=json</code>
                                </div>
                            </div>
                        </div>
                        
                        <div id="preset" class="usage-content">
                            <p class="usage-description">使用预配置路由快速访问主流 AI 服务，无需记住完整地址。所有预置端点都经过优化配置，确保最佳性能。默认公开，可开启强制认证。</p>
                            <div class="usage-example">
                               <div class="code-block">
                                    <div class="code-block-header"><span class="code-block-title">OpenAI GPT</span><button class="code-block-copy-btn" onclick="copyCode(this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg><span class="copy-text"></span></button></div>
                                    <code class="usage-code"><span class="comment"># 公开访问 (默认)</span>
https://${workerUrl}/openai/v1/chat/completions

<span class="comment"># 启用 PRESET_AUTH_ENABLED=true 后的访问方式</span>
https://${workerUrl}/<span class="keyword">{AUTH_TOKEN}</span>/openai/v1/chat/completions</code>
                                </div>
                            </div>
                             <div class="usage-example">
                               <div class="code-block">
                                    <div class="code-block-header"><span class="code-block-title">Anthropic Claude</span><button class="code-block-copy-btn" onclick="copyCode(this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg><span class="copy-text"></span></button></div>
                                    <code class="usage-code"><span class="comment"># Claude 3 对话接口</span>
https://${workerUrl}/claude/v1/messages</code>
                                </div>
                            </div>
                        </div>
                        
                        <div id="strategy" class="usage-content">
                             <p class="usage-description">不同端点采用不同的连接策略以优化性能和兼容性。系统会根据配置自动选择最佳策略，并在 Socket 连接失败时无缝回退到 Fetch。</p>
                             <div class="usage-example">
                               <div class="code-block">
                                    <div class="code-block-header"><span class="code-block-title">🔌 Socket 策略 (默认)</span></div>
                                    <code class="usage-code"><span class="comment">// 优点：完全隐藏 CF-* 头，隐私保护最佳。</span>
<span class="comment">// 缺点：某些网络环境或防火墙可能不兼容。</span>
<span class="comment">// 适用：Telegram, Cohere, GitHub Models 等。</span></code>
                                </div>
                            </div>
                             <div class="usage-example">
                               <div class="code-block">
                                    <div class="code-block-header"><span class="code-block-title">⚡ Fetch 策略 (强制)</span></div>
                                    <code class="usage-code"><span class="comment">// 优点：兼容性好，连接稳定，适合已知不支持 Socket 的服务。</span>
<span class="comment">// 缺点：会包含 Cloudflare 添加的 cf-* 请求头。</span>
<span class="comment">// 适用：OpenAI, Claude, Groq, DeepInfra 等。</span></code>
                                </div>
                            </div>
                        </div>
                        
                        <div id="websocket" class="usage-content">
                             <p class="usage-description">完整 WebSocket 协议支持，适用于实时通信场景。代理会自动处理底层的 TCP Socket 握手和帧中继，并支持 Ping/Pong 控制帧以处理连接保活。</p>
                            <div class="usage-example">
                               <div class="code-block">
                                    <div class="code-block-header"><span class="code-block-title">连接格式</span><button class="code-block-copy-btn" onclick="copyCode(this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg><span class="copy-text"></span></button></div>
                                    <code class="usage-code">wss://${workerUrl}/<span class="keyword">{AUTH_TOKEN}</span>/wss/websocket.example.com/path</code>
                                </div>
                            </div>
                             <div class="usage-example">
                               <div class="code-block">
                                    <div class="code-block-header"><span class="code-block-title">JavaScript 示例</span><button class="code-block-copy-btn" onclick="copyCode(this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg><span class="copy-text"></span></button></div>
                                    <code class="usage-code"><span class="keyword">const</span> ws = <span class="keyword">new</span> WebSocket(<span class="string">'wss://${workerUrl}/{AUTH_TOKEN}/wss/echo.websocket.org'</span>);

ws.onopen = () => console.log(<span class="string">'✅ 连接已建立'</span>);
ws.onmessage = (event) => console.log(<span class="string">'📨 收到消息:'</span>, event.data);
ws.onerror = (error) => console.error(<span class="string">'❌ WebSocket 错误:'</span>, error);
ws.onclose = () => console.log(<span class="string">'🔌 连接已关闭'</span>);</code>
                                </div>
                            </div>
                        </div>
                        
                        <div id="gemini" class="usage-content">
                             <p class="usage-description">为 Gemini API 流式响应量身定制的优化功能，能自动检测并从中断处恢复生成，确保长对话和复杂推理（思维链）的完整性。可通过环境变量开关此功能。</p>
                            <div class="usage-example">
                               <div class="code-block">
                                    <div class="code-block-header"><span class="code-block-title">特性说明</span></div>
                                    <code class="usage-code"><span class="comment">// 🔄 自动重试机制</span>
<span class="comment">// - 检测流中断 (DROP) 并智能重试。</span>
<span class="comment">// - 保留已生成的上下文，发送续写指令。</span>
<span class="comment">// - 网络错误指数退避，增加重连成功率。</span>

<span class="comment">// 🌍 多语言支持</span>
<span class="comment">// - 自动检测内容语言 (中/英/日/韩等)。</span>
<span class="comment">// - 使用对应语言的续写提示，避免混淆。</span></code>
                                </div>
                            </div>
                             <div class="usage-example">
                               <div class="code-block">
                                    <div class="code-block-header"><span class="code-block-title">开启流式响应</span><button class="code-block-copy-btn" onclick="copyCode(this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg><span class="copy-text"></span></button></div>
                                    <code class="usage-code"><span class="comment"># 在请求 URL 末尾加上 ?alt=sse</span>
https://${workerUrl}/gemini/v1beta/models/gemini-pro:streamGenerateContent?alt=sse</code>
                                </div>
                             </div>
                        </div>
                        
                        <div id="integration" class="usage-content">
                            <p class="usage-description">在您的应用程序中集成 LLM API Proxy 非常简单。只需将原始 API 的主机地址替换为代理地址即可。</p>
                             <div class="usage-example">
                               <div class="code-block">
                                    <div class="code-block-header"><span class="code-block-title">Python (requests)</span><button class="code-block-copy-btn" onclick="copyCode(this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg><span class="copy-text"></span></button></div>
                                    <code class="usage-code"><span class="keyword">import</span> requests
<span class="keyword">import</span> os

PROXY_BASE = <span class="string">"https://${workerUrl}"</span>
CLAUDE_API_KEY = os.environ.get(<span class="string">"CLAUDE_API_KEY"</span>)

response = requests.post(
    f<span class="string">"{PROXY_BASE}/claude/v1/messages"</span>,
    headers={
        <span class="string">"x-api-key"</span>: CLAUDE_API_KEY,
        <span class="string">"anthropic-version"</span>: <span class="string">"2023-06-01"</span>
    },
    json={
        <span class="string">"model"</span>: <span class="string">"claude-3-opus-20240229"</span>,
        <span class="string">"messages"</span>: [{<span class="string">"role"</span>: <span class="string">"user"</span>, <span class="string">"content"</span>: <span class="string">"Hello, Claude!"</span>}]
    }
)
print(response.json())</code>
                                </div>
                            </div>
                            <div class="usage-example">
                               <div class="code-block">
                                    <div class="code-block-header"><span class="code-block-title">Rust (reqwest)</span><button class="code-block-copy-btn" onclick="copyCode(this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg><span class="copy-text"></span></button></div>
                                    <code class="usage-code"><span class="keyword">use</span> reqwest;
<span class="keyword">use</span> serde_json::json;

<span class="keyword">async fn</span> call_openai() -> Result<(), reqwest::Error> {
    <span class="keyword">let</span> proxy_base = <span class="string">"https://${workerUrl}"</span>;
    <span class="keyword">let</span> api_key = std::env::var(<span class="string">"OPENAI_API_KEY"</span>).unwrap();
    <span class="keyword">let</span> client = reqwest::Client::new();
    
    <span class="keyword">let</span> response = client
        .post(format!(<span class="string">"{}/openai/v1/chat/completions"</span>, proxy_base))
        .bearer_auth(api_key)
        .json(&json!({
            <span class="string">"model"</span>: <span class="string">"gpt-4-turbo"</span>,
            <span class="string">"messages"</span>: [{<span class="string">"role"</span>: <span class="string">"user"</span>, <span class="string">"content"</span>: <span class="string">"Say this is a test!"</span>}]
        }))
        .send().<span class="keyword">await</span>?;
    
    println!(<span class="string">"{:?}"</span>, response.json::<<span class="keyword">serde_json</span>::Value>().<span class="keyword">await</span>?);
    Ok(())
}</code>
                                </div>
                            </div>
                        </div>
                        
                        <div id="config" class="usage-content">
                            <p class="usage-description">通过在 Cloudflare Worker 中设置环境变量来配置代理服务的核心行为。以下是所有可用的配置项及其说明。</p>
                            <div class="usage-example">
                               <div class="code-block">
                                    <div class="code-block-header"><span class="code-block-title">核心配置</span><button class="code-block-copy-btn" onclick="copyCode(this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg><span class="copy-text"></span></button></div>
                                    <code class="usage-code"><span class="comment"># 认证令牌（必须修改）</span>
AUTH_TOKEN=<span class="string">"your-secure-token-here"</span>

<span class="comment"># 预设端点强制认证 (true/false, 默认 false)</span>
PRESET_AUTH_ENABLED=<span class="string">"false"</span>

<span class="comment"># 调试模式 (true/false, 生产环境建议关闭)</span>
DEBUG_MODE=<span class="string">"false"</span></code>
                                </div>
                            </div>
                            <div class="usage-example">
                               <div class="code-block">
                                    <div class="code-block-header"><span class="code-block-title">Gemini 专用配置</span><button class="code-block-copy-btn" onclick="copyCode(this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg><span class="copy-text"></span></button></div>
                                    <code class="usage-code"><span class="comment"># Gemini 特殊处理逻辑 (true/false, 默认 true)</span>
GEMINI_SPECIAL_HANDLING_ENABLED=<span class="string">"true"</span>

<span class="comment"># 自定义中文续写提示</span>
GEMINI_RETRY_PROMPT_CN=<span class="string">"请从刚才中断的地方继续回答"</span>

<span class="comment"># 自定义英文续写提示</span>
GEMINI_RETRY_PROMPT_EN=<span class="string">"Continue from where you stopped"</span></code>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>
        </main>

        <footer>
            <p class="footer-content">LLM API Proxy © 2025 - 基于 Cloudflare Workers 构建</p>
            <div class="footer-links">
                <a href="https://github.com/ssfun/llm-api-proxy" target="_blank" rel="noopener noreferrer" class="footer-link">
                    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"></path></svg>
                    <span>@SFUN</span>
                </a>
            </div>
        </footer>
    </div>
    <script>
        function showToast(message) {
            const existingToast = document.querySelector('.toast');
            if (existingToast) existingToast.remove();
            
            const toast = document.createElement('div');
            toast.className = 'toast';
            toast.innerHTML = \`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--success-color)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> \${message}\`;
            document.body.appendChild(toast);
            
            setTimeout(() => {
                toast.style.animation = 'slideOut 0.4s cubic-bezier(0.7, 0, 0.84, 0)';
                setTimeout(() => toast.remove(), 400);
            }, 2500);
        }

        function copyToClipboard(button, text) {
            navigator.clipboard.writeText(text).then(() => {
                button.classList.add('copied');
                showToast('链接已复制');
                setTimeout(() => button.classList.remove('copied'), 2000);
            });
        }

        function copyCode(button) {
            const code = button.closest('.code-block').querySelector('code').innerText;
            navigator.clipboard.writeText(code).then(() => {
                button.classList.add('copied');
                setTimeout(() => button.classList.remove('copied'), 2000);
            });
        }
        
        document.addEventListener('DOMContentLoaded', () => {
            const tabs = document.querySelectorAll('.usage-tab');
            const contents = document.querySelectorAll('.usage-content');
            const indicator = document.querySelector('.usage-tabs-indicator');
            const activeTab = document.querySelector('.usage-tab.active');

            function updateIndicator(tab) {
                if (!indicator || !tab) return;
                indicator.style.width = \`\${tab.offsetWidth}px\`;
                indicator.style.transform = \`translateX(\${tab.offsetLeft}px)\`;
            }

            tabs.forEach(tab => {
                tab.addEventListener('click', (e) => {
                    const tabName = e.target.dataset.tab;
                    
                    tabs.forEach(t => t.classList.remove('active'));
                    e.target.classList.add('active');
                    
                    updateIndicator(e.target);
                    
                    contents.forEach(content => {
                        content.classList.remove('active');
                        if (content.id === tabName) {
                            content.classList.add('active');
                        }
                    });
                });
            });

            // Ensure indicator is positioned correctly on load
            if (activeTab) {
                 // Use a small timeout to ensure layout is calculated
                setTimeout(() => updateIndicator(activeTab), 50);
            }
            window.addEventListener('resize', () => {
                const currentActiveTab = document.querySelector('.usage-tab.active');
                if(currentActiveTab) updateIndicator(currentActiveTab);
            });
        });
    </script>
</body>
</html>`;
}

class SpectreProxy {
  static async handleRequest(req, env, ctx) {
    try {
      const config = ConfigManager.updateConfigFromEnv(env);
      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean);

      // 路由 1: 根路径，显示项目页面 (不受认证影响)
      if (parts.length === 0) {
        const workerUrl = url.hostname;
        return new Response(generateIndexPage(config.AUTH_TOKEN, workerUrl), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }

      // 路由 2: /test 公开测试路由 (不受认证影响)
      if (parts[0] === 'test') {
        const proxy = new SocketProxy(config);
        return await proxy.connectHttp(req, config.DEFAULT_DST_URL);
      }

      let effectiveParts = [...parts];
      let isAuthenticated = false;

      // 检查认证令牌
      if (parts.length > 0 && parts[0] === config.AUTH_TOKEN) {
        isAuthenticated = true;
        effectiveParts.shift();
      }

      if (effectiveParts.length === 0) {
        // 访问路径只有令牌，例如 https://worker.dev/your-auth-token
        return ErrorResponse.badRequest("目标 URL 缺失。");
      }

      const routeKey = '/' + effectiveParts[0];

      // 路由 3: 预设的 API 端点
      if (API_MAPPING[routeKey]) {
        // 根据 PRESET_AUTH_ENABLED 配置决定是否需要认证
        if (config.PRESET_AUTH_ENABLED && !isAuthenticated) {
            return ErrorResponse.unauthorized("此预设端点需要认证。");
        }

        const routeConfig = API_MAPPING[routeKey];
        const selectedTarget = RouteSelector.selectTarget(routeConfig.targets);
        
        if (!selectedTarget) {
          return ErrorResponse.notFound(`预设路由 ${routeKey} 未配置目标地址。`);
        }

        const remainingPath = effectiveParts.slice(1).join('/');
        const dstUrl = selectedTarget + (remainingPath ? '/' + remainingPath : '') + url.search;
        
        // 根据 GEMINI_SPECIAL_HANDLING_ENABLED 决定是否对 /gemini 启用特殊处理
        if (routeKey === '/gemini' && config.GEMINI_SPECIAL_HANDLING_ENABLED) {
          const proxy = new SocketProxy(config);
          const geminiHandler = new GeminiHandler(config, proxy);
          return await geminiHandler.handle(req, dstUrl);
        }
        
        const upgradeHeader = req.headers.get("Upgrade")?.toLowerCase();
        if (upgradeHeader === "websocket") {
          const proxy = new SocketProxy(config);
          return await proxy.connectWebSocket(req, dstUrl);
        }
        
        const forceFetch = routeConfig.forceFetch || false;
        const proxy = forceFetch ? new FetchProxy(config) : new SocketProxy(config);
        return await proxy.connectHttp(req, dstUrl);
      }

      // 路由 4: 通用代理 (必须经过认证)
      // 只有在提供了令牌，并且请求的不是一个预设路由时，才将其视为通用代理
      if (isAuthenticated) {
        const [protocol, ...pathParts] = effectiveParts;
        let dstUrl;
        
        if (protocol.endsWith(':')) {
            dstUrl = `${protocol}//${pathParts.join("/")}${url.search}`;
        } else {
            dstUrl = `${protocol}://${pathParts.join("/")}${url.search}`;
        }
        
        try {
            new URL(dstUrl);
        } catch (e) {
            return ErrorResponse.badRequest("无效的通用代理目标 URL。", dstUrl);
        }
        
        const upgradeHeader = req.headers.get("Upgrade")?.toLowerCase();
        if (upgradeHeader === "websocket") {
            const proxy = new SocketProxy(config);
            return await proxy.connectWebSocket(req, dstUrl);
        }
        
        const proxy = new SocketProxy(config);
        return await proxy.connectHttp(req, dstUrl);
      }
      
      // 如果代码执行到这里，意味着它不是一个公共预设端点，并且没有提供有效的令牌
      return ErrorResponse.unauthorized("端点不存在或需要认证。");

    } catch (error) {
      console.error("SpectreProxy error:", error.stack);
      return ErrorResponse.serverError("代理服务发生内部错误。", error.message);
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    return await SpectreProxy.handleRequest(request, env, ctx);
  }
};
