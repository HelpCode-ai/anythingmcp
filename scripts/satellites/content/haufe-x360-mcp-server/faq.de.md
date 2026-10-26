### Gibt es einen Haufe X360 MCP-Server?
Ja. AnythingMCP stellt einen Haufe X360-Connector bereit, der Haufe X360-Daten ueber 7 schreibgeschutzte MCP-Tools (Kunden, Auftraege, Lagerartikel, Rechnungen, Lieferungen und Lieferanten) bereitstellt - auf AnythingMCP Cloud oder auf Ihrem eigenen Docker-Host.

### Wie verbinde ich Haufe X360 mit Claude oder ChatGPT?
Installieren Sie den AnythingMCP-Connector, geben Sie Ihre Haufe X360-API-Zugangsdaten (Mandant plus Client-ID und Secret) ein und fuegen Sie die entstandene MCP-Server-URL bei Ihrem KI-Client als benutzerdefinierten Connector hinzu.

### Wo finde ich die Zugangsdaten?
In den Haufe X360-API-Einstellungen Ihres Mandanten: registrieren Sie eine Anwendung und erzeugen Sie eine Client-ID und ein Secret.

### Kann die KI Daten in Haufe X360 aendern?
Nein. Alle 7 Tools sind schreibgeschutzt, daher kann die KI Kunden, Auftraege, Lager, Rechnungen, Lieferungen und Lieferanten lesen, aber keine Datensaetze anlegen oder aendern. Das Token traegt die Rechte des zugehoerigen Haufe X360-Benutzers - schraenken Sie es auf das fuer die KI Sichtbare ein.

### Funktioniert es auch mit ChatGPT und Copilot?
Ja. Dieselbe MCP-Server-URL funktioniert in ChatGPT (als App oder Connector, benoetigt eine oeffentliche HTTPS-URL wie AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor und jedem anderen MCP-Client.

### Verlaesst Haufe X360-Daten meine Infrastruktur?
Bei Selbsthosting verbleiben Zugangsdaten und Audit-Log auf Ihrem Server; nur die Felder, die ein Tool zurueckgibt, gehen an das genutzte KI-Modell. Mit Response-Mapping koennen Sie sensible Felder entfernen.
