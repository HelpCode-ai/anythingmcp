<p align="center">
  <img src="docs/assets/banner.png" alt="AnythingMCP — 257 のコネクター、うち 20 は API キー不要。REST、SOAP/WSDL、GraphQL、SQL、MCP システムを Claude、ChatGPT、Copilot、Gemini 用のツールにします。" width="100%" />
</p>

<h1 align="center">AnythingMCP</h1>

<p align="center">
  <a href="README.md">English</a> · <a href="README.de.md">Deutsch</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <strong>Claude、ChatGPT、Copilot から、企業で既に使っているソフトウェアへ安全にアクセスできます。</strong><br/>
  257 種類の既製アダプターに加え、REST・SOAP・GraphQL・SQL の各システムをコードを書かずに接続。自社のインフラ上で動作し、システム同士のつながりも学習します。
</p>

<p align="center">
  <a href="https://github.com/HelpCode-ai/anythingmcp/stargazers"><img src="https://img.shields.io/github/stars/HelpCode-ai/anythingmcp?style=flat&logo=github&logoColor=white&color=2563eb&labelColor=0b1220" alt="GitHub Stars"></a>
  <a href="https://github.com/HelpCode-ai/anythingmcp/releases"><img src="https://img.shields.io/github/v/release/HelpCode-ai/anythingmcp?include_prereleases&color=2563eb&labelColor=0b1220" alt="Release"></a>
  <a href="https://github.com/HelpCode-ai/anythingmcp/blob/main/LICENSE"><img src="https://img.shields.io/badge/open%20source-AGPL--3.0-2563eb?labelColor=0b1220" alt="Open source, AGPL-3.0"></a>
  <a href="https://hub.docker.com/r/helpcodeai/anythingmcp"><img src="https://img.shields.io/docker/pulls/helpcodeai/anythingmcp?logo=docker&logoColor=white&color=2563eb&labelColor=0b1220" alt="Docker pulls"></a>
</p>

**これまでチャットボットでは答えられなかった質問に、Claude が回答します。** 必要なデータが、MCP ではなく REST を使うフィールドサービスシステムに保存されている場合でも対応できます。

<p align="center">
  <img src="docs/assets/demo-claude.gif" alt="技術者が先週訪問した会社についての質問に答えるため、Claude が稼働中のフィールドサービスシステムに接続する AnythingMCP のツールを呼び出している様子。" width="100%" />
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

- **アダプター（adapter）**は、このリポジトリに含まれる 257 個の JSON 定義のいずれかです。DATEV、weclapp、DHL、Deutsche Bahn、Shopware、Personio、Handelsregister などがあります。そのうち 20 個は API キーを一切必要とせず、それ以外はインポート時に認証情報を設定します。
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
- **幅広い認証方式** — OAuth2（PKCE と Client Credentials）、Bearer、API Key、Basic、WS-Security、クライアント証明書、[LOGIN_TOKEN](docs/connectors/login-token-auth.md)、OAuth 1.0a に対応しています。
- **監査ログ** — すべてのツール呼び出しについて、入力、出力、所要時間、ステータスを自社のデータベースに記録します。
- **[SSO](docs/sso.md) と [SCIM](docs/scim-entra-setup.md)** — Entra ID、Google、Okta、Auth0、汎用 OIDC に対応しています。サインインのたびにディレクトリのグループからロールを同期します。ディレクトリでユーザーを無効にすると、そのユーザーのワークスペースへのアクセスと MCP API キーも無効になります（セルフホスト版のみ）。

### 学習

- **[ナレッジグラフ](docs/knowledge-graph.md)** — コネクターのデータ同士の関係を、個人識別情報（PII）を保護しながらワークスペースごとに整理します。MCP ツールとしてエージェントに返すことで、複数のシステムにまたがる呼び出しを正しくつなげられます。
- **[AI スキル](docs/knowledge-graph.md)** — 繰り返される利用パターンを小さな再利用可能なルールに変え、サーバーの指示に組み込みます。追加のツール呼び出しをせずにエージェントを導けます（任意のオプトイン機能）。

---

## 他のプロジェクトとの比較

AnythingMCP と比較されるプロジェクトの多くは、MCP ゲートウェイです。既にある MCP サーバーをまとめ、公開範囲を限定し、安全に運用するためのものです。AnythingMCP はその一段階前から始めます。多くの企業にあるのは MCP サーバーではなく、REST API、2009 年の SOAP サービス、そして直接公開したくないデータベースだからです。以下のプロジェクトはいずれも実際の問題を解決していますが、扱う問題は同じではありません。

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

Claude は**カスタムコネクター**をサポートしています。*Settings → Connectors* でリモート MCP サーバーを一度追加すると、Claude.ai、Claude Desktop、Claude Code で利用できます。AnythingMCP なら、**既存の任意の API からそのコネクターを作成**でき、MCP サーバーを実装する必要はありません。

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
| Deutsche Bahn / DHL / weclapp などの MCP サーバーが必要 | **アダプターカタログ**から選び、1 分でインストールして認証情報を設定 |
| 認証情報をサードパーティーへ預けられない | **自社のインフラ上で実行**し、認証情報を AES-256-GCM で暗号化して保存 |
| 認証、監査ログ、RBAC が必要 | **OAuth2、監査ログ、ロールベースのアクセス制御**を標準搭載 |
| サードパーティーのモデルが API 応答の全フィールドを見てしまう | **[ツールごとのレスポンスマッピング](#control-what-the-model-sees)**で、ネットワークの外に出る前にフィールドを削除・整形 |
| エージェントがツールの順序を間違えたり、システム間の関係を見落としたりする | **[ナレッジグラフと AI スキル](#knowledge-graph--ai-skills)**で、呼び出しのつなぎ方と学習した業務ルールをコンテキストとして提供 |

**実際の活用例**

| | ガイド |
|---|---|
| 列車、現在の遅延、経路を調べる | [Deutsche Bahn](https://anythingmcp.com/guides/deutsche-bahn-to-mcp) |
| Claude から ERP と対話する | [weclapp](https://anythingmcp.com/guides/weclapp-to-mcp) · [Xentral](https://anythingmcp.com/guides/xentral-to-mcp) |
| 荷物を追跡する | [DHL](https://anythingmcp.com/guides/dhl-tracking-to-mcp) · [GLS](https://anythingmcp.com/guides/gls-tracking-to-mcp) |
| 支払い前に請求書を検証する | [VIES VAT](https://anythingmcp.com/guides/vies-vat-to-mcp) · [Handelsregister](https://anythingmcp.com/guides/handelsregister-to-mcp) |
| エージェントから本番データベースを読み取り専用で使う | [データベースコネクター](docs/connectors/database.md) |
| 2009 年の SOAP サービスを 2026 年のモデルにつなぐ | [SOAP → MCP](https://anythingmcp.com/guides/soap-to-mcp) |

---

<a id="the-adapter-catalog"></a>

## アダプターカタログ

257 個のアダプターで、1,800 以上のツールを公開できます。**20 個は API キーが不要**です。それ以外はインポート時に認証情報を設定すれば、すぐにツールを利用できます。各アダプターには [anythingmcp.com/guides](https://anythingmcp.com/guides) で 7 言語のセットアップガイドを用意しています。

| カテゴリー | 例 |
|---|---|
| 📦 物流・配送 | Deutsche Bahn、DHL、DPD、GLS、Shipcloud、Sendcloud |
| 💼 ERP・会計・請求 | weclapp、Xentral、DATEV、Scopevisio、Billomat、FastBill |
| 🛍️ E コマース | Amazon Seller、Etsy、Shopware 6、WooCommerce、Mercado Libre 🌎、Oxomi |
| 👥 人事・フィールドサービス | Personio、HRWorks、Kenjo、MFR Mobile Field Report |
| 🏛️ 行政・公開データ | VIES VAT、Handelsregister、UK Companies House 🇬🇧、DESTATIS、Bundesbank、OpenPLZ、NINA |
| 🏦 銀行・決済 | N26、Wise 🇬🇧、PAYONE、Razorpay 🇮🇳、Paystack 🇳🇬 |
| 💬 メッセージング・通信 | WhatsApp、LINE 🇯🇵、TeamViewer |
| 🎾 スポーツ・Web3 | Playtomic、Sorare |
| 🏗️ 建設・地図 | PlanRadar、HERE Geocoding |

**アダプターは 1 つの JSON ファイルです。** だからこそカタログをこの規模まで増やすことができ、新しいアダプターの追加は最初の貢献にも適しています。必要なものが見つからない場合は、[リクエスト](https://github.com/HelpCode-ai/anythingmcp/issues/new?template=adapter_request.yml)してください。👍 の数を基に優先順位を決めます。[自分で作成](CONTRIBUTING.md)することもできます。

---

## ガイド・クライアント設定・FAQ

➡️ **[docs/guides.md](docs/guides.md)** — Claude / ChatGPT / Gemini / Copilot / Cursor の設定 · REST / SOAP / GraphQL / データベース / MCP ブリッジのコネクターガイド · API リファレンスとデプロイドキュメント · FAQ。

特定のサービスを探している場合は、**[anythingmcp.com/guides](https://anythingmcp.com/guides)** に各アダプターの詳しい手順があります。

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
