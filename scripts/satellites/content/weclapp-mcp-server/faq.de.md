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
