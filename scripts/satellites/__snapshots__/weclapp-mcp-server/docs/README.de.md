# weclapp MCP Server

[English](../README.md) · **Deutsch**

**Verbinde weclapp mit Claude, ChatGPT und Copilot: kunden, Aufträge, Rechnungen, Artikel, Angebote und Verkaufschancen als MCP-Tools.** Basiert auf [AnythingMCP](https://github.com/HelpCode-ai/anythingmcp).

weclapp MCP Server gibt Claude, ChatGPT, Copilot und Cursor 11 Tools für weclapp: kunden, Aufträge, Rechnungen, Artikel, Angebote und Verkaufschancen. Alle Tools lesen nur. Es läuft auf AnythingMCP: mit einem Klick in AnythingMCP Cloud oder selbst gehostet mit Docker. Zugangsdaten werden verschlüsselt gespeichert, jeder Aufruf landet im Audit-Log.

**Zuletzt geprüft:** 2026-09-26 gegen die weclapp REST-API v2 (Produktivbetrieb auf AnythingMCP Cloud: mehr als 1.000 erfolgreiche Tool-Aufrufe in den letzten 90 Tagen).  
**Adapter synchronisiert:** <!-- synced -->2026-09-26

Maintained by [KOCH Freiburg GmbH](https://www.kochfreiburg.de/), which runs AnythingMCP in production. Built on [AnythingMCP](https://github.com/HelpCode-ai/anythingmcp) by helpcode.ai.

## Schnellstart (AnythingMCP Cloud)

1. Melde dich bei [cloud.anythingmcp.com](https://cloud.anythingmcp.com) an und öffne den [Installationslink](https://cloud.anythingmcp.com/connectors/store?install=weclapp).
2. Trage `WECLAPP_TENANT`, `WECLAPP_API_TOKEN` ein (siehe [Authentifizierung](#authentifizierung)).
3. Kopiere die URL deines MCP-Servers unter **MCP Servers** und füge sie in deinen KI-Client ein ([siehe unten](#claude-chatgpt-copilot-oder-cursor-verbinden)).

AnythingMCP Cloud ist derselbe Open-Source-Code, betrieben von helpcode.ai in Frankfurt.

## Selbst gehostet (Docker)

Benötigt Docker 24+, openssl und Node 18+.

```bash
git clone https://github.com/kochfreiburg/weclapp-mcp-server.git
cd weclapp-mcp-server
./scripts/install.sh
```

`install.sh` schreibt `.env` mit neuen Secrets, startet AnythingMCP, legt den ersten Admin an, installiert den Connector, sofern `WECLAPP_TENANT` und `WECLAPP_API_TOKEN` in `.env` gesetzt sind, und erzeugt einen MCP-API-Key. Ohne Zugangsdaten gibt es stattdessen den Installationslink aus: `http://localhost:3000/connectors/store?install=weclapp`. Danach die ganze Kette prüfen:

```bash
npm install && node scripts/smoke.mjs
```

## Claude, ChatGPT, Copilot oder Cursor verbinden

- **Claude (claude.ai, Desktop, Mobil):** *Customize → Connectors → Add custom connector*, MCP-Server-URL einfügen und anmelden. Claude verbindet sich aus der Cloud von Anthropic, die URL muss also öffentlich per HTTPS erreichbar sein: deine AnythingMCP-Cloud-URL oder deine eigene Instanz mit TLS.
- **Claude Code:**

  ```bash
  claude mcp add --transport http weclapp-mcp-server http://localhost:4000/mcp --header "X-API-Key: <MCP_API_KEY>"
  ```
- **Cursor** (`.cursor/mcp.json`) und **VS Code / GitHub Copilot** (`.vscode/mcp.json`, Schlüssel `servers` statt `mcpServers`, dazu `"type": "http"`):

  ```json
  { "mcpServers": { "weclapp-mcp-server": { "url": "http://localhost:4000/mcp", "headers": { "X-API-Key": "<MCP_API_KEY>" } } } }
  ```
- **ChatGPT:** die öffentliche HTTPS-URL in den ChatGPT-Einstellungen als Connector (App) hinzufügen. Eine `localhost`-URL funktioniert dort nicht.

## Tools

11 Tools, erzeugt aus [`adapter/weclapp.json`](../adapter/weclapp.json). Tools mit **lesen** können im Quellsystem nichts ändern.

<!-- tools:start (generated from adapter/*.json, do not edit) -->
| Tool | Funktion | Zugriff |
|---|---|---|
| `weclapp_list_customers` | List parties (customers/suppliers/contacts) from weclapp ERP. | lesen |
| `weclapp_get_customer` | Get a specific party (customer/supplier/contact) by ID. | lesen |
| `weclapp_list_sales_orders` | List sales orders from weclapp ERP. | lesen |
| `weclapp_list_invoices` | List sales invoices from weclapp ERP. | lesen |
| `weclapp_list_articles` | List articles (products) from weclapp ERP. | lesen |
| `weclapp_get_article` | Get a specific article (product) by ID, including stock, pricing, and warehouse data. | lesen |
| `weclapp_list_quotations` | List sales quotations (Angebote) from weclapp ERP. | lesen |
| `weclapp_get_quotation` | Get a single sales quotation (Angebot) by ID, including positions, amounts and status. | lesen |
| `weclapp_list_recurring_invoices` | List recurring invoices (wiederkehrende Rechnungen / Abo-Rechnungen) from weclapp ERP — the templates that periodically generate sales invoices. | lesen |
| `weclapp_get_recurring_invoice` | Get a single recurring invoice (wiederkehrende Rechnung) by ID, including its interval, next execution date and template positions. | lesen |
| `weclapp_list_opportunities` | List sales opportunities (Verkaufschancen) from weclapp CRM. | lesen |
<!-- tools:end -->

## Beispiel-Prompts

- Welche Kunden haben offene Aufträge über 5.000 EUR?
- Zeig mir die letzten fünf Rechnungen von Müller GmbH und ob sie bezahlt sind.
- Welche Rechnungen sind überfällig, und seit wie vielen Tagen?
- Welche Angebote aus diesem Monat hat der Kunde noch nicht angenommen?
- Wie ist der Bestand von Artikel 10045, und was kostet er?
- Welche Verkaufschancen gibt es, gruppiert nach Phase und erwartetem Wert?

Weitere (auf Englisch) in [examples/prompts.md](../examples/prompts.md).

## Authentifizierung

Der Connector braucht zwei Werte:

| Variable | Wo du sie findest |
|---|---|
| `WECLAPP_TENANT` | Die Subdomain deiner weclapp-URL: `deinefirma` in `deinefirma.weclapp.com` |
| `WECLAPP_API_TOKEN` | weclapp → **Meine Einstellungen → API-Tokens** → Token erzeugen |

Der Token geht als Header `AuthenticationToken` an `https://<mandant>.weclapp.com/webapp/api/v2`. Er handelt mit den Rechten des weclapp-Benutzers, der ihn erstellt hat. Erstelle ihn also mit einem Benutzer, der nur die Daten sieht, die die KI sehen soll.

## Sicherheit

- **Lesen oder schreiben entscheidest du.** Alle 11 Tools lesen nur. Weise den Connector einem MCP-Server zu, dessen Rolle nur die gewünschten Tools freigibt; die anderen sieht dieser Client gar nicht.
- **Zugangsdaten** werden mit AES-256-GCM verschlüsselt und nie an das Modell gegeben.
- **Response-Mapping** entfernt oder formt Felder pro Tool, bevor sie das Modell erreichen, etwa Bankdaten oder personenbezogene Daten.
- **Audit-Log:** Jeder Aufruf wird mit Eingabe, Ausgabe, Dauer und Status protokolliert, selbst gehostet in deiner eigenen Datenbank.
- **SSO, RBAC und SCIM** sind in der selbst gehosteten Version enthalten.

## FAQ

### Gibt es einen MCP-Server für weclapp?
Ja, diesen hier. Er stellt die REST-API v2 von weclapp als 11 MCP-Tools bereit (Parteien, Aufträge, Rechnungen, Artikel, Angebote, Abo-Rechnungen und Verkaufschancen), über AnythingMCP Cloud oder auf deinem eigenen Docker-Host.

### Wie verbinde ich weclapp mit Claude?
Installiere den Connector (ein Klick in AnythingMCP Cloud oder `./scripts/install.sh`), trage Mandant und API-Token ein und füge die URL deines MCP-Servers in Claude als benutzerdefinierten Connector hinzu.

### Wo finde ich den weclapp API-Token?
In weclapp unter **Meine Einstellungen → API-Tokens**. Der Mandant ist die Subdomain deiner weclapp-URL: `deinefirma` in `deinefirma.weclapp.com`.

### Kann die KI Daten in weclapp ändern?
Mit diesem Connector nicht: Alle 11 Tools sind HTTP-GET-Anfragen, Claude kann also lesen, aber nichts anlegen oder ändern. Der Token hat trotzdem die Rechte des weclapp-Benutzers, der ihn erstellt hat. Nimm also einen Benutzer, der nur sieht, was die KI sehen soll.

### Funktioniert das auch mit ChatGPT und Copilot?
Ja. Dieselbe MCP-URL funktioniert in ChatGPT (braucht eine öffentliche HTTPS-URL, etwa AnythingMCP Cloud), in GitHub Copilot in VS Code, in Cursor und in jedem anderen MCP-Client.

## Fehlerbehebung

| Problem | Lösung |
|---|---|
| `401` / `403` vom Hersteller | Zugangsdaten falsch oder ohne Rechte. Auf der Connector-Seite neu eintragen; der Import macht einen Testaufruf und zeigt das Ergebnis. |
| Tools fehlen im KI-Client | Der Connector ist nicht dem MCP-Server zugewiesen, den der Client nutzt. **MCP Servers** prüfen, dann `node scripts/smoke.mjs` ausführen. |
| Das System steht im internen Netz | AnythingMCP in diesem Netz selbst hosten und den Hostnamen in `SSRF_ALLOWED_HOSTS` eintragen, sonst blockiert der Outbound-Guard den Aufruf. |
| Lokal ok, in AnythingMCP Cloud nicht | Das System muss aus dem Internet mit gültigem TLS-Zertifikat erreichbar sein. |
| Jeder Aufruf scheitert, die URL enthält `.weclapp.com.weclapp.com` | `WECLAPP_TENANT` ist nur die Subdomain: `acme`, nicht `acme.weclapp.com` oder die ganze URL. |
| `401`, obwohl der Token im Browser funktioniert | Es muss ein API-Token aus **Meine Einstellungen → API-Tokens** sein, nicht dein Passwort oder ein Session-Cookie. |

## Verwandte Repositories

- [erp-mcp-server](https://github.com/HelpCode-ai/erp-mcp-server): ERP MCP server: connect 16 ERPs (SAP, Odoo, JTL-Wawi, Xentral, weclapp, ERPNext…) to Claude & ChatGPT. Self-hosted or cloud.
- [xentral-mcp-server](https://github.com/kochfreiburg/xentral-mcp-server): Xentral MCP server: connect Xentral ERP to Claude & ChatGPT. Articles, customers, sales orders, invoices and stock as AI tools.
- [billbee-mcp-server](https://github.com/kochfreiburg/billbee-mcp-server): Billbee MCP server: connect Billbee order management to Claude & ChatGPT. Orders, products, customers and shipping providers.
- [sap-business-one-mcp-server](https://github.com/HelpCode-ai/sap-business-one-mcp-server): SAP Business One MCP server: Claude & ChatGPT read partners, items, orders, invoices and quotations, and create sales orders.
- [AnythingMCP](https://github.com/HelpCode-ai/anythingmcp): der Open-Source-MCP-Server und -Gateway, auf dem dieses Repository aufbaut.

## Lizenz

Noch nicht entschieden.
