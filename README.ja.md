<p align="center">
  <img src="docs/assets/banner.png" alt="AnythingMCP は ERP、E コマース、REST、SOAP、SQL の各システムを Claude と ChatGPT 用の MCP ツールに変換します。258 のコネクター、うち 21 は API キー不要。" width="100%" />
</p>

<h1 align="center">AnythingMCP</h1>

<p align="center">
  <a href="README.md">English</a> · <a href="README.de.md">Deutsch</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <strong>REST/OpenAPI、SOAP、GraphQL、SQL のあらゆる API を、Claude、ChatGPT、Copilot 用の MCP ツールに変換します。</strong><br/>
  コード不要のセルフホスト型 MCP サーバー兼ゲートウェイです。SAP Business One、Odoo、Xentral、weclapp、Shopware、WooCommerce、Amazon Seller、Kaufland など、ERP や E コマースを含む 258 種類の既製アダプターを用意しています。
</p>

<p align="center">
  <a href="https://github.com/HelpCode-ai/anythingmcp/stargazers"><img src="https://img.shields.io/github/stars/HelpCode-ai/anythingmcp?style=flat&logo=github&logoColor=white&color=2563eb&labelColor=0b1220" alt="GitHub Stars"></a>
  <a href="https://github.com/HelpCode-ai/anythingmcp/releases"><img src="https://img.shields.io/github/v/release/HelpCode-ai/anythingmcp?include_prereleases&color=2563eb&labelColor=0b1220" alt="Release"></a>
  <a href="https://github.com/HelpCode-ai/anythingmcp/blob/main/LICENSE"><img src="https://img.shields.io/badge/open%20source-AGPL--3.0-2563eb?labelColor=0b1220" alt="Open source, AGPL-3.0"></a>
  <a href="https://hub.docker.com/r/helpcodeai/anythingmcp"><img src="https://img.shields.io/docker/pulls/helpcodeai/anythingmcp?logo=docker&logoColor=white&color=2563eb&labelColor=0b1220" alt="Docker pulls"></a>
</p>

**これまでチャットボットでは答えられなかった質問に、Claude が回答します。** 必要なデータが、MCP ではなく REST を使うフィールドサービスシステムに保存されている場合でも対応できます。

<p align="center">
  <img src="docs/assets/demo-claude.gif" alt="Claude で動く AnythingMCP：技術者が先週訪問した会社を尋ねられた Claude が、フィールドサービスの REST API から AnythingMCP が生成した MCP ツールを呼び出している様子。" width="100%" />
</p>

**自分で動かす** — 3 行のコマンドで、リポジトリのクローンは不要です。[詳しい手順はこちら](#run-it-yourself)。

```bash
mkdir anythingmcp && cd anythingmcp
curl -fsSLo docker-compose.yml \
  https://raw.githubusercontent.com/HelpCode-ai/anythingmcp/main/docker-compose.quickstart.yml
printf 'JWT_SECRET=%s\nENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
docker compose up -d   # → http://localhost:3000
```

---

この文書で繰り返し使う 3 つの用語は、それぞれ異なるものを指します。

- **アダプター（adapter）**は、このリポジトリに含まれる 258 個の JSON 定義のいずれかです。SAP Business One、Odoo、weclapp、Xentral、Shopware、WooCommerce、Amazon Seller、DHL などがあります。そのうち 21 個は API キーを一切必要とせず、それ以外はインポート時に認証情報を設定します。
- **コネクター（connector）**は、アダプター、または独自の OpenAPI 仕様・Postman コレクション・WSDL・GraphQL エンドポイント・データベースを、ワークスペース内で設定したものです。接続先を指定すれば、MCP サーバーを書くことなく数分で設定できます。
- **MCP サーバー**は、Claude に渡す URL です。そのサーバーに割り当てたコネクターだけを公開します。

すべてが自社のインフラ上で動くため、外部へ出すデータを自分で決められます。ツールごとのレスポンスマッピングで、モデルに渡せるフィールドを定義できます。認証情報は AES-256-GCM で暗号化して保存し、監査ログには上流システムの完全な応答を自社側で保持します。OAuth2、RBAC、SSO、SCIM はセルフホスト版に含まれており、有料プラン専用の機能ではありません。

**[KOCH Freiburg GmbH](https://www.kochfreiburg.de/) で本番稼働しています。** 同社では AI アシスタントを ERP、CRM、SOAP サービス、オンプレミスのデータベースなど、15 以上の社内システムに接続しています。ドイツ・フライブルクの [helpcode.ai](https://helpcode.ai) がこのシステムから AnythingMCP を切り出し、オープンソースとして公開しました。アダプターカタログは、単一の製品としてよりも、コミュニティで育てるほうが速く成長するからです。

---

<a id="run-it-yourself"></a>

## 自分で動かす

**以下が推奨の方法です。** 後述の計測もこの方法で行っています。Docker 24+ と `openssl` が必要です。macOS では、先に Docker Desktop を起動してください。

```bash
mkdir anythingmcp && cd anythingmcp
curl -fsSLo docker-compose.yml \
  https://raw.githubusercontent.com/HelpCode-ai/anythingmcp/main/docker-compose.quickstart.yml
printf 'JWT_SECRET=%s\nENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
docker compose up -d
```

<http://localhost:3000> を開いて登録します。**最初のアカウントが管理者になります。**

> **生成された `.env` を保管してください。** 保存した認証情報を復号するには `ENCRYPTION_KEY` が必要です。紛失すると、すべてのコネクターの認証情報を再設定しなければなりません。他のシークレットと同じようにバックアップしてください。

| サービス | 既定の URL |
|---|---|
| Web UI | `http://localhost:3000` |
| MCP エンドポイント | `http://localhost:4000/mcp` |
| Swagger ドキュメント | `http://localhost:4000/api/docs` |

*amd64 での計測結果：イメージの取得に 31 秒、API が正常に動作してログインページが表示されるまでに 24 秒。現在、公開イメージは amd64 のみをサポートしています。Compose ファイルでプラットフォームを明示しているため、Apple Silicon でも Docker Desktop のエミュレーションを使って実行できます。M シリーズ搭載ノートパソコンでは同じ起動に 24 秒かかりましたが、古いハードウェアでは数分かかる場合があります。*

クイックスタートでは、意図的に `127.0.0.1` にバインドしています。前段に TLS を終端する仕組みがまだないためです。**他の人やクラウドの AI クライアントからアクセスできるインスタンスが必要な場合**は、リポジトリをクローンして `./setup.sh` を実行してください。ドメインを入力すると、Caddy による証明書の取得、シークレットの生成、MCP 認証モードの設定を行います。[デプロイガイド](docs/deployment.md)を参照してください。

<details>
<summary><strong>その他のデプロイ方法</strong> — マネージドクラウド、Railway、DigitalOcean</summary>

<br/>

[**AnythingMCP Cloud**](https://cloud.anythingmcp.com) は同じ AGPL コードを使い、私たちが**ドイツ・フランクフルト**で運用しています。インフラを用意せずに自社の API で試し、認証情報を社内に置きたくなったらセルフホストへ移行できます。どちらでも使うコネクターは同じです。DPA/AVV は [info@helpcode.ai](mailto:info@helpcode.ai) へのご依頼に応じて提供します。SSO と SCIM はセルフホスト版でのみ利用できます。

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/8-X4WD?referralCode=k30bPV&utm_medium=integration&utm_source=template&utm_campaign=generic)
&nbsp;
[![Install on DigitalOcean](https://www.deploytodo.com/do-btn-blue.svg)](https://marketplace.digitalocean.com/apps/anythingmcp)

</details>

---

<a id="connect-any-system"></a>

## あらゆるシステムを接続する

多くの企業には、まだ MCP サーバーがありません。あるのは REST API、ERP、SOAP サービス、データベースです。そのそれぞれが一連の MCP ツールになり、1 つの MCP サーバー URL を通じて Claude、ChatGPT、Copilot に渡されます。

<a id="openapi--rest-api-to-mcp"></a>

### OpenAPI / REST API を MCP に

OpenAPI 3.x または Swagger 2.0 の仕様を URL か貼り付けでインポートすると、各オペレーションが MCP ツールになり、パラメーター、認証、エンドポイントの対応付けも設定済みの状態になります。モデルが適切なツールを選べるよう、ビジュアルエディターでツールの名前と説明を調整できます。[REST コネクターのドキュメント](docs/connectors/rest.md) · [ガイド](https://anythingmcp.com/ja/guides/rest-api-to-mcp) · [5 分デモ: openapi-to-mcp](https://github.com/HelpCode-ai/openapi-to-mcp)

<a id="soap--wsdl-to-mcp"></a>

### SOAP / WSDL を MCP に

WSDL を指定すると、SOAP の各オペレーションがツールになります。エンベロープ、パラメーターの順序、WCF サービスは AnythingMCP が処理し、認証には Basic、Bearer、API キーを使えます。2009 年の SOAP サービスを、2026 年のモデルからすぐに使えるようにできます。[SOAP コネクターのドキュメント](docs/connectors/soap.md) · [ガイド](https://anythingmcp.com/ja/guides/soap-to-mcp) · [5 分デモ: soap-to-mcp](https://github.com/HelpCode-ai/soap-to-mcp)

<a id="sql-database-to-mcp"></a>

### SQL データベースを MCP に

PostgreSQL、MySQL、MariaDB、SQL Server、Oracle、SQLite、MongoDB に対応しています。コネクターはスキーマ、クエリー例、クエリー実行のツールを生成します。モデルに SQL を書かせるか、自分で書いたクエリーのパラメーターだけを埋めさせるかを選べます。クエリーツールは初期設定で読み取り専用で、書き込みはブロックされます。さらに読み取り専用のデータベースユーザーと、必要なツールだけが見えるロールを割り当ててください。[データベースコネクターのドキュメント](docs/connectors/database.md) · [ガイド](https://anythingmcp.com/ja/guides/database-to-mcp) · [5 分デモ: sql-to-mcp](https://github.com/HelpCode-ai/sql-to-mcp)

<a id="graphql-to-mcp"></a>

### GraphQL を MCP に

イントロスペクションによって、GraphQL エンドポイントのクエリーとミューテーションが MCP ツールになります。オペレーションを自分で定義することもできます。[GraphQL コネクターのドキュメント](docs/connectors/graphql.md) · [ガイド](https://anythingmcp.com/ja/guides/graphql-to-mcp)

<a id="postman-collection-to-mcp"></a>

### Postman コレクションを MCP に

Postman v2.1 のコレクションをインポートすると、フォルダー、認証、ボディモード、`{{variables}}` が引き継がれ、各リクエストがツールになります。cURL コマンドも同じように使えます。[Postman インポートのドキュメント](docs/connectors/rest.md#from-postman-collection)

---

<a id="erp-connectors"></a>

## ERP コネクター

注文、在庫、請求書に関する質問の多くは、ERP に行き着きます。そうした ERP 向けの既製アダプターを用意しています。インストールして認証情報を追加すれば、ツールがすぐに MCP サーバー上で使えるようになります。各システム名はセットアップガイドにリンクしています。

| システム | 市場 | ツール数 | AI ができること |
|---|---|---|---|
| [SAP Business One](https://anythingmcp.com/ja/guides/connect-sap-business-one-to-claude) | グローバル | 12 | 取引先、品目、注文、請求書、見積、納品。受注の作成 |
| [SAP S/4HANA Cloud](https://anythingmcp.com/ja/guides/connect-sap-s4hana-cloud-to-claude) | グローバル | 15 | 取引先、受注と発注、請求伝票、出荷、仕訳 |
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

**リポジトリ:** [erp-mcp-server](https://github.com/HelpCode-ai/erp-mcp-server) · [weclapp-mcp-server](https://github.com/kochfreiburg/weclapp-mcp-server) · [odoo-mcp-server](https://github.com/keysersoft/odoo-mcp-server)

**お使いの ERP が一覧にない場合や、独自開発・オンプレミスの ERP の場合は？** その [REST API](#openapi--rest-api-to-mcp) や [SOAP サービス](#soap--wsdl-to-mcp)を通じて、または [SQL データベース](#sql-database-to-mcp)に直接、読み取り専用で接続できます。[KOCH Freiburg](https://www.kochfreiburg.de/) は、この方法で自社の ERP を本番環境で接続しています。

---

<a id="e-commerce--marketplace-connectors"></a>

## E コマース・マーケットプレイスのコネクター

Amazon や eBay から DACH 地域のマーケットプレイスまで、ショップとマーケットプレイスに対応しています。各システム名はセットアップガイドにリンクしています。

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

**リポジトリ:** [ecommerce-mcp-server](https://github.com/HelpCode-ai/ecommerce-mcp-server) · [amazon-seller-mcp-server](https://github.com/keysersoft/amazon-seller-mcp-server) · [billbee-mcp-server](https://github.com/kochfreiburg/billbee-mcp-server) · [magento-mcp-server](https://github.com/keysersoft/magento-mcp-server)

---

## 接続・管理・学習できること

### 接続

- **5 種類のコネクター** — [REST](docs/connectors/rest.md)、[SOAP](docs/connectors/soap.md)、[GraphQL](docs/connectors/graphql.md)、[データベース](docs/connectors/database.md)、[MCP 間のブリッジ](docs/connectors/mcp-bridge.md)。データベースは PostgreSQL、MySQL、MariaDB、MSSQL、Oracle、MongoDB、SQLite の 7 エンジンに対応しています。
- **既存の情報からインポート** — OpenAPI/Swagger、Postman、cURL、WSDL、GraphQL イントロスペクションに対応し、稼働中の MCP サーバーから直接ツールを検出することもできます。
- **アダプターカタログ** — [同梱されているアダプターを確認する](#the-adapter-catalog)。
- **ビジュアルツールエディター** — パラメーターをパス、クエリ、リクエストボディ、ヘッダーに対応付けられます。ツールの名前や説明を調整し、AI が意図したとおりに理解できるようにします。
- **動的な MCP サーバー** — ツールは実行時に登録されるため、再起動は不要です。コネクターごとに `{{VAR}}` を展開でき、その値は AI から隠されます。

### 管理

- **[レスポンスの整形](#control-what-the-model-sees)** — モデルへ渡すフィールドをツールごとに正確に指定し、変更前後の内容をリアルタイムで確認できます。
- **必要な箇所を読み取り専用に。** 各ツールには、操作から導出される MCP アノテーション（`readOnlyHint`、`destructiveHint`）が付き、ツール単位で上書きできます。クライアントは、請求書の読み取りとクレジットノートの発行を区別して表示できます。ロールに基づくツールの許可リストを使えば、読み取りしかできない MCP サーバーを公開できます。ERP の導入では、多くの場合ここから始めるのが適切です。
- **幅広い認証方式** — OAuth2（PKCE と Client Credentials）、Bearer、API Key、Basic、HMAC 署名、[LOGIN_TOKEN](docs/connectors/login-token-auth.md)、OAuth 1.0a に対応しています。
- **監査ログ** — すべてのツール呼び出しについて、入力、出力、所要時間、ステータスを自社のデータベースに記録します。
- **[SSO](docs/sso.md) と [SCIM](docs/scim-entra-setup.md)** — Entra ID、Google、Okta、Auth0、汎用 OIDC に対応しています。サインインのたびにディレクトリのグループからロールを同期します。ディレクトリでユーザーを無効にすると、そのユーザーのワークスペースへのアクセスと MCP API キーも無効になります（セルフホスト版のみ）。

### 学習

- **[ナレッジグラフ](docs/knowledge-graph.md)** — コネクターのデータ同士の関係を、個人識別情報（PII）を保護しながらワークスペースごとに整理します。MCP ツールとしてエージェントに返すことで、複数のシステムにまたがる呼び出しを正しくつなげられます。
- **[AI スキル](docs/knowledge-graph.md)** — 繰り返される利用パターンを小さな再利用可能なルールに変え、サーバーの指示に組み込みます。追加のツール呼び出しをせずにエージェントを導けます（任意のオプトイン機能）。

---

## 他のプロジェクトとの比較

AnythingMCP は、一段階前から始める MCP ゲートウェイです。既に運用している API、ERP、データベースから MCP サーバーを作成し、1 つのエンドポイントの背後で提供し、公開範囲を限定し、監査します。他の MCP ゲートウェイは、既にある MCP サーバーをまとめて安全に運用するためのものです。しかし多くの企業には、まだ MCP サーバーがありません。あるのは REST API、2009 年の SOAP サービス、そして直接公開したくないデータベースです。以下のプロジェクトはいずれも実際の問題を解決していますが、扱う問題は同じではありません。

| | どのようなものか | こちらを選ぶとよい場合 |
|---|---|---|
| **[ContextForge](https://github.com/IBM/mcp-context-forge)**（IBM） | 既存の MCP サーバーの前段に置くフェデレーション機能とレジストリー | ツールが既に MCP サーバーとして提供されていて、フェデレーション、仮想サーバー、レジストリーが必要な場合 |
| **[Docker MCP Gateway](https://github.com/docker/mcp-gateway)** | カタログ内の MCP サーバーを、シークレット管理付きのコンテナーとして単一のエンドポイントの背後で実行 | ベンダー公開の MCP サーバーを Docker 内に隔離したく、公開カタログで要件を満たせる場合 |
| **[MetaMCP](https://github.com/metatool-ai/metamcp)** | 名前空間で分離したエンドポイントとミドルウェア層に MCP サーバーを集約 | 主に既存の MCP サーバーをクライアントごとにグループ化し、公開範囲を再設定したい場合 |
| **[Composio](https://github.com/ComposioHQ/composio)** | 認証を代行するマネージド連携のホスト型カタログ | 固定のマネージドカタログで十分で、独自の SOAP サービス、社内 API、データベースを追加する必要がない場合 |
| **AnythingMCP** | 既に運用している API、SOAP サービス、データベースを MCP ツールに変換 | システムが**まだ MCP サーバーではなく**、認証情報を自分で管理する選択肢を持ちたい場合 |

機能を詳しく比較した表は [anythingmcp.com/vs](https://anythingmcp.com/vs) にあります。

---

<a id="knowledge-graph--ai-skills"></a>

## ナレッジグラフと AI スキル

呼び出しを転送するだけでは、難しい判断はエージェントに残ります。次にどのツールを呼ぶべきか、業務でいう「未完了の注文」や「アクティブな顧客」が実際に何を意味するのか、といった判断です。AnythingMCP は、**コネクター内のデータ同士の関係**と、**チームが実際にツールをどう使っているか**の両方を学習します。そして追加のツール呼び出しではなく、コンテキストとして AI クライアントへ返します。

- **ナレッジグラフ** — 顧客、注文、商品などの*エンティティ*と、その*関係*をワークスペースごとに整理します。ツール名、パラメーター、実際の呼び出しの入出力から自動で構築されます。オプションの AI 分析では、ヒューリスティックで捉えられないコネクター間のつながりを推定します。**PII を保護する設計**で、保存するのはエンティティやフィールドの*名前*と関係のメタデータだけです。値そのものは保存しません。
- **視覚的に構築** — グラフエディターでエンティティや接続を手動で作成、編集、削除できます。説明を追加し、AI の提案を確認して調整することもできます。
- **MCP 経由で提供** — 各サーバーは `kg_how_to_obtain` ツールを公開します。*利用者側の*エージェントが「Shopware の注文から DHL の追跡番号を取得するには？」と尋ねると、コネクターをつなぐためのヒントを受け取れます。
- **実際の利用から生まれる AI スキル** — 意図の記録を有効にすると、各ツール呼び出しで*なぜ呼び出したのか*を記録できます。AI 分析が繰り返し現れるパターンを、*「今日の売上にはステータス 2、3、4 の注文を含める」*といった小さな再利用可能なルールに変えます。各ルールを適用、編集、却下することも、信頼度の高いものを自動適用することもできます。適用済みのスキルは、提供時に MCP サーバーの**指示**へ組み込まれるため、**ツール呼び出しを一度も追加せずに**エージェントを導けます。システムの利用を通じて蓄積した知識を、個人の頭の中だけに留めずに済みます。

AI 分析は**既定では無効**です。全体の環境変数フラグ*と*ワークスペースごとのスイッチで有効にし、OpenAI、OpenRouter、Anthropic を利用できます。グラフ、手動編集、MCP ツール自体は、LLM キーなしで使えます。

➡️ **[ナレッジグラフと AI スキルのガイド →](docs/knowledge-graph.md)**

---

<a id="control-what-the-model-sees"></a>

## モデルに見せる内容を制御する

各ツールで、**どのフィールドが自社のインフラの外に出るかを正確に定義**できます。マッピングはツールごとに設定され、応答の送信時に適用されます。AI クライアントと、その背後にあるサードパーティーのモデルには、承認したデータ構造だけが渡ります。

- **外部に出すべきでないものを削除。** 削除するパスを指定すると、エージェントへ応答を渡す前に除去されます。顧客の IBAN、従業員の給与、API がデータと一緒に返すアクセストークンなどが対象になります。
- **出力全体を定義することも可能。** `select` テンプレートで、残すフィールドと出力名を指定します。テンプレートで表現できない変換には JMESPath 式を使えます。エージェントにとって構造が安定しているほうが扱いやすい場合は、フィールドを削除せず、値をプレースホルダー（`"iban": "= [redacted]"`）に置き換えます。
- **保存前に結果を確認。** エディターが実際の応答にマッピングを適用し、変換前後の内容とサイズの差を並べて表示します。同梱アダプターの一例では、列車 4 件の結果で **12,172 B → 1,072 B（91% 削減）**を計測しています。
- **既定はフェイルオープンであり、その挙動を明記しています。** 実行時にマッピングが失敗すると、元の応答を返し、警告を記録します。誤った式が 1 つあるだけで、動作していたツール全体が使えなくなるのを防ぐためです。ただし、外部へ絶対に出してはいけないフィールドには、この既定値は適していません。そのようなツールには **`"fallbackToRaw": false`** を設定してください。マッピングが失敗したときは、データをそのまま渡すのではなく、呼び出し自体が失敗します。

機密フィールドをモデルに渡さずに済むうえ、削除したフィールドの分だけコンテキストウィンドウの費用も減らせます。

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

> 監査ログには、自社のデータベース内で完全な上流応答が引き続き記録されます。エージェントに見せる内容を調整しても、API が実際に何を返したかという証拠は失われません。

➡️ **[レスポンスマッピングのリファレンス →](docs/tool-definition.md#3-response-mapping-optional)**

---

## コードを書かずに独自の Claude コネクターを作る

Claude は**カスタムコネクター**をサポートしています。*Customize → Connectors* でリモート MCP サーバーを一度追加すると、Claude.ai、Claude Desktop、Claude Code で利用できます。AnythingMCP なら、**既存の任意の API からそのコネクターを作成**でき、MCP サーバーを実装する必要はありません。

1. API 仕様をインポートするか、既製のアダプターを選びます。
2. **ビジュアルエディター**でツール名、説明、パラメーターを調整します。AI に何を見せるかは自分で決められます。
3. MCP サーバーの URL を Claude のカスタムコネクターとして追加します（OAuth 2.0 を標準でサポート）。

認証情報は自社のインフラ上に残り、すべてのツール呼び出しが監査ログに記録されます。どのユーザーがどのツールを利用できるかは、ロールに基づくアクセス制御で管理します。[詳しい手順 →](docs/integrations/claude.md)

---

## API を ChatGPT アプリにする

**ChatGPT のアプリは MCP を基盤にしています。** AnythingMCP は、その MCP バックエンドを自分で書くことなく用意できます。REST、SOAP、GraphQL、データベースのエンドポイントを指定すれば、ChatGPT で使えるコネクターになります。ChatGPT の設定で追加するか、Apps SDK アプリのツール層として使うことで、ChatGPT が業務データを読み取り、操作できるようになります。

同じコネクターを **Claude、ChatGPT、Gemini、Copilot、Cursor** で同時に使えます。一度構築すれば、各クライアントへ接続できます。[ChatGPT の設定ガイド →](docs/integrations/chatgpt.md)

---

## AnythingMCP を使う理由

AI クライアントは MCP を使いますが、業務システムは REST、SOAP、GraphQL、SQL を使います。システムごとに専用の MCP サーバーを作成し、認証、監査、アクセス制御まで含めて保守するには、それぞれ数週間かかります。AnythingMCP は、その間をつなぐノーコードの層です。

| 課題 | 解決方法 |
|---|---|
| REST API はあるが、AI クライアントは MCP を使う | OpenAPI / Swagger のインポートによる **REST → MCP** 変換 |
| 古い SOAP / WSDL サービスがある | 自動 WSDL 解析による **SOAP → MCP** ブリッジ |
| AI エージェントからデータベースを照会したい | クエリーツールを自動生成する **DB → MCP**（7 エンジン） |
| すべての API を 1 つのエンドポイントにまとめたい | 複数のコネクターを集約する **MCP ミドルウェア** |
| SAP Business One / Odoo / Shopware などの MCP サーバーが必要 | **アダプターカタログ**から選び、1 分でインストールして認証情報を設定 |
| 認証情報をサードパーティーへ預けられない | **自社のインフラ上で実行**し、認証情報を AES-256-GCM で暗号化して保存 |
| 認証、監査ログ、RBAC が必要 | **OAuth2、監査ログ、ロールベースのアクセス制御**を標準搭載 |
| サードパーティーのモデルが API 応答の全フィールドを見てしまう | **[ツールごとのレスポンスマッピング](#control-what-the-model-sees)**で、ネットワークの外に出る前にフィールドを削除・整形 |
| エージェントがツールの順序を間違えたり、システム間の関係を見落としたりする | **[ナレッジグラフと AI スキル](#knowledge-graph--ai-skills)**で、呼び出しのつなぎ方と学習した業務ルールをコンテキストとして提供 |

**実際の活用例**

| | ガイド |
|---|---|
| Claude から ERP と対話する | [SAP Business One](https://anythingmcp.com/ja/guides/connect-sap-business-one-to-claude) · [Odoo](https://anythingmcp.com/ja/guides/connect-odoo-to-claude) · [weclapp](https://anythingmcp.com/ja/guides/weclapp-to-mcp) · [Xentral](https://anythingmcp.com/ja/guides/xentral-to-mcp) |
| 複数のショップやマーケットプレイスの注文、在庫、手数料を確認する | [Amazon Seller](https://anythingmcp.com/ja/guides/connect-amazon-seller-to-claude) · [WooCommerce](https://anythingmcp.com/ja/guides/connect-woocommerce-to-claude) · [Kaufland](https://anythingmcp.com/ja/guides/connect-kaufland-to-claude) |
| 荷物を追跡する | [DHL](https://anythingmcp.com/guides/dhl-tracking-to-mcp) · [GLS](https://anythingmcp.com/guides/gls-tracking-to-mcp) |
| 支払い前に請求書を検証する | [VIES VAT](https://anythingmcp.com/guides/vies-vat-to-mcp) · [Handelsregister](https://anythingmcp.com/guides/handelsregister-to-mcp) |
| エージェントから本番データベースを読み取り専用で使う | [データベースコネクター](docs/connectors/database.md) |
| 2009 年の SOAP サービスを 2026 年のモデルにつなぐ | [SOAP → MCP](https://anythingmcp.com/guides/soap-to-mcp) |
| 列車、現在の遅延、経路を調べる | [Deutsche Bahn](https://anythingmcp.com/guides/deutsche-bahn-to-mcp) |

---

<a id="the-adapter-catalog"></a>

## アダプターカタログ

258 個のアダプターで、2,400 以上のツールを公開できます。**21 個は API キーが不要**です。それ以外はインポート時に認証情報を設定すれば、すぐにツールを利用できます。各アダプターには [anythingmcp.com/guides](https://anythingmcp.com/guides) で 7 言語のセットアップガイドを用意しています。

| カテゴリー | 例 |
|---|---|
| 📦 物流・配送 | Deutsche Bahn、DHL、DPD、GLS、Shipcloud、Sendcloud |
| 💼 ERP・会計・請求 | [SAP Business One、Odoo、weclapp、Xentral ほか 12 種類の ERP](#erp-connectors)、Lexware Office、sevDesk、Exact Online、bexio |
| 🛍️ E コマース | [Amazon Seller、WooCommerce、Shopware 6、Kaufland、OTTO ほか 8 種類](#e-commerce--marketplace-connectors)、Oxomi |
| 👥 人事・フィールドサービス | Personio、HRWorks、Kenjo、MFR Mobile Field Report |
| 🏛️ 行政・公開データ | VIES VAT、Handelsregister、UK Companies House 🇬🇧、DESTATIS、Bundesbank、OpenPLZ、NINA |
| 🏦 銀行・決済 | Revolut Business、Wise 🇬🇧、PAYONE、Razorpay 🇮🇳、Paystack 🇳🇬 |
| 💬 メッセージング・通信 | WhatsApp、LINE 🇯🇵、TeamViewer |
| 🎾 スポーツ・Web3 | Playtomic、Sorare |
| 🏗️ 建設・地図 | PlanRadar、HERE Geocoding |

**アダプターは 1 つの JSON ファイルです。** だからこそカタログをこの規模まで増やすことができ、新しいアダプターの追加は最初の貢献にも適しています。必要なものが見つからない場合は、[リクエスト](https://github.com/HelpCode-ai/anythingmcp/issues/new?template=adapter_request.yml)してください。👍 の数を基に優先順位を決めます。[自分で作成](CONTRIBUTING.md)することもできます。

---

## ガイド・クライアント設定・FAQ

➡️ **[docs/guides.md](docs/guides.md)** — Claude / ChatGPT / Gemini / Copilot / Cursor の設定 · REST / SOAP / GraphQL / データベース / MCP ブリッジのコネクターガイド · API リファレンスとデプロイドキュメント · FAQ。

特定のサービスを探している場合は、**[anythingmcp.com/guides](https://anythingmcp.com/guides)** に各アダプターの詳しい手順があります。

---

<a id="faq"></a>

## よくある質問（FAQ）

**ERP（SAP Business One、Odoo、Xentral など）を Claude や ChatGPT に接続するには？**
[カタログ](#erp-connectors)から ERP のアダプターをインストールして API の認証情報を入力し、MCP サーバーの URL を Claude にはカスタムコネクターとして、ChatGPT にはアプリとして追加します。ERP にアダプターがない場合は、その REST API、SOAP API、または SQL データベースに直接接続してください。最初は読み取りしかできないロールから始めましょう。

**OpenAPI 仕様を MCP サーバーにするには？**
REST コネクターを作成し、仕様を URL か貼り付けでインポートします。各オペレーションが、サーバーの `/mcp` エンドポイント上の MCP ツールになります。コードは不要です。[仕組みはこちら](docs/connectors/rest.md#from-openapi--swagger)

**SOAP/WSDL サービスを Claude に接続できますか？**
はい。AnythingMCP が WSDL を解析して各オペレーションをツールに変換し、呼び出しのたびに SOAP エンベロープを組み立てます。WCF サービスにも対応しています。認証は HTTP Basic、Bearer、API キーヘッダーで行います。WS-Security ヘッダーはまだ実装されていません。[SOAP コネクターのドキュメント](docs/connectors/soap.md)

**Claude から SQL Server、Oracle、PostgreSQL のデータベースを安全に照会できますか？**
データベースコネクターは初期設定で読み取り専用です。AnythingMCP は単一の SELECT（または `WITH … SELECT`）だけを実行し、書き込みや複数ステートメントをブロックします。そのうえで、SELECT 権限だけを持つデータベースユーザーを使い、モデルがパラメーターだけを指定する静的クエリーを優先し、ロールごとにツールを許可リストで絞り込んでください。レスポンスマッピングでモデルに渡してはいけない列を削除でき、すべてのクエリーは自社データベース内の監査ログに記録されます。

**Shopware、WooCommerce、Amazon Seller Central を Claude に接続するには？**
ショップやマーケットプレイスに対応する [E コマースアダプター](#e-commerce--marketplace-connectors)をインストールし、認可します。WooCommerce には 49 のツールがあり、Amazon Seller Central は公式の Selling Partner API を使います。Shopware 6 アダプターは Store API を通じてストアフロントのカタログを読み取ります。

**AnythingMCP は MCP ゲートウェイですか？セルフホストで無料ですか？**
はい、3 つともそのとおりです。すべてのコネクターの前段に 1 つの MCP エンドポイントを置き、OAuth2、RBAC、SSO、監査を備えています。AGPL-3.0 のもとで自社のサーバー上で動作し、商用利用も含まれます。[AnythingMCP Cloud](https://cloud.anythingmcp.com) はオプションのホスト版です。

**Composio とはどう違いますか？**
Composio はマネージド連携のホスト型カタログです。AnythingMCP は社内の独自 API、SOAP サービス、データベースもツールに変換でき、すべての認証情報を自社のインフラ上に保持できます。[詳しい比較](https://anythingmcp.com/ja/vs/alternatives-to-composio)

---

## コミュニティとサポート

- 💬 **質問・ディスカッション** — [GitHub Discussions](https://github.com/HelpCode-ai/anythingmcp/discussions)で、次に追加するアダプターへ投票したり、作成したものを共有したりできます。
- 🐛 **不具合 / 💡 機能の提案** — [Issues](https://github.com/HelpCode-ai/anythingmcp/issues) · 🆘 [SUPPORT.md](SUPPORT.md)
- 🔐 **セキュリティ** — 公開 Issue は作成せず、[SECURITY.md](SECURITY.md) の手順に従ってください。
- 🏢 ドイツ・フライブルクの [helpcode.ai](https://helpcode.ai) が開発しています。AI を活用して開発し、人がレビューしています。対象となる部分や進め方は [AUTHORS.md](AUTHORS.md) に記載しています。

## 貢献する

PR を作成する前に、[貢献ガイド](CONTRIBUTING.md)を読んでください。最も取り組みやすく有用な貢献は、1 つの JSON ファイルからなるアダプターの追加です。そのための[手順を解説した Issue](https://github.com/HelpCode-ai/anythingmcp/issues/150)もあります。

## License

**Open source** under the [GNU Affero General Public License v3](LICENSE) (AGPL-3.0-only). Commercial use inside your own company is included and always was; the copyleft obligation only starts if you modify AnythingMCP and offer the modified version to others over a network. Cloud-operator code under `ee/` is separately licensed and is not required for self-hosting — see the [License FAQ](docs/license-faq.md).


---

<p align="center">
  <strong>⭐ MCP サーバーの実装にかかる 1 週間を節約できたら、スターを付けてください。</strong><br/>
  <em>スターは、次の利用者がプロジェクトを見つけるきっかけになり、次に作るアダプターを決める参考にもなります。</em>
</p>

<p align="center">
  <a href="https://star-history.com/#HelpCode-ai/anythingmcp&Date">
    <img src="https://api.star-history.com/svg?repos=HelpCode-ai/anythingmcp&type=Date" alt="スター数の推移" width="70%">
  </a>
</p>

<p align="center">
  <a href="https://github.com/HelpCode-ai/anythingmcp/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=HelpCode-ai/anythingmcp" alt="コントリビューター">
  </a>
</p>
