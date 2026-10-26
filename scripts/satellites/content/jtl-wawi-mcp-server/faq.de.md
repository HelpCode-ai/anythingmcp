### Gibt es einen JTL-Wawi MCP-Server?
Ja. AnythingMCP stellt einen JTL-Wawi-Connector bereit, der JTL-Wawi-Daten ueber 10 schreibgeschutzte MCP-Tools (Lager, Artikel, Artikelbestand, Kunden, Auftraege, Auftragspositionen und Lieferungen) bereitstellt - auf AnythingMCP Cloud oder auf Ihrem eigenen Docker-Host.

### Wie verbinde ich JTL-Wawi mit Claude oder ChatGPT?
JTL-Wawi spricht nur ueber den separaten **JTL-API-Server** (ein Windows-Dienst neben JTL-Wawi) per HTTP. Installieren Sie den AnythingMCP-Connector, richten Sie ihn auf die JTL-API-Server-URL und tragen Sie den API-Schluessel ein. Fuegen Sie die entstandene MCP-Server-URL bei Claude, ChatGPT oder Copilot als benutzerdefinierten Connector hinzu.

### Wo finde ich den API-Schluessel?
In der JTL-API-Server-Verwaltung: legen Sie einen API-Benutzer an und kopieren Sie dessen Schluessel. Der JTL-API-Server muss von dem Ort aus erreichbar sein (Lokalnetz oder Tunnel), an dem AnythingMCP laeuft.

### Kann die KI Daten in JTL-Wawi aendern?
Nein. Alle 10 Tools sind HTTP-GET-Anfragen, daher kann die KI Bestaende, Auftraege, Kunden und Lieferungen lesen, aber keine Datensaetze anlegen oder aendern. Verwenden Sie einen JTL-Wawi-Benutzer, der nur sieht, was die KI sehen soll.

### Funktioniert es auch mit ChatGPT und Copilot?
Ja. Dieselbe MCP-Server-URL funktioniert in ChatGPT (als App oder Connector, benoetigt eine oeffentliche HTTPS-URL wie AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor und jedem anderen MCP-Client.

### Verlaesst JTL-Wawi-Daten meine Infrastruktur?
Bei Selbsthosting verbleiben Zugangsdaten und Audit-Log auf Ihrem Server; nur die Felder, die ein Tool zurueckgibt, gehen an das genutzte KI-Modell. Mit Response-Mapping koennen Sie Felder wie Preise oder Kundendaten entfernen.
