<p align="center">
  <img src="docs/assets/banner.png" alt="AnythingMCP macht ERP-, E-Commerce-, REST-, SOAP- und SQL-Systeme zu MCP-Tools für Claude und ChatGPT: 258 Connectors, 21 davon ohne API-Schlüssel." width="100%" />
</p>

<h1 align="center">AnythingMCP</h1>

<p align="center">
  <a href="README.md">English</a> · <a href="README.de.md">Deutsch</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <strong>Mach aus jeder REST-/OpenAPI-, SOAP-, GraphQL- oder SQL-API MCP-Tools für Claude, ChatGPT und Copilot.</strong><br/>
  Selbst gehosteter MCP-Server und MCP-Gateway, ohne Code. 258 fertige Adapter, auch für ERP und E-Commerce: SAP Business One, Xentral, weclapp, Shopware, WooCommerce, Amazon Seller, Kaufland und viele mehr.
</p>

<p align="center">
  <a href="https://github.com/HelpCode-ai/anythingmcp/stargazers"><img src="https://img.shields.io/github/stars/HelpCode-ai/anythingmcp?style=flat&logo=github&logoColor=white&color=2563eb&labelColor=0b1220" alt="GitHub Stars"></a>
  <a href="https://github.com/HelpCode-ai/anythingmcp/releases"><img src="https://img.shields.io/github/v/release/HelpCode-ai/anythingmcp?include_prereleases&color=2563eb&labelColor=0b1220" alt="Release"></a>
  <a href="https://github.com/HelpCode-ai/anythingmcp/blob/main/LICENSE"><img src="https://img.shields.io/badge/open%20source-AGPL--3.0-2563eb?labelColor=0b1220" alt="Open source, AGPL-3.0"></a>
  <a href="https://hub.docker.com/r/helpcodeai/anythingmcp"><img src="https://img.shields.io/docker/pulls/helpcodeai/anythingmcp?logo=docker&logoColor=white&color=2563eb&labelColor=0b1220" alt="Docker pulls"></a>
</p>

**Claude beantwortet eine Frage, die zuvor kein Chatbot beantworten konnte**, weil die Daten in einem Außendienstsystem liegen, das REST statt MCP spricht:

<p align="center">
  <img src="docs/assets/demo-claude.gif" alt="AnythingMCP in Claude: Auf die Frage, welche Firmen ein Techniker letzte Woche besucht hat, ruft Claude MCP-Tools auf, die AnythingMCP aus der REST-API eines Außendienstsystems erzeugt hat." width="100%" />
</p>

**Selbst ausprobieren** — drei Zeilen, ohne das Repository zu klonen, [Details weiter unten](#run-it-yourself):

```bash
mkdir anythingmcp && cd anythingmcp
curl -fsSLo docker-compose.yml \
  https://raw.githubusercontent.com/HelpCode-ai/anythingmcp/main/docker-compose.quickstart.yml
printf 'JWT_SECRET=%s\nENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
docker compose up -d   # → http://localhost:3000
```

---

Drei Begriffe tauchen immer wieder auf und bezeichnen unterschiedliche Dinge:

- Ein **Adapter** ist eine der 258 JSON-Definitionen in diesem Repository — SAP Business One, Odoo, weclapp, Xentral, Shopware, WooCommerce, Amazon Seller, DHL und viele weitere. 21 davon benötigen überhaupt keinen API-Schlüssel; bei den anderen gibst du deine Zugangsdaten beim Import an.
- Ein **Connector** entsteht, wenn du einen Adapter oder deine eigene OpenAPI-Spezifikation, Postman-Collection, WSDL, einen GraphQL-Endpunkt oder eine Datenbank in deinem Workspace konfigurierst. In wenigen Minuten lässt sich so eine Verbindung einrichten, ohne einen MCP-Server zu programmieren.
- Ein **MCP-Server** ist die URL, die du Claude übergibst. Er stellt ausschließlich die Connectors bereit, die du ihm zuweist.

Alles läuft auf deiner Infrastruktur. Du entscheidest also, welche Daten sie verlassen. Das Response-Mapping legt für jedes Tool fest, welche Felder das Modell erreichen dürfen. Gespeicherte Zugangsdaten werden mit AES-256-GCM verschlüsselt; das Audit-Log bewahrt die vollständige Antwort des angebundenen Systems bei dir auf. OAuth2, RBAC, SSO und SCIM sind im selbst gehosteten Build enthalten und werden nicht einem kostenpflichtigen Tarif vorbehalten.

**Im produktiven Einsatz bei [KOCH Freiburg GmbH](https://www.kochfreiburg.de/)**: Dort verbindet AnythingMCP KI-Assistenten mit mehr als 15 internen Systemen — ERP, CRM, SOAP-Diensten und lokalen Datenbanken. [helpcode.ai](https://helpcode.ai) aus Freiburg hat AnythingMCP aus diesem System herausgelöst und als Open Source veröffentlicht, weil ein Adapterkatalog in einer Community schneller wächst als im Alleingang.

---

<a id="run-it-yourself"></a>

## Selbst betreiben

**Der empfohlene Weg**, auf dem auch die unten genannten Messungen beruhen. Benötigt werden Docker 24+ und `openssl`; starte unter macOS zuerst Docker Desktop.

```bash
mkdir anythingmcp && cd anythingmcp
curl -fsSLo docker-compose.yml \
  https://raw.githubusercontent.com/HelpCode-ai/anythingmcp/main/docker-compose.quickstart.yml
printf 'JWT_SECRET=%s\nENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
docker compose up -d
```

Öffne <http://localhost:3000> und registriere dich — **das erste Konto erhält Administratorrechte**.

> **Bewahre die erzeugte `.env` auf.** Mit `ENCRYPTION_KEY` werden die gespeicherten Zugangsdaten entschlüsselt. Geht dieser Schlüssel verloren, musst du die Zugangsdaten für jeden Connector neu hinterlegen. Sichere ihn dort, wo du auch deine anderen Geheimnisse aufbewahrst.

| Dienst | Standard-URL |
|---|---|
| Weboberfläche | `http://localhost:3000` |
| MCP-Endpunkt | `http://localhost:4000/mcp` |
| Swagger-Dokumentation | `http://localhost:4000/api/docs` |

*Auf amd64 gemessen: 31 s für den Image-Download, 24 s bis zu einer betriebsbereiten API und einer Anmeldeseite. Das veröffentlichte Image unterstützt vorerst nur amd64. Die Compose-Datei legt die Plattform deshalb ausdrücklich fest, sodass es auf Apple Silicon unter der Emulation von Docker Desktop läuft. Derselbe Start dauerte auf einem Laptop mit M-Chip 24 s; auf älterer Hardware kann er einige Minuten beanspruchen.*

Der Schnellstart bindet die Dienste bewusst an `127.0.0.1`: Es gibt davor noch keine TLS-Terminierung. **Für eine Instanz, die andere Personen oder ein KI-Client aus der Cloud erreichen können sollen**, klone das Repository und führe `./setup.sh` aus. Das Skript fragt nach einer Domain, beschafft Zertifikate über Caddy, erzeugt die Geheimnisse und legt den MCP-Authentifizierungsmodus fest. Siehe die [Deployment-Anleitung](docs/deployment.md).

<details>
<summary><strong>Weitere Deployment-Möglichkeiten</strong> — verwaltete Cloud, Railway, DigitalOcean</summary>

<br/>

[**AnythingMCP Cloud**](https://cloud.anythingmcp.com) verwendet denselben AGPL-Code und wird von uns in **Frankfurt, Deutschland** betrieben. Damit kannst du es mit deinen eigenen APIs ausprobieren, ohne selbst Infrastruktur bereitzustellen. Wenn die Zugangsdaten dein Unternehmen nicht mehr verlassen sollen, ziehst du die Installation zu dir um — die Connectors bleiben dieselben. Eine DPA/AVV ist auf Anfrage über [info@helpcode.ai](mailto:info@helpcode.ai) erhältlich. SSO und SCIM stehen nur beim Self-Hosting zur Verfügung.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/8-X4WD?referralCode=k30bPV&utm_medium=integration&utm_source=template&utm_campaign=generic)
&nbsp;
[![Install on DigitalOcean](https://www.deploytodo.com/do-btn-blue.svg)](https://marketplace.digitalocean.com/apps/anythingmcp)

</details>

---

<a id="connect-any-system"></a>

## Jedes System anbinden

Die meisten Unternehmen haben noch keine MCP-Server. Sie haben eine REST-API, ein ERP, einen SOAP-Dienst und eine Datenbank. Aus jedem dieser Systeme werden MCP-Tools, und eine einzige MCP-Server-URL stellt sie Claude, ChatGPT oder Copilot bereit.

<a id="openapi--rest-api-to-mcp"></a>

### OpenAPI / REST-API zu MCP

Importiere eine OpenAPI-3.x- oder Swagger-2.0-Spezifikation per URL oder durch Einfügen, und jede Operation wird zu einem MCP-Tool, bei dem Parameter, Authentifizierung und Endpunkt-Zuordnung bereits ausgefüllt sind. Im visuellen Editor gibst du den Tools passende Namen und Beschreibungen, damit das Modell das richtige auswählt. [Dokumentation zum REST-Connector](docs/connectors/rest.md) · [Anleitung](https://anythingmcp.com/de/guides/rest-api-to-mcp)

<a id="soap--wsdl-to-mcp"></a>

### SOAP / WSDL zu MCP

Gib AnythingMCP eine WSDL, und jede SOAP-Operation wird zu einem Tool: Envelopes, Parameterreihenfolge und WCF-Dienste übernimmt AnythingMCP für dich, mit Basic-, Bearer- oder API-Key-Authentifizierung. So bringst du einen SOAP-Dienst aus dem Jahr 2009 in Minuten statt Wochen vor ein Modell von 2026. [Dokumentation zum SOAP-Connector](docs/connectors/soap.md) · [Anleitung](https://anythingmcp.com/de/guides/soap-to-mcp)

<a id="sql-database-to-mcp"></a>

### SQL-Datenbank zu MCP

PostgreSQL, MySQL, MariaDB, SQL Server, Oracle, SQLite und MongoDB. Der Connector erzeugt Tools für Schema, Beispiele und Abfragen; du entscheidest, ob das Modell selbst SQL schreibt oder nur die Parameter von Abfragen ausfüllt, die du vorgegeben hast. Gib ihm einen Datenbankbenutzer mit reinem Lesezugriff und eine Rolle, die nur die Tools sieht, die sie wirklich braucht. [Dokumentation zum Datenbank-Connector](docs/connectors/database.md) · [Anleitung](https://anythingmcp.com/de/guides/database-to-mcp)

<a id="graphql-to-mcp"></a>

### GraphQL zu MCP

Per Introspection werden die Queries und Mutations eines GraphQL-Endpunkts zu MCP-Tools, oder du definierst die Operationen selbst. [Dokumentation zum GraphQL-Connector](docs/connectors/graphql.md) · [Anleitung](https://anythingmcp.com/de/guides/graphql-to-mcp)

<a id="postman-collection-to-mcp"></a>

### Postman-Collection zu MCP

Importiere eine Postman-Collection im Format v2.1: Ordner, Authentifizierung, Body-Modi und `{{variables}}` werden übernommen, und jeder Request wird zu einem Tool. Mit cURL-Befehlen funktioniert es genauso. [Dokumentation zum Postman-Import](docs/connectors/rest.md#from-postman-collection)

---

<a id="erp-connectors"></a>

## ERP-Connectors

Fertige Adapter für die ERP-Systeme, in denen die meisten Fragen zu Aufträgen, Beständen und Rechnungen ihre Antwort finden. Adapter installieren, Zugangsdaten eintragen, und die Tools stehen auf deinem MCP-Server bereit. Jeder Name führt zur passenden Einrichtungsanleitung.

| System | Markt | Tools | Was die KI damit kann |
|---|---|---|---|
| [SAP Business One](https://anythingmcp.com/de/guides/connect-sap-business-one-to-claude) | Weltweit | 12 | Geschäftspartner, Artikel, Aufträge, Rechnungen, Angebote, Lieferungen; Kundenaufträge anlegen |
| [SAP S/4HANA Cloud](https://anythingmcp.com/de/guides/connect-sap-s4hana-cloud-to-claude) | Weltweit | 15 | Geschäftspartner, Kundenaufträge und Bestellungen, Fakturen, Lieferungen, Buchungsbelege |
| [Odoo](https://anythingmcp.com/de/guides/connect-odoo-to-claude) | Weltweit | 11 | Jedes Modell: Partner, Kundenaufträge, Rechnungen, Produkte; anlegen und ändern |
| [Microsoft Dynamics NAV](https://anythingmcp.com/de/guides/connect-dynamics-nav-to-claude) | Weltweit | 6 | Jede veröffentlichte OData-Seite: Kunden, Artikel, Kundenaufträge; anlegen und ändern |
| [ERPNext](https://anythingmcp.com/de/guides/connect-erpnext-to-claude) | Weltweit | 11 | Jeder DocType: Kunden, Kundenaufträge, Rechnungen, Artikel, Lagerbestand |
| [Dolibarr](https://anythingmcp.com/de/guides/connect-dolibarr-to-claude) | Weltweit | 10 | Geschäftspartner, Rechnungen, Aufträge, Angebote, Produkte, Lagerbestand |
| [JTL-Wawi](https://anythingmcp.com/de/guides/connect-jtl-wawi-to-claude) † | DE | 9 | Artikel, Bestand pro Lager, Kunden, Kundenaufträge, Lieferungen |
| [Xentral](https://anythingmcp.com/de/guides/connect-xentral-to-claude) | DE | 7 | Artikel, Kunden, Kundenaufträge, Rechnungen, Lagerbestand |
| [weclapp](https://anythingmcp.com/de/guides/connect-weclapp-to-claude) | DACH | 11 | Kunden, Kundenaufträge, Rechnungen, Artikel, Angebote, Verkaufschancen |
| [Sage 100](https://anythingmcp.com/de/guides/connect-sage-100-to-claude) † | DE | 6 | Adressen, Artikel, Verkaufsbelege, jede Entität der Web API |
| [Haufe X360](https://anythingmcp.com/de/guides/connect-haufe-x360-to-claude) † | DE | 7 | Kunden, Lagerartikel, Kundenaufträge, Rechnungen, Lieferungen |
| [ScopeVisio](https://anythingmcp.com/de/guides/connect-scopevisio-to-claude) | DE | 6 | Kontakte, Rechnungen, Projekte, Aufgaben |
| [AFAS Profit](https://anythingmcp.com/de/guides/connect-afas-profit-to-claude) † | NL | 6 | Jeder GetConnector: Debitoren, Rechnungen, Mitarbeitende |
| [Zucchetti](https://anythingmcp.com/de/guides/connect-zucchetti-to-claude) † | IT | 6 | Anagrafiche (Stammdaten), Belege, Artikel |
| [TeamSystem](https://anythingmcp.com/de/guides/connect-teamsystem-to-claude) † | IT | 6 | Kunden, Lieferanten, Rechnungen, Artikel |
| [Axonaut](https://anythingmcp.com/de/guides/connect-axonaut-to-claude) † | FR | 9 | Unternehmen, Rechnungen, Angebote, Ausgaben, Produkte, Projekte |

† Auf Basis der veröffentlichten API-Dokumentation des Herstellers erstellt und noch nicht mit einem echten Mandanten getestet. Wenn du eines dieser Systeme einsetzt, freuen wir uns sehr über einen Erfahrungsbericht oder einen Fix.

**Dein ERP ist nicht dabei, oder es ist eine Eigenentwicklung bzw. läuft on-premises?** Binde es über seine [REST-API](#openapi--rest-api-to-mcp), seine [SOAP-Dienste](#soap--wsdl-to-mcp) oder direkt über seine [SQL-Datenbank](#sql-database-to-mcp) an, mit reinem Lesezugriff. So betreibt [KOCH Freiburg](https://www.kochfreiburg.de/) sein ERP im Produktivbetrieb.

---

<a id="e-commerce--marketplace-connectors"></a>

## E-Commerce- &amp; Marktplatz-Connectors

Shops und Marktplätze, von Amazon und eBay bis zu den Marktplätzen im DACH-Raum. Jeder Name führt zur passenden Einrichtungsanleitung.

| System | Markt | Tools | Was die KI damit kann |
|---|---|---|---|
| [Amazon Seller Central](https://anythingmcp.com/de/guides/connect-amazon-seller-to-claude) | Weltweit | 15 | Bestellungen, Katalog, FBA-Bestand, Angebote, Gebühren, Finanzereignisse, Berichte |
| [WooCommerce](https://anythingmcp.com/de/guides/connect-woocommerce-to-claude) | Weltweit | 49 | Produkte, Varianten, Lagerbestand, Bestellungen, Erstattungen, Kunden, Berichte |
| [Shopware 6](https://anythingmcp.com/de/guides/connect-shopware-6-to-claude) | DACH | 6 | Storefront-Katalog über die Store API: Produkte, Kategorien, Cross-Selling |
| [Magento 2 / Adobe Commerce](https://anythingmcp.com/de/guides/connect-magento-to-claude) | Weltweit | 12 | Produkte, Lagerbestand, Bestellungen, Kunden |
| [BigCommerce](https://anythingmcp.com/de/guides/connect-bigcommerce-to-claude) | Weltweit | 14 | Produkte, Varianten, Bestand, Bestellungen, Kunden |
| [eBay Sell](https://anythingmcp.com/de/guides/connect-ebay-sell-to-claude) | Weltweit | 10 | Bestand, Angebote, Bestellungen, Streitfälle, Preisänderungen |
| [Etsy](https://anythingmcp.com/de/guides/connect-etsy-to-claude) | Weltweit | 9 | Listings, Belege (Bestellungen), Bewertungen |
| [Ecwid](https://anythingmcp.com/de/guides/connect-ecwid-to-claude) | Weltweit | 10 | Produkte, Kategorien, Bestellungen, Kunden |
| [Kaufland Marketplace](https://anythingmcp.com/de/guides/connect-kaufland-to-claude) | DE | 8 | Bestellungen und Bestelleinheiten, Sendungen, Tickets, Storefronts |
| [OTTO Market](https://anythingmcp.com/de/guides/connect-otto-market-to-claude) † | DE | 8 | Bestellungen, Produkte, Retouren, Bestands- und Preisänderungen |
| [Zalando Direct Ship](https://anythingmcp.com/de/guides/connect-zalando-zds-to-claude) † | EU | 7 | Bestellungen, Sendungen, Retouren, Bestand, Preise |
| [Billbee](https://anythingmcp.com/guides/connect-billbee-to-claude) | DACH | 8 | Bestellungen, Produkte, Kunden, Versanddienstleister |
| [Mercado Libre](https://anythingmcp.com/de/guides/connect-mercado-libre-to-claude) | LATAM | 4 | Artikelsuche, Verkäuferbestellungen |

† Auf Basis der veröffentlichten API-Dokumentation des Herstellers erstellt und noch nicht mit einem echten Verkäuferkonto getestet.

---

## Was AnythingMCP verbindet, steuert und lernt

### Verbinden

- **5 Connector-Typen** — [REST](docs/connectors/rest.md), [SOAP](docs/connectors/soap.md), [GraphQL](docs/connectors/graphql.md), [Datenbank](docs/connectors/database.md), [MCP-zu-MCP-Brücke](docs/connectors/mcp-bridge.md). Sieben Datenbank-Engines: PostgreSQL, MySQL, MariaDB, MSSQL, Oracle, MongoDB, SQLite.
- **Vorhandenes importieren** — OpenAPI/Swagger, Postman, cURL, WSDL, GraphQL-Introspection oder die Tool-Erkennung direkt an einem laufenden MCP-Server.
- **Der Adapterkatalog** — [was bereits enthalten ist](#the-adapter-catalog).
- **Visueller Tool-Editor** — ordne Parameter dem Pfad, Query-Parametern, Request-Body und Headern zu. Benenne und beschreibe Tools so, dass die KI sie wie beabsichtigt versteht.
- **Dynamischer MCP-Server** — Tools werden zur Laufzeit registriert, ohne Neustart. `{{VAR}}`-Interpolation pro Connector, für die KI verborgen.

### Steuern

- **[Antworten gezielt formen](#control-what-the-model-sees)** — lege für jedes Tool genau fest, welche Felder das Modell erreichen, mit einer direkten Vorher-Nachher-Vorschau.
- **Nur lesen, wo es darauf ankommt.** Jedes Tool trägt MCP-Annotationen (`readOnlyHint`, `destructiveHint`), die aus der Operation abgeleitet und pro Tool überschrieben werden können. So kann ein Client unterscheiden, ob eine Rechnung gelesen oder eine Gutschrift erstellt wird. Rollenbasierte Tool-Freigaben ermöglichen einen MCP-Server, der ausschließlich lesen darf — für die meisten ERP-Anbindungen der richtige Einstieg.
- **Alle gängigen Authentifizierungsverfahren** — OAuth2 (PKCE und Client Credentials), Bearer, API Key, Basic, HMAC-Signaturen, [LOGIN_TOKEN](docs/connectors/login-token-auth.md) und OAuth 1.0a.
- **Audit-Logging** — jeder Tool-Aufruf wird mit Eingabe, Ausgabe, Dauer und Status in deiner eigenen Datenbank protokolliert.
- **[SSO](docs/sso.md) und [SCIM](docs/scim-entra-setup.md)** — Entra ID, Google, Okta, Auth0 und generisches OIDC. Rollen werden bei jeder Anmeldung mit den Gruppen deines Verzeichnisdienstes synchronisiert. Deaktivierst du dort eine Person, verlieren auch ihr Workspace-Zugriff und ihre MCP-API-Schlüssel ihre Gültigkeit (nur beim Self-Hosting).

### Lernen

- **[Knowledge Graph](docs/knowledge-graph.md)** — eine PII-sichere Übersicht pro Workspace darüber, wie die Daten deiner Connectors zusammenhängen. Sie wird dem Agenten als MCP-Tool bereitgestellt, damit er Aufrufe über mehrere Systeme hinweg richtig verknüpft.
- **[KI-Skills](docs/knowledge-graph.md)** — wiederkehrende Nutzungsmuster werden zu kleinen, wiederverwendbaren Regeln, die in die Anweisungen des Servers einfließen. Sie leiten den Agenten an, ohne einen zusätzlichen Tool-Aufruf zu benötigen (optional, muss aktiviert werden).

---

## AnythingMCP im Vergleich

AnythingMCP ist ein MCP-Gateway, das einen Schritt früher ansetzt: Es erzeugt die MCP-Server aus den APIs, ERP-Systemen und Datenbanken, die du bereits betreibst, und stellt sie dann hinter einem einzigen Endpunkt bereit, mit begrenztem Zugriff und Audit-Log. Die anderen MCP-Gateways bündeln und sichern MCP-Server, die schon vorhanden sind, doch die meisten Unternehmen haben noch gar keine — sondern eine REST-API, einen SOAP-Dienst aus dem Jahr 2009 und eine Datenbank, die niemand direkt zugänglich machen möchte. Jedes der folgenden Projekte löst ein echtes Problem, nur eben nicht dasselbe.

| | Was es ist | Wähle es stattdessen, wenn … |
|---|---|---|
| **[ContextForge](https://github.com/IBM/mcp-context-forge)** (IBM) | Föderation und Registry vor bereits vorhandenen MCP-Servern | Deine Tools bereits MCP-Server sind und du Föderation, virtuelle Server und eine Registry brauchst |
| **[Docker MCP Gateway](https://github.com/docker/mcp-gateway)** | Führt MCP-Server aus einem Katalog als Container hinter einem Endpunkt aus, einschließlich Verwaltung von Geheimnissen | Du von Anbietern veröffentlichte MCP-Server in Docker isolieren möchtest und der vorhandene Katalog deinen Bedarf abdeckt |
| **[MetaMCP](https://github.com/metatool-ai/metamcp)** | Bündelt MCP-Server in Endpunkten mit getrennten Namensräumen und einer Middleware-Schicht | Du hauptsächlich vorhandene MCP-Server pro Client gruppieren und deren Zugriffsbereich neu festlegen möchtest |
| **[Composio](https://github.com/ComposioHQ/composio)** | Ein gehosteter Katalog verwalteter Integrationen, bei dem die Authentifizierung für dich übernommen wird | Dir ein fester verwalteter Katalog genügt und du keinen eigenen SOAP-Dienst, keine interne API und keine eigene Datenbank anbinden musst |
| **AnythingMCP** | Macht die bereits eingesetzten APIs, SOAP-Dienste und Datenbanken zu MCP-Tools | Deine Systeme **noch keine** MCP-Server sind und du selbst entscheiden möchtest, ob die Zugangsdaten bei dir bleiben |

Vergleichsseiten mit vollständigen Funktionstabellen: [anythingmcp.com/vs](https://anythingmcp.com/vs).

---

<a id="knowledge-graph--ai-skills"></a>

## Knowledge Graph &amp; KI-Skills

Das reine Weiterleiten von Aufrufen überlässt dem Agenten den schwierigen Teil: Welches Tool kommt als Nächstes, und was bedeutet in deinem Unternehmen eigentlich „offener Auftrag“ oder „aktiver Kunde“? AnythingMCP lernt beides — **wie die Daten deiner Connectors zusammenhängen** und **wie dein Team die Tools tatsächlich nutzt** — und gibt dieses Wissen als Kontext an den KI-Client zurück, statt zusätzliche Tool-Aufrufe zu erfordern.

- **Knowledge Graph** — eine Übersicht pro Workspace über *Entitäten* (Kunden, Aufträge, Produkte …) und ihre *Beziehungen*. Sie entsteht aus Tool-Namen, Parametern sowie den Ein- und Ausgaben tatsächlicher Aufrufe. Ein optionaler KI-Durchlauf erschließt Verbindungen zwischen Connectors, die Heuristiken übersehen. Der Graph bleibt **PII-sicher**: Er speichert Entitäts- und Feld*namen* sowie Beziehungsmetadaten, niemals die Werte.
- **Visuell aufbauen** — mit einem Graph-Editor kannst du Entitäten und Verbindungen selbst anlegen, bearbeiten und löschen, Beschreibungen ergänzen und KI-Vorschläge prüfen.
- **Über MCP bereitstellen** — jeder Server stellt ein `kg_how_to_obtain`-Tool bereit. Damit kann der Agent *des Kunden* beispielsweise fragen: „Wie komme ich von einer Shopware-Bestellung zu einer DHL-Sendungsnummer?“ und erhält Hinweise zur Verknüpfung der Connectors.
- **KI-Skills aus der tatsächlichen Nutzung** — bei aktivierter Absichtserfassung kann jeder Tool-Aufruf festhalten, *warum* er erfolgte. Ein KI-Durchlauf macht aus wiederkehrenden Mustern kleine, wiederverwendbare Regeln (etwa: *„Der heutige Umsatz umfasst Aufträge mit den Statuswerten 2, 3 und 4“*). Du kannst jede Regel übernehmen, bearbeiten oder verwerfen, oder Vorschläge mit hoher Konfidenz automatisch übernehmen lassen. Übernommene Skills werden beim Bereitstellen in die **Anweisungen** des MCP-Servers eingefügt und leiten den Agenten an, **ohne einen einzigen zusätzlichen Tool-Aufruf**. Das Wissen, das dein Team durch die Nutzung aufbaut, bleibt nicht mehr nur in den Köpfen einzelner Personen.

Die KI-Durchläufe sind **standardmäßig ausgeschaltet**. Du aktivierst sie über ein globales Umgebungsflag *und* einen Schalter im jeweiligen Workspace; unterstützt werden OpenAI, OpenRouter und Anthropic. Der Graph, die manuelle Bearbeitung und das MCP-Tool funktionieren auch ganz ohne LLM-Schlüssel.

➡️ **[Anleitung zu Knowledge Graph &amp; KI-Skills →](docs/knowledge-graph.md)**

---

<a id="control-what-the-model-sees"></a>

## Bestimme, was das Modell sieht

Für jedes Tool lässt sich **genau festlegen, welche Felder deine Infrastruktur verlassen**. Das Mapping wird pro Tool hinterlegt und auf die ausgehende Antwort angewendet. Der KI-Client — und das dahinterliegende Modell eines Drittanbieters — erhält damit nur die von dir freigegebene Datenstruktur.

- **Entferne, was bei dir bleiben soll.** Gib die zu entfernenden Pfade an. Die entsprechenden Felder werden vor der Übergabe an den Agenten herausgefiltert: etwa die IBAN eines Kunden, das Gehalt eines Mitarbeiters oder ein Zugriffstoken, das eine API zusammen mit den Daten zurückgibt.
- **Oder definiere die gesamte Ausgabe.** Eine `select`-Vorlage legt fest, welche Felder erhalten bleiben und wie sie heißen sollen. Für Umformungen, die eine solche Vorlage nicht abdeckt, steht ein JMESPath-Ausdruck zur Verfügung. Wenn eine stabile Struktur für den Agenten hilfreicher ist, ersetze den Wert durch einen Platzhalter (`"iban": "= [redacted]"`), statt das Feld zu entfernen.
- **Prüfe das Ergebnis vor dem Speichern.** Der Editor wendet das Mapping auf eine echte Antwort an und zeigt Original und Ergebnis samt Größenunterschied nebeneinander. Bei einem mitgelieferten Adapter ergibt eine Antwort mit vier Zügen **12.172 B → 1.072 B (−91 %)**.
- **Standardmäßig wird bei Fehlern die Rohantwort weitergegeben — das wird ausdrücklich so benannt.** Schlägt ein Mapping zur Laufzeit fehl, werden die unveränderte Antwort und eine Warnung ausgegeben, damit ein einzelner fehlerhafter Ausdruck ein funktionierendes Tool nicht lahmlegt. Für Felder, die die Infrastruktur unter keinen Umständen verlassen dürfen, ist dieser Standard ungeeignet: Setze bei diesen Tools **`"fallbackToRaw": false`**. Ein fehlerhaftes Mapping lässt dann den Aufruf scheitern, statt die Daten ungefiltert weiterzugeben.

Das bringt zwei Vorteile zugleich: Sensible Felder gelangen nicht zum Modell, und jedes entfernte Feld spart Kosten im Kontextfenster.

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

> Das Audit-Log speichert weiterhin die vollständige Antwort des angebundenen Systems in deiner eigenen Datenbank. Die Begrenzung dessen, was der Agent sieht, geht somit nicht zulasten des Nachweises, was die API tatsächlich zurückgegeben hat.

➡️ **[Referenz zum Response-Mapping →](docs/tool-definition.md#3-response-mapping-optional)**

---

## Eigene Claude-Connectors erstellen — ohne Code

Claude unterstützt **benutzerdefinierte Connectors**: entfernte MCP-Server, die du einmal unter *Customize → Connectors* hinzufügst und anschließend in Claude.ai, Claude Desktop und Claude Code nutzen kannst. AnythingMCP erzeugt einen solchen Connector **aus jeder bereits vorhandenen API** — ohne dass du einen MCP-Server programmieren musst:

1. Importiere deine API-Spezifikation oder wähle einen fertigen Adapter.
2. Passe Tool-Namen, Beschreibungen und Parameter im **visuellen Editor** an — du bestimmst, was die KI sieht.
3. Füge die URL deines MCP-Servers als benutzerdefinierten Connector in Claude hinzu (OAuth 2.0 wird direkt unterstützt).

Deine Zugangsdaten bleiben auf deiner Infrastruktur, jeder Tool-Aufruf erscheint im Audit-Log, und die rollenbasierte Zugriffskontrolle legt fest, welche Benutzer welche Tools sehen. [Schritt-für-Schritt-Anleitung →](docs/integrations/claude.md)

---

## Deine API als ChatGPT-App bereitstellen

**Apps in ChatGPT basieren auf MCP.** AnythingMCP liefert das dazugehörige MCP-Backend, ohne dass du es selbst schreiben musst. Verweise auf deinen REST-, SOAP-, GraphQL- oder Datenbank-Endpunkt, und du erhältst einen für ChatGPT geeigneten Connector. Füge ihn in den ChatGPT-Einstellungen hinzu oder verwende ihn als Tool-Schicht einer Apps-SDK-App, damit ChatGPT deine Geschäftsdaten lesen und mit ihnen arbeiten kann.

Derselbe Connector funktioniert gleichzeitig in **Claude, ChatGPT, Gemini, Copilot und Cursor** — einmal erstellen, überall verbinden. [ChatGPT-Einrichtungsanleitung →](docs/integrations/chatgpt.md)

---

## Warum AnythingMCP?

KI-Clients sprechen MCP, deine Systeme dagegen REST, SOAP, GraphQL und SQL. Einen eigenen MCP-Server pro System zu schreiben und zu warten — einschließlich Authentifizierung, Audit und Zugriffskontrolle — kostet jeweils Wochen. AnythingMCP bildet die No-Code-Schicht dazwischen:

| Problem | Lösung |
|---|---|
| Du hast REST-APIs, aber KI-Clients sprechen MCP | **REST → MCP** mit OpenAPI-/Swagger-Import |
| Du hast ältere SOAP-/WSDL-Dienste | **SOAP → MCP** mit automatischem WSDL-Parsing |
| Du möchtest Datenbanken über KI-Agenten abfragen | **DB → MCP** mit automatisch erzeugten Abfrage-Tools (7 Engines) |
| Du möchtest einen Endpunkt für alle APIs | **MCP-Middleware**, die mehrere Connectors zusammenführt |
| Du brauchst einen MCP-Server für SAP Business One / Odoo / Shopware / … | **Der Adapterkatalog** — in einer Minute installieren und Zugangsdaten hinterlegen |
| Du kannst Zugangsdaten keinem Drittanbieter überlassen | **Betrieb auf deiner Infrastruktur**, Zugangsdaten mit AES-256-GCM verschlüsselt gespeichert |
| Du brauchst Authentifizierung, Audit-Logs und RBAC | **OAuth2, Audit-Log und rollenbasierter Zugriff** sind eingebaut |
| Ein Modell eines Drittanbieters würde jedes Feld der API-Antwort sehen | **[Response-Mapping pro Tool](#control-what-the-model-sees)** — Felder entfernen oder umformen, bevor sie dein Netzwerk verlassen |
| Dein Agent ruft Tools in der falschen Reihenfolge auf oder erkennt Beziehungen zwischen Systemen nicht | **[Knowledge Graph &amp; KI-Skills](#knowledge-graph--ai-skills)** — Hinweise zur Aufrufreihenfolge und erlernte Geschäftsregeln als Kontext |

**Was Menschen damit tatsächlich umsetzen**

| | Anleitungen |
|---|---|
| Mit Claude auf das ERP zugreifen | [SAP Business One](https://anythingmcp.com/de/guides/connect-sap-business-one-to-claude) · [Odoo](https://anythingmcp.com/de/guides/connect-odoo-to-claude) · [weclapp](https://anythingmcp.com/de/guides/weclapp-to-mcp) · [Xentral](https://anythingmcp.com/de/guides/xentral-to-mcp) |
| Bestellungen, Bestände und Gebühren über Shops und Marktplätze hinweg prüfen | [Amazon Seller](https://anythingmcp.com/de/guides/connect-amazon-seller-to-claude) · [WooCommerce](https://anythingmcp.com/de/guides/connect-woocommerce-to-claude) · [Kaufland](https://anythingmcp.com/de/guides/connect-kaufland-to-claude) |
| Pakete verfolgen | [DHL](https://anythingmcp.com/guides/dhl-tracking-to-mcp) · [GLS](https://anythingmcp.com/guides/gls-tracking-to-mcp) |
| Eine Rechnung vor der Zahlung prüfen | [VIES VAT](https://anythingmcp.com/guides/vies-vat-to-mcp) · [Handelsregister](https://anythingmcp.com/guides/handelsregister-to-mcp) |
| Einen KI-Agenten mit reinem Lesezugriff auf eine Produktionsdatenbank ausstatten | [Datenbank-Connectors](docs/connectors/database.md) |
| Einen SOAP-Dienst aus dem Jahr 2009 mit einem Modell von 2026 verbinden | [SOAP → MCP](https://anythingmcp.com/guides/soap-to-mcp) |
| Zugverbindungen, aktuelle Verspätungen und Routen abfragen | [Deutsche Bahn](https://anythingmcp.com/guides/deutsche-bahn-to-mcp) |

---

<a id="the-adapter-catalog"></a>

## Der Adapterkatalog

258 Adapter mit mehr als 2.400 Tools. **21 benötigen keinen API-Schlüssel**. Bei den übrigen gibst du deine Zugangsdaten beim Import an; danach stehen die Tools sofort bereit. Für jeden Adapter gibt es auf [anythingmcp.com/guides](https://anythingmcp.com/guides) eine Einrichtungsanleitung in sieben Sprachen.

| Kategorie | Beispiele |
|---|---|
| 📦 Logistik &amp; Versand | Deutsche Bahn, DHL, DPD, GLS, Shipcloud, Sendcloud |
| 💼 ERP, Buchhaltung &amp; Rechnungsstellung | [SAP Business One, Odoo, weclapp, Xentral und 12 weitere ERP-Systeme](#erp-connectors), Lexware Office, sevDesk, Exact Online, bexio |
| 🛍️ E-Commerce | [Amazon Seller, WooCommerce, Shopware 6, Kaufland, OTTO und 8 weitere](#e-commerce--marketplace-connectors), Oxomi |
| 👥 Personalwesen &amp; Außendienst | Personio, HRWorks, Kenjo, MFR Mobile Field Report |
| 🏛️ Behörden &amp; öffentliche Daten | VIES VAT, Handelsregister, UK Companies House 🇬🇧, DESTATIS, Bundesbank, OpenPLZ, NINA |
| 🏦 Banking &amp; Zahlungen | Revolut Business, Wise 🇬🇧, PAYONE, Razorpay 🇮🇳, Paystack 🇳🇬 |
| 💬 Messaging &amp; Kommunikation | WhatsApp, LINE 🇯🇵, TeamViewer |
| 🎾 Sport &amp; Web3 | Playtomic, Sorare |
| 🏗️ Bauwesen &amp; Karten | PlanRadar, HERE Geocoding |

**Ein Adapter besteht aus einer einzigen JSON-Datei.** Deshalb konnte der Katalog so groß werden, und deshalb eignet sich ein neuer Adapter gut als erster Beitrag. Fehlt deiner? [Schlage ihn vor](https://github.com/HelpCode-ai/anythingmcp/issues/new?template=adapter_request.yml) — wir priorisieren nach 👍 — oder [erstelle ihn selbst](CONTRIBUTING.md).

---

## Anleitungen, Client-Einrichtung &amp; FAQ

➡️ **[docs/guides.md](docs/guides.md)** — Einrichtung von Claude / ChatGPT / Gemini / Copilot / Cursor · Anleitungen für REST-, SOAP-, GraphQL-, Datenbank- und MCP-Brücken-Connectors · API-Referenz &amp; Deployment-Dokumentation · FAQ.

Du suchst einen bestimmten Dienst? Für jeden Adapter gibt es eine Schritt-für-Schritt-Anleitung auf **[anythingmcp.com/guides](https://anythingmcp.com/guides)**.

<a id="faq"></a>

## FAQ

**Wie verbinde ich mein ERP (SAP Business One, Odoo, Xentral …) mit Claude oder ChatGPT?**
Installiere den Adapter deines ERP-Systems aus dem [Katalog](#erp-connectors), trage die API-Zugangsdaten ein und füge die URL deines MCP-Servers in Claude als benutzerdefinierten Connector oder in ChatGPT als App hinzu. Gibt es für dein ERP keinen Adapter, bindest du seine REST- oder SOAP-API oder seine SQL-Datenbank direkt an. Fang mit einer Rolle an, die nur lesen darf.

**Wie mache ich aus einer OpenAPI-Spezifikation einen MCP-Server?**
Lege einen REST-Connector an und importiere die Spezifikation per URL oder durch Einfügen. Jede Operation wird zu einem MCP-Tool am `/mcp`-Endpunkt deines Servers, ganz ohne Code. [So funktioniert es](docs/connectors/rest.md#from-openapi--swagger).

**Kann ich einen SOAP-/WSDL-Dienst mit Claude verbinden?**
Ja. AnythingMCP liest die WSDL ein, macht aus jeder Operation ein Tool und baut bei jedem Aufruf den SOAP-Envelope, auch für WCF-Dienste. Authentifiziert wird per HTTP Basic, Bearer oder API-Key-Header; WS-Security-Header sind noch nicht implementiert. [Dokumentation zum SOAP-Connector](docs/connectors/soap.md).

**Kann Claude meine SQL-Server-, Oracle- oder PostgreSQL-Datenbank sicher abfragen?**
Verwende einen Datenbankbenutzer, der ausschließlich SELECT-Rechte hat, setze nach Möglichkeit auf statische Abfragen, bei denen das Modell nur die Parameter liefert, und gib die Tools pro Rolle gezielt frei. Das Response-Mapping entfernt die Spalten, die das Modell nicht erreichen dürfen, und jede Abfrage landet im Audit-Log in deiner eigenen Datenbank.

**Wie verbinde ich Shopware, WooCommerce oder Amazon Seller Central mit Claude?**
Installiere den [E-Commerce-Adapter](#e-commerce--marketplace-connectors) für deinen Shop oder Marktplatz und autorisiere ihn. WooCommerce bringt 49 Tools mit, Amazon Seller Central nutzt die offizielle Selling Partner API, und der Shopware-6-Adapter liest den Storefront-Katalog über die Store API.

**Ist AnythingMCP ein MCP-Gateway? Selbst gehostet und kostenlos?**
Dreimal ja: ein MCP-Endpunkt vor allen Connectors, mit OAuth2, RBAC, SSO und Audit. Es läuft unter AGPL-3.0 auf deinen eigenen Servern, kommerzielle Nutzung eingeschlossen; [AnythingMCP Cloud](https://cloud.anythingmcp.com) ist die optionale gehostete Variante.

**Worin unterscheidet es sich von Composio?**
Composio ist ein gehosteter Katalog verwalteter Integrationen. AnythingMCP macht zusätzlich deine eigenen internen APIs, SOAP-Dienste und Datenbanken zu Tools und kann sämtliche Zugangsdaten auf deiner Infrastruktur halten. [Ausführlicher Vergleich](https://anythingmcp.com/de/vs/alternatives-to-composio).

---

## Community &amp; Unterstützung

- 💬 **Fragen &amp; Diskussionen** — [GitHub Discussions](https://github.com/HelpCode-ai/anythingmcp/discussions) — stimme über den nächsten Adapter ab und zeige, was du gebaut hast.
- 🐛 **Fehler / 💡 Funktionswünsche** — [Issues](https://github.com/HelpCode-ai/anythingmcp/issues) · 🆘 [SUPPORT.md](SUPPORT.md)
- 🔐 **Sicherheit** — eröffne dafür bitte kein öffentliches Issue; befolge [SECURITY.md](SECURITY.md).
- 🏢 Entwickelt von [helpcode.ai](https://helpcode.ai) in Freiburg, Deutschland. KI-gestützte Entwicklung mit menschlicher Prüfung — [AUTHORS.md](AUTHORS.md) beschreibt, welche Teile das betrifft und wie wir vorgehen.

## Mitwirken

Lies die [Beitragsrichtlinien](CONTRIBUTING.md), bevor du einen PR eröffnest. Der einfachste nützliche Beitrag ist ein Adapter: eine JSON-Datei. Dazu gibt es ein [Issue mit einer Schritt-für-Schritt-Anleitung](https://github.com/HelpCode-ai/anythingmcp/issues/150).

## License

**Open source** under the [GNU Affero General Public License v3](LICENSE) (AGPL-3.0-only). Commercial use inside your own company is included and always was; the copyleft obligation only starts if you modify AnythingMCP and offer the modified version to others over a network. Cloud-operator code under `ee/` is separately licensed and is not required for self-hosting — see the [License FAQ](docs/license-faq.md).


---

<p align="center">
  <strong>⭐ Wenn dir das eine Woche MCP-Server-Entwicklung erspart hat, gib dem Projekt einen Stern.</strong><br/>
  <em>Über Sterne finden andere das Projekt — und wir entscheiden daran mit, welchen Adapter wir als Nächstes entwickeln.</em>
</p>

<p align="center">
  <a href="https://star-history.com/#HelpCode-ai/anythingmcp&Date">
    <img src="https://api.star-history.com/svg?repos=HelpCode-ai/anythingmcp&type=Date" alt="Entwicklung der Sterne" width="70%">
  </a>
</p>

<p align="center">
  <a href="https://github.com/HelpCode-ai/anythingmcp/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=HelpCode-ai/anythingmcp" alt="Mitwirkende">
  </a>
</p>
