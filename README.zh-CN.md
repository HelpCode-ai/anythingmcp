<p align="center">
  <img src="https://raw.githubusercontent.com/HelpCode-ai/anythingmcp/badges/banner.zh-CN.png" alt="AnythingMCP 将 ERP、电子商务、REST、SOAP 和 SQL 系统转化为 Claude 和 ChatGPT 可用的 MCP 工具：320 个连接器，其中 17 个无需 API 密钥。" width="100%" />
</p>

<h1 align="center">AnythingMCP：自行托管的 MCP 网关</h1>

<p align="center">
  <a href="https://www.star-history.com/helpcode-ai/anythingmcp">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/badge?repo=HelpCode-ai/anythingmcp&type=trending&theme=dark" />
      <img src="https://api.star-history.com/badge?repo=HelpCode-ai/anythingmcp&type=trending" alt="GitHub Trending Repository of the Day" height="64" />
    </picture>
  </a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.de.md">Deutsch</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <strong>AnythingMCP 是一个开源、可自行托管的 MCP 网关，无需编写 MCP 服务器，即可将任意 REST/OpenAPI、SOAP、GraphQL、OData 或 SQL 系统转化为 Claude、ChatGPT 和 Copilot 可用的 MCP 工具。</strong><br/>
  它自带 320 个现成适配器，涵盖 SAP、Etsy、weclapp 和 Amazon Seller 等，其中 17 个无需 API 密钥。
</p>

<p align="center">
  <a href="https://claude.ai/directory/anythingmcp"><img src="https://img.shields.io/badge/Claude-%E5%AE%98%E6%96%B9%E7%9B%AE%E5%BD%95%E6%94%B6%E5%BD%95-D97757?logo=claude&logoColor=white&labelColor=0b1220" alt="已收录于 Claude 官方目录"></a>
  <a href="https://github.com/HelpCode-ai/anythingmcp/stargazers"><img src="https://img.shields.io/github/stars/HelpCode-ai/anythingmcp?style=flat&logo=github&logoColor=white&color=2563eb&labelColor=0b1220" alt="GitHub Stars"></a>
  <a href="https://github.com/HelpCode-ai/anythingmcp/releases"><img src="https://img.shields.io/github/v/release/HelpCode-ai/anythingmcp?include_prereleases&color=2563eb&labelColor=0b1220" alt="Release"></a>
  <a href="https://github.com/HelpCode-ai/anythingmcp/blob/main/LICENSE"><img src="https://img.shields.io/badge/open%20source-AGPL--3.0-2563eb?labelColor=0b1220" alt="Open source, AGPL-3.0"></a>
  <a href="https://hub.docker.com/r/helpcodeai/anythingmcp"><img src="https://img.shields.io/docker/pulls/helpcodeai/anythingmcp?logo=docker&logoColor=white&color=2563eb&labelColor=0b1220" alt="Docker pulls"></a>
</p>

<p align="center">
  <a href="https://cloud.anythingmcp.com/login?mode=register"><strong>免费试用云版 7 天</strong></a> · <a href="https://claude.ai/directory/anythingmcp">添加到 Claude</a> · <a href="#run-it-yourself">自己运行</a> · <a href="docs/guides.md">文档</a> · <a href="https://anythingmcp.com/zh/guides">连接器指南</a> · <a href="https://github.com/HelpCode-ai/anythingmcp/discussions">Discussions</a>
</p>

**在 Claude 中提一个问题，答案来自 Etsy、SAP 和一个物流 API。**

https://github.com/user-attachments/assets/cc8c9ef3-11cf-4eab-aa4d-98472dc554b3

---

<a id="run-it-yourself"></a>

## 自己运行

需要 Docker 24+ 和 `openssl`；在 macOS 上请先启动 Docker Desktop。无需克隆仓库：

```bash
mkdir anythingmcp && cd anythingmcp
curl -fsSLo docker-compose.yml \
  https://raw.githubusercontent.com/HelpCode-ai/anythingmcp/main/docker-compose.quickstart.yml
printf 'JWT_SECRET=%s\nENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
docker compose up -d
```

打开 <http://localhost:3000> 并注册：**第一个账户会成为管理员**。MCP 端点为 `http://localhost:4000/mcp`，API 文档位于 `http://localhost:4000/api/docs`。

> **请保存生成的 `.env`。** `ENCRYPTION_KEY` 用于解密你存储的凭据。一旦丢失，每个连接器都必须重新填写凭据。

在 amd64 上，镜像拉取约需 30 秒，之后 24 秒 API 即可就绪。镜像目前仅提供 amd64 版本；compose 文件固定了平台，因此在 Apple Silicon 上也能通过模拟运行。

快速启动有意只绑定到 `127.0.0.1`，因为前面没有任何组件终止 TLS。**如果实例需要被其他人或云端 AI 客户端访问**，请克隆仓库并运行 `./setup.sh`：它会询问域名、通过 Caddy 获取证书、生成密钥并设置 MCP 认证模式。参见[部署指南](docs/deployment.md)。

<details>
<summary><strong>其他运行方式：</strong>托管云、Railway、DigitalOcean</summary>

<br/>

[**AnythingMCP Cloud**](https://cloud.anythingmcp.com) 使用同一套 AGPL 代码，由我们在德国**法兰克福**运营，可免费试用 7 天。你可以先在云端用自己的 API 试用，当你希望凭据不再离开内网时再迁回自有环境；连接器完全相同。如需 DPA/AVV，请联系 [info@helpcode.ai](mailto:info@helpcode.ai)。SSO 和 SCIM 仅在自行托管版本中提供。

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/8-X4WD?referralCode=k30bPV&utm_medium=integration&utm_source=template&utm_campaign=generic)
&nbsp;
[![Install on DigitalOcean](https://www.deploytodo.com/do-btn-blue.svg)](https://marketplace.digitalocean.com/apps/anythingmcp)

</details>

---

<a id="how-it-works"></a>

## 工作原理

1. **添加连接器。** 从目录安装一个**适配器**（为 SAP、Odoo、DHL 等准备好的 JSON 定义），或者把你自己的 OpenAPI 规范、WSDL、GraphQL 端点、Postman 集合或数据库交给 AnythingMCP。在工作区中配置完成后，它就是一个**连接器**，其中的每个操作都是一个 MCP 工具。
2. **决定模型能看到什么。** 在可视化编辑器中重命名并描述工具，删除不能离开你网络的字段，并决定哪些角色可以调用哪些工具。
3. **把一个 URL 交给 AI 客户端。** **MCP 服务器**就是你添加到 Claude、ChatGPT、Copilot、Gemini 或 Cursor 中的端点。它只公开分配给它的连接器。

---

<a id="connect-any-api-soap-service-or-database"></a>

## 连接任意 API、SOAP 服务或数据库

大多数公司还没有 MCP 服务器。他们有的是一个 REST API、一套 ERP、一个 2009 年的 SOAP 服务和一个数据库。它们都能变成 MCP 工具：

| 来源 | 你将得到 | 文档 |
|---|---|---|
| **OpenAPI / Swagger（REST）** | 通过 URL 导入或直接粘贴规范；每个操作都会变成一个工具，参数、认证和端点映射已自动填好 | [REST](docs/connectors/rest.md) · [指南](https://anythingmcp.com/zh/guides/rest-api-to-mcp) · [演示：openapi-to-mcp](https://github.com/HelpCode-ai/openapi-to-mcp) |
| **Postman 集合、cURL** | 文件夹、认证、请求体模式和 `{{variables}}` 都会保留；每个请求都会变成一个工具 | [Postman 导入](docs/connectors/rest.md#from-postman-collection) |
| **SOAP / WSDL** | 每个操作变成一个工具；信封、参数顺序和 WCF 服务都会自动处理 | [SOAP](docs/connectors/soap.md) · [指南](https://anythingmcp.com/zh/guides/soap-to-mcp) · [演示：soap-to-mcp](https://github.com/HelpCode-ai/soap-to-mcp) |
| **GraphQL** | 通过内省把查询和变更转化为工具，也可以自行定义操作 | [GraphQL](docs/connectors/graphql.md) · [指南](https://anythingmcp.com/zh/guides/graphql-to-mcp) |
| **OData**（包括 SAP Gateway） | 读取每个服务的 `$metadata`，让模型看到实体集、键和 SAP 的业务标签；支持 V2 和 V4 | [OData](docs/connectors/odata.md) · [指南](https://anythingmcp.com/zh/guides/odata-to-mcp) |
| **SQL 和 MongoDB** | PostgreSQL、MySQL、MariaDB、SQL Server、Oracle、SAP HANA、SQLite 和 MongoDB：结构、示例和查询工具，默认只读 | [数据库](docs/connectors/database.md) · [SAP HANA](docs/connectors/sap-hana.md) · [指南](https://anythingmcp.com/zh/guides/database-to-mcp) · [演示：sql-to-mcp](https://github.com/HelpCode-ai/sql-to-mcp) |
| **另一个 MCP 服务器** | 发现它的工具，并与你自己的工具一起提供，共用同一套认证和审计 | [MCP 桥接](docs/connectors/mcp-bridge.md) |

工具在运行时注册，无需重启。每个连接器的 `{{VAR}}` 值在服务器端替换，不会展示给 AI。

---

<a id="connector-catalog"></a>

## 连接器目录

共 320 个适配器，提供 2,400 多个工具。每个适配器都在 [anythingmcp.com/zh/guides](https://anythingmcp.com/zh/guides) 上提供七种语言的配置指南。

| 类别 | 示例 |
|---|---|
| 💼 ERP、会计与开票 | SAP Business One、SAP S/4HANA、Odoo、weclapp、Xentral、Dynamics NAV、Lexware Office、sevDesk、Exact Online、bexio |
| 🛍️ 电子商务与电商平台 | Amazon Seller、WooCommerce、Shopware 6、Magento、eBay、Etsy、Kaufland、OTTO、Oxomi |
| 📦 物流与运输 | Deutsche Bahn、DHL、DPD、GLS、Shipcloud、Sendcloud |
| 👥 人力资源与现场服务 | Personio、HRWorks、Kenjo、MFR Mobile Field Report |
| 🏛️ 政府与公共数据 | VIES 增值税号、Handelsregister、UK Companies House、DESTATIS、Bundesbank、OpenPLZ、NINA |
| 🏦 银行与支付 | Revolut Business、Wise、PAYONE、Razorpay、Paystack |
| 💬 即时通讯 | WhatsApp、LINE、TeamViewer |
| 📈 广告与分析 | Google Ads、Google Analytics 4、Google Search Console、Matomo |
| 🧠 AI 决策模型 | TypeSafe 的 Jev：是/否判断、分类和带概率的评分，约 300 毫秒 |

<a id="erp-connectors"></a>
<details>
<summary><strong>ERP 连接器</strong>：18 个系统，含工具数和市场</summary>

<br/>

| 系统 | 市场 | 工具数 | AI 可以做什么 |
|---|---|---|---|
| [SAP Business One](https://anythingmcp.com/zh/guides/connect-sap-business-one-to-claude) | 全球 | 12 | 业务伙伴、物料、订单、发票、报价单、交货单；创建销售订单 |
| [SAP S/4HANA Cloud](https://anythingmcp.com/zh/guides/connect-sap-s4hana-cloud-to-claude) | 全球 | 15 | 业务伙伴、销售订单和采购订单、开票凭证、交货单、会计分录 |
| [SAP S/4HANA (HANA SQL)](https://anythingmcp.com/guides/connect-sap-hana-to-claude) | 全球 | 10 | 直接从 HANA 读取本地部署和 Private Cloud 的 S/4HANA，以 SAP 数据字典和 CDS 视图作为工具；只读 |
| [SAP S/4HANA (OData)](https://anythingmcp.com/guides/odata-to-mcp) † | 全球 | 7 | 带 SAP 标签的 Gateway OData 服务：会计分录行、开票凭证、销售订单、业务伙伴、库存、产品 |
| [Odoo](https://anythingmcp.com/zh/guides/connect-odoo-to-claude) | 全球 | 11 | 任意模型：合作伙伴、销售订单、发票、产品；可创建和更新 |
| [Microsoft Dynamics NAV](https://anythingmcp.com/zh/guides/connect-dynamics-nav-to-claude) | 全球 | 6 | 任意已发布的 OData 页面：客户、物料、销售订单；可创建和更新 |
| [ERPNext](https://anythingmcp.com/zh/guides/connect-erpnext-to-claude) | 全球 | 11 | 任意 DocType：客户、销售订单、发票、物料、库存 |
| [Dolibarr](https://anythingmcp.com/zh/guides/connect-dolibarr-to-claude) | 全球 | 10 | 第三方、发票、订单、商业提案、产品、库存 |
| [JTL-Wawi](https://anythingmcp.com/zh/guides/connect-jtl-wawi-to-claude) † | DE | 9 | 商品、各仓库库存、客户、销售订单、发货 |
| [Xentral](https://anythingmcp.com/zh/guides/connect-xentral-to-claude) | DE | 7 | 商品、客户、销售订单、发票、库存 |
| [weclapp](https://anythingmcp.com/zh/guides/connect-weclapp-to-claude) | DACH | 11 | 客户、销售订单、发票、商品、报价单、销售机会 |
| [Sage 100](https://anythingmcp.com/zh/guides/connect-sage-100-to-claude) † | DE | 6 | 地址、物料、销售单据、任意 Web API 实体 |
| [Haufe X360](https://anythingmcp.com/zh/guides/connect-haufe-x360-to-claude) † | DE | 7 | 客户、库存物料、销售订单、发票、发货 |
| [ScopeVisio](https://anythingmcp.com/zh/guides/connect-scopevisio-to-claude) | DE | 6 | 联系人、发票、项目、任务 |
| [AFAS Profit](https://anythingmcp.com/zh/guides/connect-afas-profit-to-claude) † | NL | 6 | 任意 GetConnector：应收客户、发票、员工 |
| [Zucchetti](https://anythingmcp.com/zh/guides/connect-zucchetti-to-claude) † | IT | 6 | 主数据（Anagrafiche）、单据、物料 |
| [TeamSystem](https://anythingmcp.com/zh/guides/connect-teamsystem-to-claude) † | IT | 6 | 客户、供应商、发票、物料 |
| [Axonaut](https://anythingmcp.com/zh/guides/connect-axonaut-to-claude) † | FR | 9 | 公司、发票、报价单、费用、产品、项目 |

† 根据供应商公开的 API 文档构建，尚未在实际运行的租户上测试。如果你正在使用其中某个系统，非常欢迎提交问题反馈或修复。

**代码仓库:** [erp-mcp-server](https://github.com/HelpCode-ai/erp-mcp-server) · [weclapp-mcp-server](https://github.com/kochfreiburg/weclapp-mcp-server) · [odoo-mcp-server](https://github.com/keysersoft/odoo-mcp-server) · [sap-mcp-server](https://github.com/HelpCode-ai/sap-mcp-server) · [sap-hana-mcp-server](https://github.com/HelpCode-ai/sap-hana-mcp-server) · [sap-business-one-mcp-server](https://github.com/HelpCode-ai/sap-business-one-mcp-server) · [xentral-mcp-server](https://github.com/kochfreiburg/xentral-mcp-server)

</details>

<a id="e-commerce--marketplace-connectors"></a>
<details>
<summary><strong>电子商务与电商平台连接器</strong>：13 个商店和平台</summary>

<br/>

| 系统 | 市场 | 工具数 | AI 可以做什么 |
|---|---|---|---|
| [Amazon Seller Central](https://anythingmcp.com/zh/guides/connect-amazon-seller-to-claude) | 全球 | 15 | 订单、商品目录、FBA 库存、报价、费用、财务事件、报表 |
| [WooCommerce](https://anythingmcp.com/zh/guides/connect-woocommerce-to-claude) | 全球 | 49 | 商品、变体、库存、订单、退款、客户、报表 |
| [Shopware 6](https://anythingmcp.com/zh/guides/connect-shopware-6-to-claude) | DACH | 6 | 通过 Store API 读取店面商品目录：商品、分类、交叉销售 |
| [Magento 2 / Adobe Commerce](https://anythingmcp.com/zh/guides/connect-magento-to-claude) | 全球 | 12 | 商品、库存、订单、客户 |
| [BigCommerce](https://anythingmcp.com/zh/guides/connect-bigcommerce-to-claude) | 全球 | 14 | 商品、变体、库存、订单、客户 |
| [eBay Sell](https://anythingmcp.com/zh/guides/connect-ebay-sell-to-claude) | 全球 | 10 | 库存、报价、订单、纠纷、价格更新 |
| [Etsy](https://anythingmcp.com/zh/guides/connect-etsy-to-claude) | 全球 | 9 | 商品刊登、收据（订单）、评价 |
| [Ecwid](https://anythingmcp.com/zh/guides/connect-ecwid-to-claude) | 全球 | 10 | 商品、分类、订单、客户 |
| [Kaufland Marketplace](https://anythingmcp.com/zh/guides/connect-kaufland-to-claude) | DE | 8 | 订单及订单单元、发货、工单、店铺 |
| [OTTO Market](https://anythingmcp.com/zh/guides/connect-otto-market-to-claude) † | DE | 8 | 订单、商品、退货、库存和价格更新 |
| [Zalando Direct Ship](https://anythingmcp.com/zh/guides/connect-zalando-zds-to-claude) † | EU | 7 | 订单、发货、退货、库存、价格 |
| [Billbee](https://anythingmcp.com/guides/connect-billbee-to-claude) | DACH | 8 | 订单、商品、客户、物流服务商 |
| [Mercado Libre](https://anythingmcp.com/zh/guides/connect-mercado-libre-to-claude) | LATAM | 4 | 商品搜索、卖家订单 |

† 根据供应商公开的 API 文档构建，尚未在实际运行的卖家账户上测试。

**代码仓库:** [ecommerce-mcp-server](https://github.com/HelpCode-ai/ecommerce-mcp-server) · [amazon-seller-mcp-server](https://github.com/keysersoft/amazon-seller-mcp-server) · [billbee-mcp-server](https://github.com/kochfreiburg/billbee-mcp-server) · [magento-mcp-server](https://github.com/keysersoft/magento-mcp-server) · [woocommerce-mcp-server](https://github.com/keysersoft/woocommerce-mcp-server) · [shopware-mcp-server](https://github.com/kochfreiburg/shopware-mcp-server) · [kaufland-mcp-server](https://github.com/kochfreiburg/kaufland-mcp-server) · [otto-market-mcp-server](https://github.com/kochfreiburg/otto-market-mcp-server)

</details>

**一个适配器就是一个 JSON 文件。** 这正是目录能有这么大规模的原因，也让新增适配器成为很合适的第一次贡献。没有你需要的？[提出需求](https://github.com/HelpCode-ai/anythingmcp/issues/new?template=adapter_request.yml)（我们按 👍 数排序）或[自己构建](.github/CONTRIBUTING.md)。你的 ERP 不在列表中，或者是定制系统？直接以只读方式连接它的 REST API、SOAP 服务或 SQL 数据库。

---

<a id="security-and-governance"></a>

## 安全与治理

所有组件都运行在你自己的基础设施上，因此由你决定哪些数据可以离开。OAuth2、RBAC、SSO 和 SCIM 已包含在自行托管版本中，并非付费套餐专属功能。

- **响应映射。** 每个工具都声明哪些字段可以到达模型：删除客户的 IBAN 或员工的薪资，或者只列出要保留的字段。编辑器会基于真实响应显示前后对比；某个内置适配器从 12,172 B 减少到 1,072 B（−91%），这些字段也就不再占用上下文窗口。映射出错时默认返回原始响应；对于字段绝不能外传的工具，请设置 `"fallbackToRaw": false`，此时调用会直接失败。
- **关键处只读。** 每个工具都带有 MCP 注解（`readOnlyHint`、`destructiveHint`），由操作自动推断，并可按工具覆盖。基于角色的工具白名单可以发布一个只能读取的 MCP 服务器，大多数人接入 ERP 时都应从这里开始。数据库查询工具只执行单条 SELECT，并阻止写入和堆叠语句。
- **支持你会遇到的各种认证方式。** OAuth2（PKCE 和 Client Credentials）、Bearer、API Key、Basic、HMAC 请求签名、[LOGIN_TOKEN](docs/connectors/login-token-auth.md) 和 OAuth 1.0a。凭据以 AES-256-GCM 加密存储。
- **审计日志。** 每次工具调用都会连同输入、输出、耗时和状态记录在你自己的数据库中，包括模型从未看到的完整上游响应。
- **[SSO](docs/sso.md) 和 [SCIM](docs/scim-entra-setup.md)。** Entra ID、Google、Okta、Auth0 或任意 OIDC 提供方。每次登录时从目录组同步角色；在目录中停用某人后，其工作区访问权限和 MCP API 密钥也会一并失效。

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

[响应映射参考](docs/tool-definition.md#3-response-mapping-optional)

---

<a id="use-it-from-claude-chatgpt-copilot-and-gemini"></a>

## 在 Claude、ChatGPT、Copilot 和 Gemini 中使用

同一个 MCP 服务器适用于所有支持 MCP 的客户端，因此连接器只需构建一次：

- **Claude。** 在 *Customize → Connectors* 中把服务器 URL 添加为**自定义连接器**，即可在 Claude.ai、Claude Desktop 和 Claude Code 中使用。开箱即支持 OAuth 2.0。使用 AnythingMCP Cloud 时，也可以从 [Claude 目录](https://claude.ai/directory/anythingmcp)一键添加。[Claude 配置](docs/integrations/claude.md)
- **ChatGPT。** ChatGPT 中的应用基于 MCP。在 ChatGPT 设置中添加服务器，或将其作为 Apps SDK 应用的工具层。[ChatGPT 配置](docs/integrations/chatgpt.md)
- **Meta Muse。** 在 Muse 中打开 *Settings → Connectors → Add custom connector*，粘贴服务器 URL，然后登录 AnythingMCP。[Muse 配置](docs/integrations/muse.md)
- **Copilot、Gemini、Cursor** 及其他 MCP 客户端：[客户端配置指南](docs/guides.md)。

---

<a id="knowledge-graph-and-ai-skills"></a>

## 知识图谱与 AI 技能

只转发调用，会把最难的部分留给智能体：知道下一步该调用哪个工具，以及你的业务所说的"未完成订单"究竟指什么。AnythingMCP 会学习这两者，并以上下文的形式交还给客户端，而不是增加额外的工具调用。

- **知识图谱。** 每个工作区一张图，记录实体（客户、订单、产品）及其跨连接器的关系，根据工具定义和真实调用构建，也可以手动编辑。它只存储字段名和关系，从不存储值。每个服务器都通过 `kg_how_to_obtain` 工具提供图谱，智能体可以询问如何从一个 Shopware 订单找到 DHL 运单号。
- **AI 技能。** 把反复出现的使用方式变成简短规则（例如"今日营收包含订单状态 2、3 和 4"），由你应用、编辑或拒绝，并写入服务器的指令中。

AI 处理默认关闭，使用你自己的 OpenAI、OpenRouter 或 Anthropic 密钥；图谱、编辑器和 MCP 工具在没有密钥时也能使用。[知识图谱指南](docs/knowledge-graph.md)

---

<a id="where-it-fits"></a>

## 适用场景

大多数 MCP 网关负责聚合和保护你已有的 MCP 服务器。AnythingMCP 往前多走一步：它从你已经在运行的 API、ERP 和数据库生成 MCP 服务器，再通过一个端点统一提供，并带有权限控制和审计。如果你的工具已经是 MCP 服务器，只需要聚合，那么纯网关可能就够了。详细对比：[anythingmcp.com/zh/vs](https://anythingmcp.com/zh/vs)。

---

<a id="faq"></a>

## 常见问题

### 什么是 MCP 网关？
位于多个工具前面的单一 MCP 端点，统一负责认证、访问控制和审计。Claude、ChatGPT 等 AI 客户端连接网关，而不是分别连接每个系统。AnythingMCP 是一种还能自行生成工具的网关，工具来自那些没有自己 MCP 服务器的 API 和数据库。

### 如何把我的 ERP（SAP、Odoo、Xentral……）连接到 Claude 或 ChatGPT？
从[目录](#connector-catalog)安装对应 ERP 的适配器，填写 API 凭据，然后把 MCP 服务器 URL 作为自定义连接器添加到 Claude，或作为应用添加到 ChatGPT。如果没有对应适配器，可以直接连接它的 REST 或 SOAP API，或 SQL 数据库。建议先从只读角色开始。

### 如何把 OpenAPI 规范变成 MCP 服务器？
创建一个 REST 连接器，通过 URL 或粘贴方式导入规范。每个操作都会成为服务器 `/mcp` 端点上的一个 MCP 工具，无需编写代码。[工作原理](docs/connectors/rest.md#from-openapi--swagger)

### 能把 SOAP/WSDL 服务连接到 Claude 吗？
可以。AnythingMCP 解析 WSDL，把每个操作变成工具，并在每次调用时构建 SOAP 信封，也支持 WCF 服务。认证方式为 HTTP Basic、Bearer 或 API Key 请求头；WS-Security 头尚未实现。[SOAP 连接器文档](docs/connectors/soap.md)

### Claude 能安全地查询我的 SQL Server、Oracle 或 PostgreSQL 数据库吗？
查询工具默认只读。此外，请使用仅有 SELECT 权限的数据库用户，优先使用由模型只提供参数的静态查询，并按角色设置工具白名单。响应映射会删除不能到达模型的列，每次查询都会记录在你的审计日志中。

### 如何把 Shopware、WooCommerce 或 Amazon Seller Central 连接到 Claude？
为你的商店或平台安装对应的[电子商务适配器](#e-commerce--marketplace-connectors)并完成授权。WooCommerce 提供 49 个工具，Amazon Seller Central 使用官方 Selling Partner API，Shopware 6 适配器通过 Store API 读取店面目录。

---

## 社区与支持

**[KOCH Freiburg GmbH](https://www.kochfreiburg.de/) 已在生产环境使用 AnythingMCP**，将 AI 助手连接到 15 个以上的内部系统，包括 ERP、CRM、SOAP 服务和本地数据库。[helpcode.ai](https://helpcode.ai) 将它从该系统中提取出来并开源，因为适配器目录由社区共同建设，比作为单一产品发展得更快。

- 💬 **问题与想法：**[GitHub Discussions](https://github.com/HelpCode-ai/anythingmcp/discussions)。为下一个适配器投票，分享你的成果。
- 🐛 **缺陷与功能请求：**[Issues](https://github.com/HelpCode-ai/anythingmcp/issues) · [支持](.github/SUPPORT.md)
- 👥 **用户：**[哪些团队在生产环境中使用 AnythingMCP](docs/ADOPTERS.md)，以及如何添加你自己
- 🔐 **安全：**请不要公开提交 issue，请遵循[安全策略](.github/SECURITY.md)
- 🤖 **面向 AI 智能体和爬虫：**[anythingmcp.com/llms.txt](https://anythingmcp.com/llms.txt)
- 🏢 由德国弗赖堡的 [helpcode.ai](https://helpcode.ai) 开发。AI 辅助开发，人工审核：[AUTHORS.md](docs/AUTHORS.md) 说明了哪些部分以及如何进行。

## 参与贡献

提交 PR 前请阅读[贡献指南](.github/CONTRIBUTING.md)。最简单也最有用的贡献是一个适配器：只需一个 JSON 文件，并且有一个[分步说明 issue](https://github.com/HelpCode-ai/anythingmcp/issues/150)。

## License

基于 [GNU Affero General Public License v3](LICENSE)（AGPL-3.0-only）**开源**。在你自己公司内部的商业使用始终包含在内；只有当你修改 AnythingMCP 并通过网络向他人提供修改后的版本时，才会产生 copyleft 义务。`ee/` 下面向云运营方的代码采用单独许可，自行托管时并不需要；参见[许可证 FAQ](docs/license-faq.md)。

---

<p align="center">
  <strong>⭐ 如果它帮你省下了一周编写 MCP 服务器的时间，请给个 Star。</strong><br/>
  <em>Star 能让下一个人找到它，也帮助我们决定下一个要构建的适配器。</em>
</p>

<p align="center">
  <a href="https://star-history.com/#HelpCode-ai/anythingmcp&Date">
    <img src="https://api.star-history.com/svg?repos=HelpCode-ai/anythingmcp&type=Date" alt="Star history" width="70%">
  </a>
</p>

<p align="center">
  <a href="https://github.com/HelpCode-ai/anythingmcp/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=HelpCode-ai/anythingmcp" alt="Contributors">
  </a>
</p>
