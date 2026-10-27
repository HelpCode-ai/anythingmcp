### Gibt es einen MCP-Server für JTL-Wawi?
Ja, diesen hier. Er stellt die REST-API v1 von JTL-Wawi über AnythingMCP als 10 MCP-Tools bereit: Lager, Artikel, Bestände pro Lager, Kunden, Aufträge, Auftragspositionen und Lieferscheine mit Sendungsverfolgung.

### Warum brauche ich den JTL API Server?
JTL-Wawi selbst ist eine Windows-Anwendung auf SQL Server und spricht von Haus aus kein HTTP. Der separate Dienst **JTL API Server** wird neben der Wawi-Datenbank installiert und stellt die REST-Endpunkte unter `/api/eazybusiness/v1` bereit, die dieser Connector aufruft.

### Wie bekomme ich den API-Key in JTL-Wawi?
Öffne in JTL-Wawi **Admin → App-Registrierung**, registriere die Anwendung über `/api/eazybusiness/authentication` mit `AppId` und Version und gib die Anfrage in der Wawi frei. Trage anschließend `JTL_WAWI_URL`, `JTL_WAWI_API_KEY`, `JTL_WAWI_APP_ID` und `JTL_WAWI_APP_VERSION` im Connector ein.

### Kann die KI Daten in JTL-Wawi ändern?
Nein. Alle 10 Tools senden ausschließlich HTTP-GET-Anfragen — Claude und ChatGPT können Artikel, Bestände, Kunden, Aufträge und Lieferscheine lesen, aber nichts in JTL-Wawi anlegen oder ändern.

### Wie binde ich eine lokale JTL-Wawi im Firmennetz an?
Wenn der JTL API Server nur intern erreichbar ist, betreibe AnythingMCP per Docker im selben Netz und trage den Hostnamen in `SSRF_ALLOWED_HOSTS` ein. Für AnythingMCP Cloud muss der JTL API Server öffentlich per HTTPS mit gültigem TLS-Zertifikat erreichbar sein.

### Funktioniert das auch mit ChatGPT und Copilot?
Ja. Dieselbe MCP-Server-URL funktioniert in Claude, ChatGPT (über eine öffentliche HTTPS-URL wie AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor und Claude Code.
