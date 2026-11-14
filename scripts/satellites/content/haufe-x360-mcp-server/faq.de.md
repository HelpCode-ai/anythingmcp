### Gibt es einen MCP-Server für Haufe X360?
Ja, diesen hier. Er verbindet Haufe X360 (früher Lexbizz, auf Basis von Acumatica) über AnythingMCP mit Claude, ChatGPT und Copilot: 7 lesende Tools für Kunden, Lieferanten, Lagerartikel, Verkaufsaufträge, Ausgangsrechnungen und Lieferungen.

### Welche Zugangsdaten brauche ich für Haufe X360?
Du benötigst die Basis-URL deiner X360-Instanz (`X360_URL`), den Mandanten (`X360_TENANT`), die Version des Default-Webservice-Endpunkts (`X360_ENDPOINT_VERSION`, z. B. `24.200.001` aus Maske SM207060) sowie einen eigenen X360-Benutzer (`X360_USERNAME` und `X360_PASSWORD`).

### Wie geht der Connector mit dem API-Session-Limit von X360 um?
Die Lizenz in Haufe X360 begrenzt die Anzahl gleichzeitiger API-Sitzungen. Der Connector meldet sich über `/entity/auth/login` an, hält genau eine Sitzung offen und erneuert das Session-Cookie automatisch vor Ablauf oder bei einem `401`.

### Kann die KI Belege in Haufe X360 anlegen oder freigeben?
Nein. Alle 7 Tools führen ausschließlich lesende HTTP-GET-Abfragen auf der Contract-based REST-API aus, und Haufe X360 prüft zusätzlich die Rollen- und Maskenrechte des hinterlegten Benutzers.

### Ist der Connector gegen einen Live-Mandanten von Haufe X360 getestet?
Noch nicht: Der Adapter folgt der Spezifikation des Acumatica-/Haufe-X360-Default-Endpunkts. Rückmeldungen aus dem Einsatz mit einem echten X360-Mandanten sind sehr willkommen.

### Funktioniert das auch mit ChatGPT und Copilot?
Ja. Dieselbe MCP-Server-URL funktioniert in Claude, ChatGPT (über eine öffentliche HTTPS-URL wie AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor und Claude Code.
