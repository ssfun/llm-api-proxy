# LLM API Proxy

[](https://opensource.org/licenses/MIT)
[](https://workers.cloudflare.com/)
[](https://www.google.com/search?q=CONTRIBUTING.md)

一个部署在 Cloudflare Workers 上的企业级、高隐私、智能 LLM API 代理网关。

## 📖 项目简介

`LLM API Proxy` 是一个功能强大的 API 代理解决方案，旨在为开发者提供一个安全、高效、可控的大语言模型（LLM）API 访问层。通过部署在 Cloudflare 的全球边缘网络上，它不仅能加速您的 API 请求，还能通过独特的技术实现极致的隐私保护，并为特定模型（如 Google Gemini）提供增强的稳定性和可靠性。

无论您是希望保护 API 密钥、简化客户端配置、还是确保复杂推理任务不中断，`LLM API Proxy` 都能提供卓越的解决方案。

![项目主页](https://github.com/ssfun/llm-api-proxy/blob/main/Preview.png?raw=true)

## ✨ 核心特性

  * **🛡️ 极致的隐私保护**

      * 通过 Cloudflare 的 `connect()` API 实现原生 TCP Socket 连接，请求直达目标服务器，**完全消除了 `cf-*`、`x-forwarded-for` 等任何可能泄露客户端真实 IP 和中间人信息的请求头**，实现了真正的零隐私泄露。
      * 与传统的 `fetch` 代理相比，隐私保护能力更胜一筹。

  * **✨ 强大的 Gemini 优化**

      * 内置为 Google Gemini API 定制的**智能流式响应恢复机制**。
      * 当“思维链（Chain-of-thought）”等长篇内容生成因网络问题中断时，代理会自动检测、保留上下文并发起续写请求，确保推理的完整性。
      * 支持\*\*多语言（中/英/日/韩等）\*\*自动检测和相应的续写提示，避免语言混淆。

  * **⚡ 智能连接策略**

      * 默认采用 **Socket 优先**策略，在追求极致隐私的同时，当遇到不兼容的网络环境时，会自动无缝回退到 `Fetch` 策略，兼顾隐私与可用性。
      * 支持为特定 API 端点（如 OpenAI, Claude 等使用 Cloudflare 网络，不支持 TCP Socket 连接的 API 服务商）强制配置 `Fetch` 策略，以获得最佳兼容性。
      * API 端点支持以数组的形式配置多个上游 targets ，实现随机调用。
      * 建议为 OpenAI, Claude 等使用 Cloudflare 网络的 API 服务商单独部署 [Supabase API 网关(待补充)](https://github.com/ssfun)，实现更好的隐私保护。

  * **🚀 灵活的路由模式**

      * **预设端点模式**：为数十种主流 LLM 服务（OpenAI, Anthropic, Google, Groq 等）预设了简短的访问路径，简化客户端配置。
      * **通用代理模式**：通过授权令牌，可将此 Worker 作为一个私有的、安全的代理，转发到互联网上任何一个 HTTP/HTTPS API。

  * **🔧 丰富的可配置性**

      * 所有核心功能均可通过 Cloudflare Worker 的**环境变量**进行配置，无需修改代码。例如，您可以一键开启对预设端点的强制认证，或关闭 Gemini 的特殊优化。

  * **🌐 全协议支持**

      * 完整支持 `HTTP/HTTPS` 协议的代理。
      * 完整支持 `WebSocket` 协议的代理，适用于需要实时通信的场景。

  * **📊 精美的仪表盘**

      * 访问 Worker 根目录即可看到一个功能齐全、设计精美的仪表盘，直观展示了所有预设端点、功能特性和详细的使用说明。

## 🚀 快速开始 / 部署指南

部署该项目非常简单，全程无需复杂的命令行操作。

#### 前提条件

  * 一个 [Cloudflare](https://www.cloudflare.com/) 账户。

#### 部署步骤

1.  **创建 Worker 服务**

      * 登录您的 Cloudflare 仪表盘。
      * 在左侧菜单中，转到 **Workers & Pages**。
      * 点击 **Create application** \> **Create Worker**。
      * 为您的 Worker 指定一个子域名（例如 `my-llm-proxy`），然后点击 **Deploy**。

2.  **粘贴代码**

      * 部署后，点击 **Edit code** 进入在线编辑器。
      * 将本项目 `worker.js` 文件中的**全部代码**复制并粘贴到编辑器中，覆盖原有内容。

3.  **配置环境变量**

      * 在编辑器页面，返回 Worker 的主配置页（点击顶部的 Worker 名称）。
      * 转到 **Settings** \> **Variables** \> **Environment Variables**，点击 **Add variable**。
      * 根据下方的环境变量详解，添加您需要的配置。**强烈建议**您首先设置一个安全的 `AUTH_TOKEN`。
      * 点击 **Save and Deploy**。

4.  **完成！**

      * 您的 `LLM API Proxy` 现在已经成功部署并运行在 `https://<your-worker-name>.<your-subdomain>.workers.dev` 上。

## ⚙️ 环境变量详解

通过设置环境变量来控制代理的行为。

| 变量名                            | 说明                                                                             | 默认值                  | 示例                               |
| --------------------------------- | -------------------------------------------------------------------------------- | ----------------------- | ---------------------------------- |
| **`AUTH_TOKEN`** | **（必需）** 用于通用代理模式和预设端点认证的安全令牌。请务必修改为一个复杂的字符串。 | `"your-auth-token"`     | `"client"`        |
| `PRESET_AUTH_ENABLED`             | 是否对所有预设端点（如 `/openai`）强制启用 `AUTH_TOKEN` 认证。                     | `false`                 | `true`                             |
| `GEMINI_SPECIAL_HANDLING_ENABLED` | 是否为 `/gemini` 端点启用特殊的智能重试和流式恢复逻辑。                          | `true`                  | `false`                            |
| `DEBUG_MODE`                      | 是否开启调试模式。开启后，会在日志中输出更详细的连接信息。                         | `false`                 | `true`                             |
| `AGGRESSIVE_FALLBACK`             | 是否开启激进回退模式。开启后，任何 Socket 连接失败都会尝试回退到 Fetch。           | `true`                  | `false`                            |
| `GEMINI_RETRY_PROMPT_CN`          | 自定义 Gemini 续写时的中文提示。                                                 | (内置默认值)            | `"请从中断处继续"`                 |
| `GEMINI_RETRY_PROMPT_EN`          | 自定义 Gemini 续写时的英文提示。                                                 | (内置默认值)            | `"Continue from where you left off"` |

## 🕹️ 使用方法

### 1\. 预设端点模式 (Preset Endpoint Mode)

直接使用简短的路径访问主流 LLM 服务。

  * **默认（公开访问）**：

    ```bash
    curl https://<your-worker-url>/openai/v1/chat/completions \
      -H "Authorization: Bearer $OPENAI_API_KEY" \
      -H "Content-Type: application/json" \
      -d '{
        "model": "gpt-4-turbo",
        "messages": [{"role": "user", "content": "Hello!"}]
      }'
    ```

  * **开启 `PRESET_AUTH_ENABLED` 后（私有访问）**：

    ```bash
    # URL 路径前需要加上你的 AUTH_TOKEN
    curl https://<your-worker-url>/<AUTH_TOKEN>/openai/v1/chat/completions \
      -H "Authorization: Bearer $OPENAI_API_KEY" \
      ...
    ```

### 2\. 通用代理模式 (Generic Proxy Mode)

代理任意 API，URL 格式为： `https://<worker-url>/<AUTH_TOKEN>/<目标URL协议>/<目标URL域名>/<路径>`

```bash
# 代理 https://api.ipify.org?format=json
curl https://<your-worker-url>/<AUTH_TOKEN>/https/api.ipify.org?format=json

# 响应: {"ip":"x.x.x.x"}
```

### 3\. WebSocket 代理

URL 格式为：`wss://<worker-url>/<AUTH_TOKEN>/<目标WSS协议>/<目标WSS域名>/<路径>`

```javascript
// JavaScript 客户端示例
const ws = new WebSocket(
  'wss://<your-worker-url>/<AUTH_TOKEN>/wss/echo.websocket.org'
);

ws.onopen = () => {
  console.log('WebSocket 连接已建立');
  ws.send('Hello from LLM API Proxy!');
};

ws.onmessage = (event) => {
  console.log('收到消息: ', event.data);
};
```
## 🙏 鸣谢

- [@XyzenSun](https://github.com/XyzenSun/SpectreProxy) 的 SpectreProxy 项目，本项目基于此高度定制

- [@kev1npros](https://linux.do/t/topic/861821) 、 [@Shikha](https://linux.do/t/topic/864744) 的 Gemini 防截断方案

## 🤝 贡献

欢迎任何形式的贡献！如果您有任何想法、建议或发现了 Bug，请随时提交 [Issues](https://www.google.com/search?q=https://github.com/your-repo/llm-api-proxy/issues) 或 [Pull Requests](https://www.google.com/search?q=https://github.com/your-repo/llm-api-proxy/pulls)。

## 📄 许可证

本项目基于 [MIT License](https://www.google.com/search?q=LICENSE) 开源。
