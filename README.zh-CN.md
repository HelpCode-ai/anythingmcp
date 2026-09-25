<p align="center">
  <img src="docs/assets/banner.png" alt="AnythingMCP — 259 个连接器，其中 20 个无需 API 密钥。将 REST、SOAP/WSDL、GraphQL、SQL 和 MCP 系统转化为 Claude、ChatGPT、Copilot 和 Gemini 的工具。" width="100%" />
</p>

<h1 align="center">AnythingMCP</h1>

<p align="center">
  <a href="README.md">English</a> · <a href="README.de.md">Deutsch</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <strong>让 Claude、ChatGPT 和 Copilot 安全访问企业已经在使用的软件。</strong><br/>
  259 个现成适配器，无需编写代码即可连接任意 REST、SOAP、GraphQL 或 SQL 系统，全部运行在你自己的基础设施上，并能学习各个系统之间的关系。
</p>

<p align="center">
  <a href="https://github.com/HelpCode-ai/anythingmcp/stargazers"><img src="https://img.shields.io/github/stars/HelpCode-ai/anythingmcp?style=flat&logo=github&logoColor=white&color=2563eb&labelColor=0b1220" alt="GitHub Stars"></a>
  <a href="https://github.com/HelpCode-ai/anythingmcp/releases"><img src="https://img.shields.io/github/v/release/HelpCode-ai/anythingmcp?include_prereleases&color=2563eb&labelColor=0b1220" alt="Release"></a>
  <a href="https://github.com/HelpCode-ai/anythingmcp/blob/main/LICENSE"><img src="https://img.shields.io/badge/open%20source-AGPL--3.0-2563eb?labelColor=0b1220" alt="Open source, AGPL-3.0"></a>
  <a href="https://hub.docker.com/r/helpcodeai/anythingmcp"><img src="https://img.shields.io/docker/pulls/helpcodeai/anythingmcp?logo=docker&logoColor=white&color=2563eb&labelColor=0b1220" alt="Docker pulls"></a>
</p>

**Claude 回答了一个此前聊天机器人无法回答的问题**，因为相关数据位于使用 REST 而非 MCP 的现场服务系统中：

<p align="center">
  <img src="docs/assets/demo-claude.gif" alt="Claude 回答某位技术人员上周走访了哪些公司的问题，并调用 AnythingMCP 针对实际运行中的现场服务系统提供的工具。" width="100%" />
</p>

**自己运行试试** — 三行命令，无需克隆仓库，[详细说明见下文](#run-it-yourself)：

```bash
mkdir anythingmcp && cd anythingmcp
curl -fsSLo docker-compose.yml \
  https://raw.githubusercontent.com/HelpCode-ai/anythingmcp/main/docker-compose.quickstart.yml
printf 'JWT_SECRET=%s\nENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
docker compose up -d   # → http://localhost:3000
```

---

本文反复使用的三个术语，分别指不同的概念：

- **适配器（adapter）**：本仓库随附的 259 个 JSON 定义之一，例如 DATEV、weclapp、DHL、Deutsche Bahn、Shopware、Personio、Handelsregister 等。其中 20 个完全不需要 API 密钥，其余适配器会在导入时要求你提供相应凭据。
- **连接器（connector）**：在工作区中配置好的适配器，或你自己的 OpenAPI 规范、Postman 集合、WSDL、GraphQL 端点或数据库。只要有可连接的目标，就能在几分钟内完成配置，无需编写 MCP 服务器。
- **MCP 服务器**：你提供给 Claude 的那个 URL。它只公开分配给它的连接器，不会公开其他连接器。

所有组件都运行在你自己的基础设施上，因此你可以决定哪些数据能够离开它。每个工具的响应映射定义哪些字段可以到达模型；凭据以 AES-256-GCM 加密存储；完整的上游响应则保存在你自己的审计日志中。OAuth2、RBAC、SSO 和 SCIM 已包含在自行托管版本中，并非付费套餐专属功能。

**[KOCH Freiburg GmbH](https://www.kochfreiburg.de/) 已在生产环境使用 AnythingMCP**，将 AI 助手连接到 15 个以上的内部系统，包括 ERP、CRM、SOAP 服务和本地数据库。德国弗赖堡的 [helpcode.ai](https://helpcode.ai) 将 AnythingMCP 从该系统中提取出来并开源，因为适配器目录由社区共同建设，比作为单一产品发展得更快。

---

<a id="run-it-yourself"></a>

## 自己运行

**推荐使用以下方式**，下方的性能测量也基于此方式。需要 Docker 24+ 和 `openssl`；在 macOS 上，请先启动 Docker Desktop。

```bash
mkdir anythingmcp && cd anythingmcp
curl -fsSLo docker-compose.yml \
  https://raw.githubusercontent.com/HelpCode-ai/anythingmcp/main/docker-compose.quickstart.yml
printf 'JWT_SECRET=%s\nENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
docker compose up -d
```

打开 <http://localhost:3000> 并注册 — **第一个账户将成为管理员**。

> **请妥善保存生成的 `.env` 文件。** `ENCRYPTION_KEY` 用于解密已存储的凭据。如果丢失它，就必须重新为每个连接器配置凭据。请将其备份到你保存其他机密信息的位置。

| 服务 | 默认 URL |
|---|---|
| Web 界面 | `http://localhost:3000` |
| MCP 端点 | `http://localhost:4000/mcp` |
| Swagger 文档 | `http://localhost:4000/api/docs` |

*amd64 实测：拉取镜像耗时 31 秒，API 就绪并显示登录页面耗时 24 秒。目前发布的镜像仅支持 amd64。Compose 文件明确指定了平台，因此也可以通过 Docker Desktop 的模拟功能在 Apple Silicon 上运行。在一台 M 系列芯片笔记本上，同样的启动过程耗时 24 秒，但在较旧的硬件上可能需要几分钟。*

快速启动配置有意将服务绑定到 `127.0.0.1`，因为前面还没有负责 TLS 终止的组件。**如果需要让其他人或云端 AI 客户端访问实例**，请克隆仓库并运行 `./setup.sh`。该脚本会询问域名、通过 Caddy 获取证书、生成机密信息，并设置 MCP 认证模式。详见[部署指南](docs/deployment.md)。

<details>
<summary><strong>其他部署方式</strong> — 托管云、Railway、DigitalOcean</summary>

<br/>

[**AnythingMCP Cloud**](https://cloud.anythingmcp.com) 使用相同的 AGPL 代码，由我们在**德国法兰克福**运营。你可以先在那里连接自己的 API，体验功能，而无需自行准备基础设施；如果之后希望将凭据保留在内部，也可以迁移到自行托管环境，两种方式使用相同的连接器。可通过 [info@helpcode.ai](mailto:info@helpcode.ai) 申请 DPA/AVV。SSO 和 SCIM 仅适用于自行托管版本。

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/8-X4WD?referralCode=k30bPV&utm_medium=integration&utm_source=template&utm_campaign=generic)
&nbsp;
[![Install on DigitalOcean](https://www.deploytodo.com/do-btn-blue.svg)](https://marketplace.digitalocean.com/apps/anythingmcp)

</details>

---

## 连接、管理与学习

### 连接

- **5 种连接器类型** — [REST](docs/connectors/rest.md)、[SOAP](docs/connectors/soap.md)、[GraphQL](docs/connectors/graphql.md)、[数据库](docs/connectors/database.md)、[MCP 到 MCP 桥接](docs/connectors/mcp-bridge.md)。支持七种数据库引擎：PostgreSQL、MySQL、MariaDB、MSSQL、Oracle、MongoDB、SQLite。
- **导入现有资源** — OpenAPI/Swagger、Postman、cURL、WSDL、GraphQL 内省，或直接从运行中的 MCP 服务器发现工具。
- **适配器目录** — [查看已随附的内容](#the-adapter-catalog)。
- **可视化工具编辑器** — 将参数映射到路径、查询参数、请求体和请求头；调整工具的名称和描述，让 AI 按照你的意图理解它们。
- **动态 MCP 服务器** — 工具在运行时注册，无需重启。支持每个连接器独立的 `{{VAR}}` 插值，且对 AI 隐藏。

### 管理

- **[响应塑形](#control-what-the-model-sees)** — 精确定义每个工具可以向模型提供哪些字段，并实时预览处理前后的结果。
- **在需要的地方只允许读取。** 每个工具都带有 MCP 注解（`readOnlyHint`、`destructiveHint`），根据操作类型生成，也可以按工具覆盖。因此，客户端能够区分读取发票和开具贷项通知单。基于角色的工具白名单可以让你发布一个只读 MCP 服务器，这也是大多数人在接入 ERP 时应采用的起点。
- **覆盖常见认证方式** — OAuth2（PKCE 和 Client Credentials）、Bearer、API Key、Basic、WS-Security、客户端证书、[LOGIN_TOKEN](docs/connectors/login-token-auth.md) 和 OAuth 1.0a。
- **审计日志** — 每次工具调用的输入、输出、耗时和状态都会记录在你自己的数据库中。
- **[SSO](docs/sso.md) 和 [SCIM](docs/scim-entra-setup.md)** — 支持 Entra ID、Google、Okta、Auth0 及通用 OIDC。每次登录都会从目录服务的用户组同步角色。在目录中停用用户，其工作区访问权限和 MCP API 密钥也会随之失效（仅适用于自行托管版本）。

### 学习

- **[知识图谱](docs/knowledge-graph.md)** — 为每个工作区维护一张保护个人身份信息（PII）的关系图，展示连接器数据之间的联系，并以 MCP 工具的形式提供给智能体，帮助它正确串联跨系统调用。
- **[AI 技能](docs/knowledge-graph.md)** — 将重复出现的使用模式转化为简短、可复用的规则，并合并到服务器指令中，使其无需增加工具调用就能引导智能体（可选，需主动启用）。

---

## AnythingMCP 与其他项目的区别

经常被拿来与 AnythingMCP 比较的项目，大多是 MCP 网关：它们聚合、限定访问范围并保护你已经拥有的 MCP 服务器。AnythingMCP 从更早的一步开始，因为大多数企业根本还没有 MCP 服务器，只有 REST API、一个 2009 年的 SOAP 服务，以及不希望直接暴露的数据库。下面的每个项目都在解决实际问题，只是它们解决的并不是同一个问题。

| | 项目定位 | 以下情况更适合选择它 |
|---|---|---|
| **[ContextForge](https://github.com/IBM/mcp-context-forge)**（IBM） | 为现有 MCP 服务器提供联邦聚合和注册中心 | 你的工具已经是 MCP 服务器，需要的是联邦聚合、虚拟服务器和注册中心 |
| **[Docker MCP Gateway](https://github.com/docker/mcp-gateway)** | 将目录中的 MCP 服务器作为容器运行在同一个端点后，并处理机密信息 | 你希望将供应商发布的 MCP 服务器隔离在 Docker 中，且现有目录已能满足需求 |
| **[MetaMCP](https://github.com/metatool-ai/metamcp)** | 通过中间件层，将 MCP 服务器聚合到划分了命名空间的端点中 | 你主要需要按客户端对现有 MCP 服务器分组，并重新限定其访问范围 |
| **[Composio](https://github.com/ComposioHQ/composio)** | 提供托管集成目录，并代为处理认证 | 固定的托管目录已足够，且你不需要加入自己的 SOAP 服务、内部 API 或数据库 |
| **AnythingMCP** | 将企业已经运行的 API、SOAP 服务和数据库转化为 MCP 工具 | 你的系统**还不是** MCP 服务器，而且你希望能够选择自行保管凭据 |

包含完整功能表的逐项比较页面：[anythingmcp.com/vs](https://anythingmcp.com/vs)。

---

<a id="knowledge-graph--ai-skills"></a>

## 知识图谱与 AI 技能

单纯转发调用，仍会把最困难的部分留给智能体：下一步该调用哪个工具，以及业务中的“未完成订单”或“活跃客户”究竟意味着什么。AnythingMCP 会学习这两方面的内容 — **连接器数据之间的关系**，以及**团队实际使用工具的方式** — 再将其作为上下文提供给 AI 客户端，而不是增加额外的工具调用。

- **知识图谱** — 每个工作区都有自己的*实体*（客户、订单、产品等）及其*关系*图。它根据工具名称、参数以及真实调用的输入和输出自动构建；可选的 AI 分析能够推断出启发式规则遗漏的跨连接器关系。它保持 **PII 安全**：只存储实体和字段的*名称*以及关系元数据，绝不存储具体值。
- **可视化构建** — 图编辑器允许你手动创建、编辑和删除实体及关系，添加描述，并审核 AI 提出的建议。
- **通过 MCP 提供** — 每个服务器都公开一个 `kg_how_to_obtain` 工具，让*客户的*智能体可以询问“如何从 Shopware 订单找到 DHL 运单号？”，并获得连接器调用链的提示。
- **从实际使用中生成 AI 技能** — 启用意图记录后，每次工具调用都能记录*为什么*进行这次调用。AI 分析会将重复模式转化为简短、可复用的规则，例如*“今天的营收包括状态为 2、3 和 4 的订单”*。你可以逐条应用、编辑或忽略规则，也可以让系统自动应用置信度高的建议。已应用的技能会在提供服务时合并到 MCP 服务器的**指令**中，**无需增加任何工具调用**就能引导智能体。团队通过使用系统积累的知识，不再只保存在个人的脑海中。

AI 分析**默认关闭**。需要同时启用全局环境变量开关*和*工作区开关，可使用 OpenAI、OpenRouter 或 Anthropic。知识图谱、手动编辑和 MCP 工具本身完全不需要 LLM 密钥。

➡️ **[知识图谱与 AI 技能指南 →](docs/knowledge-graph.md)**

---

<a id="control-what-the-model-sees"></a>

## 控制模型能够看到的内容

每个工具都可以**精确定义哪些字段能够离开你的基础设施**。映射按工具配置，并在响应发出前应用。因此，AI 客户端及其背后的第三方模型只能收到你批准的数据结构。

- **删除不应外传的字段。** 列出需要删除的路径，在响应到达智能体之前将其移除，例如客户的 IBAN、员工薪资，或 API 随数据一并返回的访问令牌。
- **也可以定义整个输出。** `select` 模板指定保留哪些字段以及它们的输出名称；模板无法表达的数据重组可以使用 JMESPath 表达式。如果保留稳定的结构更适合智能体，可以用占位符替换值（`"iban": "= [redacted]"`），而不是直接删除字段。
- **保存之前先查看效果。** 编辑器会对真实响应执行映射，将处理前后结果和大小差异并排显示。某个随附适配器对包含四趟列车的结果进行处理时，测得 **12,172 B → 1,072 B（减少 91%）**。
- **默认采用失败放行行为，并明确说明这一点。** 如果映射在运行时出错，系统会返回原始响应并记录警告，以免一个错误表达式让原本正常工作的工具不可用。但对于绝不能外传的字段，这个默认行为并不合适：请在相应工具上设置 **`"fallbackToRaw": false`**，使映射出错时调用失败，而不是放行原始数据。

这样既能避免敏感字段到达模型，也能减少上下文窗口中需要付费处理的内容。

```json
{
  "transform": {
    "mode": "select",
    "fallbackToRaw": false,
    "exclude": ["customer.iban", "customer.taxId"],
    "select": { "order": "$.id", "total": "$.amounts.gross", "status": "$.state" }
  }
}
```

> 审计日志仍会将完整的上游响应保存在你自己的数据库中。调整智能体可以看到的内容，不会导致你失去 API 实际返回内容的证据。

➡️ **[响应映射参考 →](docs/tool-definition.md#3-response-mapping-optional)**

---

## 无需代码，创建自定义 Claude 连接器

Claude 支持**自定义连接器**：在 *Settings → Connectors* 中添加一次远程 MCP 服务器，即可在 Claude.ai、Claude Desktop 和 Claude Code 中使用。AnythingMCP 可以**从你已有的任意 API 创建这样的连接器**，无需编写 MCP 服务器：

1. 导入 API 规范，或选择一个预置适配器。
2. 在**可视化编辑器**中调整工具名称、描述和参数，由你决定 AI 能够看到的内容。
3. 将 MCP 服务器的 URL 添加为 Claude 的自定义连接器（开箱即支持 OAuth 2.0）。

凭据保留在你的基础设施上，每次工具调用都会记录到审计日志中，基于角色的访问控制则决定哪些用户可以看到哪些工具。[分步指南 →](docs/integrations/claude.md)

---

## 将 API 变成 ChatGPT 应用

**ChatGPT 中的应用基于 MCP 构建**，AnythingMCP 可以直接提供所需的 MCP 后端。将其指向 REST、SOAP、GraphQL 或数据库端点，即可获得适用于 ChatGPT 的连接器。你可以在 ChatGPT 设置中添加它，或将其作为 Apps SDK 应用的工具层，让 ChatGPT 读取业务数据并执行相应操作。

同一个连接器可以同时用于 **Claude、ChatGPT、Gemini、Copilot 和 Cursor**，一次构建，即可在多处连接。[ChatGPT 设置指南 →](docs/integrations/chatgpt.md)

---

## 为什么选择 AnythingMCP？

AI 客户端使用 MCP，而你的系统使用 REST、SOAP、GraphQL 和 SQL。为每个系统单独编写和维护 MCP 服务器，同时处理认证、审计和访问控制，每套都可能花费数周。AnythingMCP 就是两者之间的无代码连接层：

| 问题 | 解决方案 |
|---|---|
| 已有 REST API，但 AI 客户端使用 MCP | 通过 OpenAPI / Swagger 导入实现 **REST → MCP** 转换 |
| 存在旧的 SOAP / WSDL 服务 | 通过自动 WSDL 解析实现 **SOAP → MCP** 桥接 |
| 需要通过 AI 智能体查询数据库 | 自动生成查询工具，实现 **DB → MCP**（7 种引擎） |
| 希望用一个端点访问所有 API | 聚合多个连接器的 **MCP 中间件** |
| 需要 Deutsche Bahn / DHL / weclapp 等服务的 MCP 服务器 | 使用**适配器目录**，一分钟内完成安装并配置凭据 |
| 无法将凭据交给第三方 | **运行在你自己的基础设施上**，凭据以 AES-256-GCM 加密存储 |
| 需要认证、审计日志和 RBAC | 内置 **OAuth2、审计日志和基于角色的访问控制**，无需自行实现 |
| 第三方模型会看到 API 响应中的所有字段 | 使用**[每个工具独立的响应映射](#control-what-the-model-sees)**，在字段离开网络前将其删除或重组 |
| 智能体以错误顺序调用工具，或无法理解两个系统之间的关系 | **[知识图谱与 AI 技能](#knowledge-graph--ai-skills)** 提供调用链提示和学到的业务规则，作为上下文交给智能体 |

**人们实际用它做什么**

| | 指南 |
|---|---|
| 查询列车、实时晚点信息和路线 | [Deutsche Bahn](https://anythingmcp.com/guides/deutsche-bahn-to-mcp) |
| 通过 Claude 与 ERP 交互 | [weclapp](https://anythingmcp.com/guides/weclapp-to-mcp) · [Xentral](https://anythingmcp.com/guides/xentral-to-mcp) |
| 追踪包裹 | [DHL](https://anythingmcp.com/guides/dhl-tracking-to-mcp) · [GLS](https://anythingmcp.com/guides/gls-tracking-to-mcp) |
| 付款前核验发票 | [VIES VAT](https://anythingmcp.com/guides/vies-vat-to-mcp) · [Handelsregister](https://anythingmcp.com/guides/handelsregister-to-mcp) |
| 让智能体以只读方式访问生产数据库 | [数据库连接器](docs/connectors/database.md) |
| 将 2009 年的 SOAP 服务连接到 2026 年的模型 | [SOAP → MCP](https://anythingmcp.com/guides/soap-to-mcp) |

---

<a id="the-adapter-catalog"></a>

## 适配器目录

259 个适配器，提供 1,800 多个工具。**其中 20 个不需要 API 密钥**，其余适配器会在导入时要求提供凭据，导入后工具即可立即使用。每个适配器都在 [anythingmcp.com/guides](https://anythingmcp.com/guides) 上提供七种语言的设置指南。

| 分类 | 示例 |
|---|---|
| 📦 物流与配送 | Deutsche Bahn、DHL、DPD、GLS、Shipcloud、Sendcloud |
| 💼 ERP、会计与开票 | weclapp、Xentral、DATEV、Scopevisio、Billomat、FastBill |
| 🛍️ 电子商务 | Amazon Seller、Etsy、Shopware 6、WooCommerce、Mercado Libre 🌎、Oxomi |
| 👥 人力资源与现场服务 | Personio、HRWorks、Kenjo、MFR Mobile Field Report |
| 🏛️ 政务与公开数据 | VIES VAT、Handelsregister、UK Companies House 🇬🇧、DESTATIS、Bundesbank、OpenPLZ、NINA |
| 🏦 银行与支付 | N26、Wise 🇬🇧、PAYONE、Razorpay 🇮🇳、Paystack 🇳🇬 |
| 💬 消息与通信 | WhatsApp、LINE 🇯🇵、TeamViewer |
| 🎾 体育与 Web3 | Playtomic、Sorare |
| 🏗️ 建筑与地图 | PlanRadar、HERE Geocoding |

**一个适配器就是一个 JSON 文件。** 这既解释了目录为何能够达到现在的规模，也意味着添加适配器很适合作为首次贡献。如果缺少你需要的适配器，可以[提出请求](https://github.com/HelpCode-ai/anythingmcp/issues/new?template=adapter_request.yml)，我们会根据 👍 数量安排优先级；也可以[自己构建](CONTRIBUTING.md)。

---

## 指南、客户端设置与常见问题

➡️ **[docs/guides.md](docs/guides.md)** — Claude / ChatGPT / Gemini / Copilot / Cursor 设置 · REST / SOAP / GraphQL / 数据库 / MCP 桥接连接器指南 · API 参考与部署文档 · 常见问题。

在寻找某个具体服务？每个适配器都在 **[anythingmcp.com/guides](https://anythingmcp.com/guides)** 上提供分步指南。

## 社区与支持

- 💬 **问题与讨论** — [GitHub Discussions](https://github.com/HelpCode-ai/anythingmcp/discussions)，为下一个适配器投票，分享你构建的内容。
- 🐛 **缺陷 / 💡 功能建议** — [Issues](https://github.com/HelpCode-ai/anythingmcp/issues) · 🆘 [SUPPORT.md](SUPPORT.md)
- 🔐 **安全问题** — 请勿创建公开 Issue，请遵循 [SECURITY.md](SECURITY.md)。
- 🏢 由德国弗赖堡的 [helpcode.ai](https://helpcode.ai) 开发。开发过程采用 AI 辅助，并由人工审查；[AUTHORS.md](AUTHORS.md) 说明了涉及哪些部分以及具体做法。

## 参与贡献

创建 PR 前请先阅读[贡献指南](CONTRIBUTING.md)。最容易上手且有实际价值的贡献是适配器：只需要一个 JSON 文件。你可以参考对应的[分步指导 Issue](https://github.com/HelpCode-ai/anythingmcp/issues/150)。

## License

**Open source** under the [GNU Affero General Public License v3](LICENSE) (AGPL-3.0-only). Commercial use inside your own company is included and always was; the copyleft obligation only starts if you modify AnythingMCP and offer the modified version to others over a network. Cloud-operator code under `ee/` is separately licensed and is not required for self-hosting — see the [License FAQ](docs/license-faq.md).


---

<p align="center">
  <strong>⭐ 如果这个项目帮你省下了一周编写 MCP 服务器的时间，请给它一个 Star。</strong><br/>
  <em>Star 帮助更多人发现项目，也帮助我们决定接下来构建哪个适配器。</em>
</p>

<p align="center">
  <a href="https://star-history.com/#HelpCode-ai/anythingmcp&Date">
    <img src="https://api.star-history.com/svg?repos=HelpCode-ai/anythingmcp&type=Date" alt="Star 历史" width="70%">
  </a>
</p>

<p align="center">
  <a href="https://github.com/HelpCode-ai/anythingmcp/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=HelpCode-ai/anythingmcp" alt="贡献者">
  </a>
</p>
