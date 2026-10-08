<p align="center">
  <img src="https://raw.githubusercontent.com/HelpCode-ai/anythingmcp/badges/banner.ja.png" alt="AnythingMCP は ERP、E コマース、REST、SOAP、SQL の各システムを Claude と ChatGPT 用の MCP ツールに変換します。325 のコネクター、うち 17 は API キー不要。" width="100%" />
</p>

<h1 align="center">AnythingMCP：セルフホスト型 MCP ゲートウェイ</h1>

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
  <strong>AnythingMCP は、オープンソースのセルフホスト型 MCP ゲートウェイです。MCP サーバーを書かずに、REST/OpenAPI、SOAP、GraphQL、OData、SQL のあらゆるシステムを Claude、ChatGPT、Copilot 用の MCP ツールに変換します。</strong><br/>
  SAP、Etsy、weclapp、Amazon Seller などを含む 325 種類の既製アダプターを同梱しており、うち 17 は API キー不要です。
</p>

<p align="center">
  <a href="https://claude.ai/directory/anythingmcp"><img src="https://img.shields.io/badge/Claude-%E5%85%AC%E5%BC%8F%E3%83%87%E3%82%A3%E3%83%AC%E3%82%AF%E3%83%88%E3%83%AA%E6%8E%B2%E8%BC%89-D97757?logo=claude&logoColor=white&labelColor=0b1220" alt="Claude 公式ディレクトリに掲載"></a>
  <a href="https://github.com/HelpCode-ai/anythingmcp/stargazers"><img src="https://img.shields.io/github/stars/HelpCode-ai/anythingmcp?style=flat&logo=github&logoColor=white&color=2563eb&labelColor=0b1220" alt="GitHub Stars"></a>
  <a href="https://github.com/HelpCode-ai/anythingmcp/releases"><img src="https://img.shields.io/github/v/release/HelpCode-ai/anythingmcp?include_prereleases&color=2563eb&labelColor=0b1220" alt="Release"></a>
  <a href="https://github.com/HelpCode-ai/anythingmcp/blob/main/LICENSE"><img src="https://img.shields.io/badge/open%20source-AGPL--3.0-2563eb?labelColor=0b1220" alt="Open source, AGPL-3.0"></a>
  <a href="https://hub.docker.com/r/helpcodeai/anythingmcp"><img src="https://img.shields.io/docker/pulls/helpcodeai/anythingmcp?logo=docker&logoColor=white&color=2563eb&labelColor=0b1220" alt="Docker pulls"></a>
</p>

<p align="center">
  <a href="https://cloud.anythingmcp.com/login?mode=register"><strong>クラウド版を 7 日間無料で試す</strong></a> · <a href="https://claude.ai/directory/anythingmcp">Claude に追加</a> · <a href="#run-it-yourself">自分で動かす</a> · <a href="docs/guides.md">ドキュメント</a> · <a href="https://anythingmcp.com/ja/guides">コネクターガイド</a> · <a href="https://github.com/HelpCode-ai/anythingmcp/discussions">Discussions</a>
</p>

**Claude への 1 つの質問に、Etsy、SAP、物流 API のデータで答えます。**

https://github.com/user-attachments/assets/cc8c9ef3-11cf-4eab-aa4d-98472dc554b3

---

<a id="run-it-yourself"></a>

## 自分で動かす

Docker 24 以上と `openssl` が必要です。macOS では先に Docker Desktop を起動してください。リポジトリのクローンは不要です。

```bash
mkdir anythingmcp && cd anythingmcp
curl -fsSLo docker-compose.yml \
  https://raw.githubusercontent.com/HelpCode-ai/anythingmcp/main/docker-compose.quickstart.yml
printf 'JWT_SECRET=%s\nENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
docker compose up -d
```

<http://localhost:3000> を開いて登録します。**最初のアカウントが管理者になります。** MCP エンドポイントは `http://localhost:4000/mcp`、API ドキュメントは `http://localhost:4000/api/docs` です。

> **生成された `.env` は保管してください。** `ENCRYPTION_KEY` は保存した認証情報の復号に使います。失うと、すべてのコネクターで認証情報を設定し直すことになります。

amd64 ではイメージの取得に約 30 秒、その 24 秒後に API が利用可能になります。イメージは現在 amd64 のみですが、compose ファイルがプラットフォームを固定しているため、Apple Silicon でもエミュレーションで動作します。

クイックスタートは意図的に `127.0.0.1` にのみバインドします。前段で TLS を終端するものがないためです。**他の人やクラウドの AI クライアントからアクセスできるインスタンス**が必要な場合は、リポジトリをクローンして `./setup.sh` を実行してください。ドメインを尋ね、Caddy で証明書を取得し、シークレットを生成して MCP の認証モードを設定します。[デプロイガイド](docs/deployment.md)を参照してください。

<details>
<summary><strong>その他の動かし方：</strong>マネージドクラウド、Railway、DigitalOcean</summary>

<br/>

[**AnythingMCP Cloud**](https://cloud.anythingmcp.com) は同じ AGPL コードを、ドイツ・**フランクフルト**で当社が運用するものです。7 日間の無料トライアルがあります。まずクラウドで自社の API を試し、認証情報を外に出したくなくなった時点で社内に移せます。コネクターはどちらでも同じです。DPA/AVV は [info@helpcode.ai](mailto:info@helpcode.ai) までご依頼ください。SSO と SCIM はセルフホスト版のみです。

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/8-X4WD?referralCode=k30bPV&utm_medium=integration&utm_source=template&utm_campaign=generic)
&nbsp;
[![Install on DigitalOcean](https://www.deploytodo.com/do-btn-blue.svg)](https://marketplace.digitalocean.com/apps/anythingmcp)

</details>

---

<a id="how-it-works"></a>

## 仕組み

1. **コネクターを追加する。** カタログから**アダプター**（SAP、Odoo、DHL などの既製 JSON 定義）をインストールするか、独自の OpenAPI 仕様、WSDL、GraphQL エンドポイント、Postman コレクション、データベースを AnythingMCP に指定します。ワークスペースで設定したものが**コネクター**で、その各操作が MCP ツールになります。
2. **モデルに見せる内容を決める。** ビジュアルエディターでツールの名前と説明を整え、ネットワークの外に出してはいけないフィールドを削除し、どのロールがどのツールを呼び出せるかを決めます。
3. **AI クライアントに URL を 1 つ渡す。** **MCP サーバー**は、Claude、ChatGPT、Copilot、Gemini、Cursor に追加するエンドポイントです。割り当てたコネクターだけを公開します。

---

<a id="connect-any-api-soap-service-or-database"></a>

## あらゆる API、SOAP サービス、データベースを接続する

多くの企業には、まだ MCP サーバーがありません。あるのは REST API、ERP、2009 年の SOAP サービス、そしてデータベースです。そのどれもが MCP ツールになります。

| 接続元 | 得られるもの | ドキュメント |
|---|---|---|
| **OpenAPI / Swagger（REST）** | 仕様を URL でインポートするか貼り付けると、各操作がツールになり、パラメーター、認証、エンドポイントのマッピングが自動で入ります | [REST](docs/connectors/rest.md) · [ガイド](https://anythingmcp.com/ja/guides/rest-api-to-mcp) · [デモ：openapi-to-mcp](https://github.com/HelpCode-ai/openapi-to-mcp) |
| **Postman コレクション、cURL** | フォルダー、認証、ボディモード、`{{variables}}` を引き継ぎ、各リクエストがツールになります | [Postman インポート](docs/connectors/rest.md#from-postman-collection) |
| **SOAP / WSDL** | 各操作がツールになります。エンベロープ、パラメーターの順序、WCF サービスは自動で処理します | [SOAP](docs/connectors/soap.md) · [ガイド](https://anythingmcp.com/ja/guides/soap-to-mcp) · [デモ：soap-to-mcp](https://github.com/HelpCode-ai/soap-to-mcp) |
| **GraphQL** | イントロスペクションでクエリとミューテーションをツールにするか、操作を自分で定義します | [GraphQL](docs/connectors/graphql.md) · [ガイド](https://anythingmcp.com/ja/guides/graphql-to-mcp) |
| **OData**（SAP Gateway を含む） | 各サービスの `$metadata` を読み取り、エンティティセット、キー、SAP の業務ラベルをモデルに見せます。V2 と V4 に対応 | [OData](docs/connectors/odata.md) · [ガイド](https://anythingmcp.com/ja/guides/odata-to-mcp) |
| **SQL と MongoDB** | PostgreSQL、MySQL、MariaDB、SQL Server、Oracle、SAP HANA、SQLite、MongoDB：スキーマ、サンプル、クエリの各ツール。既定で読み取り専用 | [データベース](docs/connectors/database.md) · [SAP HANA](docs/connectors/sap-hana.md) · [ガイド](https://anythingmcp.com/ja/guides/database-to-mcp) · [デモ：sql-to-mcp](https://github.com/HelpCode-ai/sql-to-mcp) |
| **別の MCP サーバー** | そのツールを検出し、同じ認証と監査のもとで自社のツールと並べて提供します | [MCP ブリッジ](docs/connectors/mcp-bridge.md) |

ツールは実行時に登録され、再起動は不要です。コネクターごとの `{{VAR}}` の値はサーバー側で埋め込まれ、AI には見えません。

---

<a id="connector-catalog"></a>

## コネクターカタログ

325 個のアダプターで 2,400 以上のツールを提供しています。どのアダプターにも [anythingmcp.com/ja/guides](https://anythingmcp.com/ja/guides) に 7 言語の設定ガイドがあります。

| カテゴリー | 例 |
|---|---|
| 💼 ERP・会計・請求 | SAP Business One、SAP S/4HANA、Odoo、weclapp、Xentral、Dynamics NAV、Lexware Office、sevDesk、Exact Online、bexio |
| 🛍️ E コマース・マーケットプレイス | Amazon Seller、WooCommerce、Shopware 6、Magento、eBay、Etsy、Kaufland、OTTO、Oxomi |
| 📦 物流・配送 | Deutsche Bahn、DHL、DPD、GLS、Shipcloud、Sendcloud |
| 👥 人事・フィールドサービス | Personio、HRWorks、Kenjo、MFR Mobile Field Report |
| 🏛️ 行政・公開データ | VIES VAT、Handelsregister、UK Companies House、DESTATIS、Bundesbank、OpenPLZ、NINA |
| 🏦 銀行・決済 | Revolut Business、Wise、PAYONE、Razorpay、Paystack |
| 💬 メッセージング | WhatsApp、LINE、TeamViewer |
| 📈 広告・分析 | Google Ads、Google Analytics 4、Google Search Console、Matomo |
| 🧠 AI 判定モデル | TypeSafe の Jev：Yes/No 判定、分類、確率付きスコアリングを約 300 ミリ秒で |

<a id="erp-connectors"></a>
<details>
<summary><strong>ERP コネクター</strong>：18 システム、ツール数と対象市場</summary>

<br/>

| システム | 市場 | ツール数 | AI ができること |
|---|---|---|---|
| [SAP Business One](https://anythingmcp.com/ja/guides/connect-sap-business-one-to-claude) | グローバル | 12 | 取引先、品目、注文、請求書、見積、納品。受注の作成 |
| [SAP S/4HANA Cloud](https://anythingmcp.com/ja/guides/connect-sap-s4hana-cloud-to-claude) | グローバル | 15 | 取引先、受注と発注、請求伝票、出荷、仕訳 |
| [SAP S/4HANA (HANA SQL)](https://anythingmcp.com/guides/connect-sap-hana-to-claude) | グローバル | 10 | オンプレミスと Private Cloud の S/4HANA を HANA から直接読み取り、SAP のデータディクショナリと CDS ビューをツールとして提供。読み取り専用 |
| [SAP S/4HANA (OData)](https://anythingmcp.com/guides/odata-to-mcp) † | グローバル | 7 | SAP のラベル付きの Gateway OData サービス: 仕訳明細、請求伝票、受注、取引先、在庫、品目 |
| [Odoo](https://anythingmcp.com/ja/guides/connect-odoo-to-claude) | グローバル | 11 | 任意のモデル（取引先、受注、請求書、製品）。作成と更新 |
| [Microsoft Dynamics NAV](https://anythingmcp.com/ja/guides/connect-dynamics-nav-to-claude) | グローバル | 6 | 公開済みの任意の OData ページ（顧客、品目、受注）。作成と更新 |
| [ERPNext](https://anythingmcp.com/ja/guides/connect-erpnext-to-claude) | グローバル | 11 | 任意の DocType（顧客、受注、請求書、品目、在庫） |
| [Dolibarr](https://anythingmcp.com/ja/guides/connect-dolibarr-to-claude) | グローバル | 10 | 取引先、請求書、注文、提案書、製品、在庫 |
| [JTL-Wawi](https://anythingmcp.com/ja/guides/connect-jtl-wawi-to-claude) † | ドイツ | 9 | 品目、倉庫ごとの在庫、顧客、受注、出荷 |
| [Xentral](https://anythingmcp.com/ja/guides/connect-xentral-to-claude) | ドイツ | 7 | 品目、顧客、受注、請求書、在庫 |
| [weclapp](https://anythingmcp.com/ja/guides/connect-weclapp-to-claude) | DACH | 11 | 顧客、受注、請求書、品目、見積、商談 |
| [Sage 100](https://anythingmcp.com/ja/guides/connect-sage-100-to-claude) † | ドイツ | 6 | 住所、品目、販売伝票、任意の Web API エンティティ |
| [Haufe X360](https://anythingmcp.com/ja/guides/connect-haufe-x360-to-claude) † | ドイツ | 7 | 顧客、在庫品目、受注、請求書、出荷 |
| [ScopeVisio](https://anythingmcp.com/ja/guides/connect-scopevisio-to-claude) | ドイツ | 6 | 連絡先、請求書、プロジェクト、タスク |
| [AFAS Profit](https://anythingmcp.com/ja/guides/connect-afas-profit-to-claude) † | オランダ | 6 | 任意の GetConnector（得意先、請求書、従業員） |
| [Zucchetti](https://anythingmcp.com/ja/guides/connect-zucchetti-to-claude) † | イタリア | 6 | マスターデータ（anagrafiche）、伝票、品目 |
| [TeamSystem](https://anythingmcp.com/ja/guides/connect-teamsystem-to-claude) † | イタリア | 6 | 顧客、仕入先、請求書、品目 |
| [Axonaut](https://anythingmcp.com/ja/guides/connect-axonaut-to-claude) † | フランス | 9 | 企業、請求書、見積、経費、製品、プロジェクト |

† ベンダーが公開している API ドキュメントを基に作成しており、実際のテナントではまだ検証していません。これらのシステムをお使いの方からの報告や修正を歓迎します。

**リポジトリ:** [erp-mcp-server](https://github.com/HelpCode-ai/erp-mcp-server) · [weclapp-mcp-server](https://github.com/kochfreiburg/weclapp-mcp-server) · [odoo-mcp-server](https://github.com/keysersoft/odoo-mcp-server) · [sap-mcp-server](https://github.com/HelpCode-ai/sap-mcp-server) · [sap-hana-mcp-server](https://github.com/HelpCode-ai/sap-hana-mcp-server) · [sap-business-one-mcp-server](https://github.com/HelpCode-ai/sap-business-one-mcp-server) · [xentral-mcp-server](https://github.com/kochfreiburg/xentral-mcp-server)

</details>

<a id="e-commerce--marketplace-connectors"></a>
<details>
<summary><strong>E コマース・マーケットプレイスのコネクター</strong>：13 のショップとマーケットプレイス</summary>

<br/>

| システム | 市場 | ツール数 | AI ができること |
|---|---|---|---|
| [Amazon Seller Central](https://anythingmcp.com/ja/guides/connect-amazon-seller-to-claude) | グローバル | 15 | 注文、カタログ、FBA 在庫、出品、手数料、財務イベント、レポート |
| [WooCommerce](https://anythingmcp.com/ja/guides/connect-woocommerce-to-claude) | グローバル | 49 | 商品、バリエーション、在庫、注文、返金、顧客、レポート |
| [Shopware 6](https://anythingmcp.com/ja/guides/connect-shopware-6-to-claude) | DACH | 6 | Store API 経由のストアフロントカタログ（商品、カテゴリー、クロスセル） |
| [Magento 2 / Adobe Commerce](https://anythingmcp.com/ja/guides/connect-magento-to-claude) | グローバル | 12 | 商品、在庫、注文、顧客 |
| [BigCommerce](https://anythingmcp.com/ja/guides/connect-bigcommerce-to-claude) | グローバル | 14 | 商品、バリアント、在庫、注文、顧客 |
| [eBay Sell](https://anythingmcp.com/ja/guides/connect-ebay-sell-to-claude) | グローバル | 10 | 在庫、出品、注文、紛争、価格の更新 |
| [Etsy](https://anythingmcp.com/ja/guides/connect-etsy-to-claude) | グローバル | 9 | 出品、レシート（注文）、レビュー |
| [Ecwid](https://anythingmcp.com/ja/guides/connect-ecwid-to-claude) | グローバル | 10 | 商品、カテゴリー、注文、顧客 |
| [Kaufland Marketplace](https://anythingmcp.com/ja/guides/connect-kaufland-to-claude) | ドイツ | 8 | 注文とユニット、出荷、チケット、ストアフロント |
| [OTTO Market](https://anythingmcp.com/ja/guides/connect-otto-market-to-claude) † | ドイツ | 8 | 注文、商品、返品、在庫と価格の更新 |
| [Zalando Direct Ship](https://anythingmcp.com/ja/guides/connect-zalando-zds-to-claude) † | EU | 7 | 注文、出荷、返品、在庫、価格 |
| [Billbee](https://anythingmcp.com/guides/connect-billbee-to-claude) | DACH | 8 | 注文、商品、顧客、配送業者 |
| [Mercado Libre](https://anythingmcp.com/ja/guides/connect-mercado-libre-to-claude) | 中南米 | 4 | 商品検索、販売者の注文 |

† ベンダーが公開している API ドキュメントを基に作成しており、実際の販売者アカウントではまだ検証していません。

**リポジトリ:** [ecommerce-mcp-server](https://github.com/HelpCode-ai/ecommerce-mcp-server) · [amazon-seller-mcp-server](https://github.com/keysersoft/amazon-seller-mcp-server) · [billbee-mcp-server](https://github.com/kochfreiburg/billbee-mcp-server) · [magento-mcp-server](https://github.com/keysersoft/magento-mcp-server) · [woocommerce-mcp-server](https://github.com/keysersoft/woocommerce-mcp-server) · [shopware-mcp-server](https://github.com/kochfreiburg/shopware-mcp-server) · [kaufland-mcp-server](https://github.com/kochfreiburg/kaufland-mcp-server) · [otto-market-mcp-server](https://github.com/kochfreiburg/otto-market-mcp-server)

</details>

**アダプターは 1 つの JSON ファイルです。** だからこそカタログがこの規模になり、新しいアダプターの追加は最初の貢献に向いています。必要なものがない場合は、[リクエスト](https://github.com/HelpCode-ai/anythingmcp/issues/new?template=adapter_request.yml)（👍 の数で優先度を決めます）するか、[自分で作成](.github/CONTRIBUTING.md)してください。お使いの ERP が一覧にない、または独自開発の場合は、その REST API、SOAP サービス、SQL データベースに読み取り専用で直接接続できます。

---

<a id="security-and-governance"></a>

## セキュリティとガバナンス

すべてが自社のインフラ上で動くため、外部に出すデータを自分で決められます。OAuth2、RBAC、SSO、SCIM はセルフホスト版に含まれており、有料プラン専用の機能ではありません。

- **レスポンスマッピング。** ツールごとに、モデルに渡すフィールドを宣言します。顧客の IBAN や従業員の給与を削除したり、残すフィールドだけを指定したりできます。エディターは実際の応答で変換前後を表示します。同梱のあるアダプターは 12,172 B から 1,072 B（−91%）になり、その分のコンテキストウィンドウも節約できます。マッピングが壊れた場合は既定で元の応答を返します。絶対に外に出してはいけないフィールドを持つツールでは `"fallbackToRaw": false` を設定すると、代わりに呼び出しが失敗します。
- **重要な場面では読み取り専用。** すべてのツールに MCP アノテーション（`readOnlyHint`、`destructiveHint`）が付き、操作から自動で導出され、ツールごとに上書きできます。ロール単位のツールのホワイトリストで、読み取りしかできない MCP サーバーを公開できます。ERP ではまずここから始めるのがおすすめです。データベースのクエリツールは単一の SELECT だけを実行し、書き込みや複数文の連結をブロックします。
- **あらゆる認証方式に対応。** OAuth2（PKCE と Client Credentials）、Bearer、API キー、Basic、HMAC リクエスト署名、[LOGIN_TOKEN](docs/connectors/login-token-auth.md)、OAuth 1.0a。認証情報は AES-256-GCM で暗号化して保存します。
- **監査ログ。** すべてのツール呼び出しを、入力、出力、所要時間、ステータスとともに自社のデータベースに記録します。モデルが見ていない上流の完全な応答も含まれます。
- **[SSO](docs/sso.md) と [SCIM](docs/scim-entra-setup.md)。** Entra ID、Google、Okta、Auth0、任意の OIDC プロバイダー。サインインのたびにディレクトリのグループからロールを同期し、ディレクトリで無効化されたユーザーはワークスペースへのアクセスと MCP API キーを同時に失います。

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

[レスポンスマッピングのリファレンス](docs/tool-definition.md#3-response-mapping-optional)

---

<a id="use-it-from-claude-chatgpt-copilot-and-gemini"></a>

## Claude、ChatGPT、Copilot、Gemini から使う

同じ MCP サーバーが MCP 対応のあらゆるクライアントで動くため、コネクターは一度作るだけで済みます。

- **Claude。** *Customize → Connectors* でサーバーの URL を**カスタムコネクター**として追加すると、Claude.ai、Claude Desktop、Claude Code で使えます。OAuth 2.0 に標準対応しています。AnythingMCP Cloud なら [Claude ディレクトリ](https://claude.ai/directory/anythingmcp)からワンクリックで追加することもできます。[Claude の設定](docs/integrations/claude.md)
- **ChatGPT。** ChatGPT のアプリは MCP の上に作られています。ChatGPT の設定でサーバーを追加するか、Apps SDK アプリのツール層として使います。[ChatGPT の設定](docs/integrations/chatgpt.md)
- **Meta Muse。** Muse で *Settings → Connectors → Add custom connector* を開き、サーバーの URL を貼り付けて AnythingMCP にサインインします。[Muse の設定](docs/integrations/muse.md)
- **Copilot、Gemini、Cursor** などの MCP クライアント：[クライアント設定ガイド](docs/guides.md)。

---

<a id="knowledge-graph-and-ai-skills"></a>

## ナレッジグラフと AI スキル

呼び出しを転送するだけでは、難しい部分がエージェントに残ります。次にどのツールを呼ぶべきか、そして自社で言う「未完了の注文」が何を指すのか、です。AnythingMCP はその両方を学習し、追加のツール呼び出しではなくコンテキストとして返します。

- **ナレッジグラフ。** ワークスペースごとに、エンティティ（顧客、注文、製品）とコネクターをまたぐ関係を表したマップです。ツール定義と実際の呼び出しから構築され、手動でも編集できます。保存するのはフィールド名と関係だけで、値は保存しません。各サーバーは `kg_how_to_obtain` ツールでこれを提供するため、エージェントは Shopware の注文から DHL の追跡番号にたどり着く方法を尋ねられます。
- **AI スキル。** 繰り返される使い方を小さなルール（例：「本日の売上には注文ステータス 2、3、4 を含む」）にまとめます。適用、編集、却下はあなたが決め、適用したものはサーバーの指示に組み込まれます。

AI による処理は既定でオフで、お手持ちの OpenAI、OpenRouter、Anthropic のキーを使います。グラフ、エディター、MCP ツールはキーなしでも動きます。[ナレッジグラフのガイド](docs/knowledge-graph.md)

---

<a id="where-it-fits"></a>

## 位置づけ

多くの MCP ゲートウェイは、既存の MCP サーバーを束ねて保護するものです。AnythingMCP はその一歩手前から始めます。すでに運用している API、ERP、データベースから MCP サーバーを生成し、権限管理と監査を備えた 1 つのエンドポイントで提供します。ツールがすでに MCP サーバーで、束ねるだけでよいなら、純粋なゲートウェイで十分かもしれません。詳しい比較：[anythingmcp.com/ja/vs](https://anythingmcp.com/ja/vs)。

---

<a id="faq"></a>

## よくある質問（FAQ）

### MCP ゲートウェイとは何ですか？
多数のツールの前に置く単一の MCP エンドポイントで、認証、アクセス制御、監査をまとめて担います。Claude や ChatGPT などの AI クライアントは、各システムではなくゲートウェイに接続します。AnythingMCP は、独自の MCP サーバーを持たない API やデータベースからツールを生成する機能も備えたゲートウェイです。

### ERP（SAP、Odoo、Xentral など）を Claude や ChatGPT に接続するには？
[カタログ](#connector-catalog)から ERP のアダプターをインストールし、API の認証情報を入力して、MCP サーバーの URL を Claude にはカスタムコネクターとして、ChatGPT にはアプリとして追加します。アダプターがない場合は、REST API、SOAP API、SQL データベースに直接接続します。まずは読み取り専用のロールから始めてください。

### OpenAPI 仕様を MCP サーバーにするには？
REST コネクターを作成し、仕様を URL か貼り付けでインポートします。各操作がサーバーの `/mcp` エンドポイント上の MCP ツールになり、コードは不要です。[仕組み](docs/connectors/rest.md#from-openapi--swagger)

### SOAP/WSDL サービスを Claude に接続できますか？
はい。AnythingMCP は WSDL を解析して各操作をツールにし、呼び出しのたびに SOAP エンベロープを組み立てます。WCF サービスにも対応しています。認証は HTTP Basic、Bearer、API キーヘッダー、WS-Security UsernameToken です。署名付きの WS-Security メッセージにはまだ対応していません。[SOAP コネクターのドキュメント](docs/connectors/soap.md)

### Claude で SQL Server、Oracle、PostgreSQL を安全にクエリできますか？
クエリツールは既定で読み取り専用です。加えて、SELECT 権限だけを持つデータベースユーザーを使い、モデルがパラメーターだけを渡す静的クエリを優先し、ロールごとにツールをホワイトリスト化してください。レスポンスマッピングでモデルに渡してはいけない列を削除でき、すべてのクエリが監査ログに記録されます。

### Shopware、WooCommerce、Amazon Seller Central を Claude に接続するには？
お使いのショップやマーケットプレイスの [E コマースアダプター](#e-commerce--marketplace-connectors)をインストールして認可します。WooCommerce には 49 のツールがあり、Amazon Seller Central は公式の Selling Partner API を使い、Shopware 6 アダプターは Store API でストアフロントのカタログを読み取ります。

---

## コミュニティとサポート

**[KOCH Freiburg GmbH](https://www.kochfreiburg.de/) で本番稼働しています。** 同社では AI アシスタントを ERP、CRM、SOAP サービス、オンプレミスのデータベースなど、15 以上の社内システムに接続しています。[helpcode.ai](https://helpcode.ai) がこのシステムから切り出してオープンソース化しました。アダプターカタログは、単一の製品としてよりもコミュニティで育てるほうが速く成長するからです。

- 💬 **質問とアイデア：**[GitHub Discussions](https://github.com/HelpCode-ai/anythingmcp/discussions)。次のアダプターに投票したり、作ったものを共有したりできます。
- 🐛 **バグと機能要望：**[Issues](https://github.com/HelpCode-ai/anythingmcp/issues) · [サポート](.github/SUPPORT.md)
- 👥 **導入事例：**[本番環境で AnythingMCP を使っている組織](docs/ADOPTERS.md)と、掲載の方法
- 🔐 **セキュリティ：**公開の issue は作成せず、[セキュリティポリシー](.github/SECURITY.md)に従ってください
- 🤖 **AI エージェントとクローラー向け：**[anythingmcp.com/llms.txt](https://anythingmcp.com/llms.txt)
- 🏢 ドイツ・フライブルクの [helpcode.ai](https://helpcode.ai) が開発しています。AI 支援で開発し、人がレビューしています。どの部分をどのように、は [AUTHORS.md](docs/AUTHORS.md) に記載しています。

## 貢献する

PR を送る前に[コントリビューションガイド](.github/CONTRIBUTING.md)をお読みください。いちばん手軽で役に立つ貢献はアダプターです。JSON ファイル 1 つで済み、[手順を説明した issue](https://github.com/HelpCode-ai/anythingmcp/issues/150) もあります。

## License

[GNU Affero General Public License v3](LICENSE)（AGPL-3.0-only）のもとで**オープンソース**です。自社内での商用利用は当初から認められています。コピーレフトの義務が生じるのは、AnythingMCP を改変し、その改変版をネットワーク経由で他者に提供する場合だけです。`ee/` 配下のクラウド運用者向けコードは別ライセンスで、セルフホストには不要です。[ライセンス FAQ](docs/license-faq.md) を参照してください。

---

<p align="center">
  <strong>⭐ MCP サーバーを書く 1 週間を節約できたなら、Star をお願いします。</strong><br/>
  <em>Star は次の人がこのプロジェクトを見つける手がかりになり、次にどのアダプターを作るかを決める材料にもなります。</em>
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
