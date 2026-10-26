### Gibt es einen Sage 100 MCP-Server?
Ja. AnythingMCP stellt einen Sage 100-Connector bereit, der Sage 100 ueber 6 MCP-Tools bereitstellt - darunter ein generisches, schreibgeschutztes `query`-Tool - auf AnythingMCP Cloud oder auf Ihrem eigenen Docker-Host.

### Wie verbinde ich Sage 100 mit Claude oder ChatGPT?
Installieren Sie den AnythingMCP-Connector, geben Sie Ihre Sage 100-API-Basis-URL und Zugangsdaten ein und fuegen Sie die entstandene MCP-Server-URL bei Ihrem KI-Client als benutzerdefinierten Connector hinzu.

### Was kann das query-Tool?
Es fuehrt schreibgeschutzte Abfragen gegen die erlaubten Sage 100-Endpunkte aus. Kombinieren Sie es mit `metadata`, um verfuegbare Felder und Objekttypen zu entdecken, bevor Sie Fragen stellen.

### Kann die KI Daten in Sage 100 aendern?
Nein. Alle 6 Tools sind schreibgeschutzt, daher kann die KI Artikel, Adressen, Dokumente lesen und Abfragen ausfuehren, aber keine Datensaetze anlegen oder aendern. Schraenken Sie die Zugangsdaten auf einen lesenden Sage 100-Benutzer ein.

### Funktioniert es auch mit ChatGPT und Copilot?
Ja. Dieselbe MCP-Server-URL funktioniert in ChatGPT (als App oder Connector, benoetigt eine oeffentliche HTTPS-URL wie AnythingMCP Cloud), GitHub Copilot in VS Code, Cursor und jedem anderen MCP-Client.

### Verlaesst Sage 100-Daten meine Infrastruktur?
Bei Selbsthosting verbleiben Zugangsdaten und Audit-Log auf Ihrem Server; nur die Felder, die ein Tool zurueckgibt, gehen an das genutzte KI-Modell. Mit Response-Mapping koennen Sie sensible Felder entfernen.
