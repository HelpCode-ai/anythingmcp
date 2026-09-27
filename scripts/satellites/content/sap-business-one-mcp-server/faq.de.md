### Gibt es einen MCP-Server für SAP Business One?
Ja, diesen hier. Er verbindet den Service Layer von SAP Business One über AnythingMCP mit Claude, ChatGPT und Copilot: 12 Tools für Geschäftspartner, Artikel, Aufträge, Ausgangsrechnungen, Angebote und Lieferscheine, dazu das Anlegen von Aufträgen.

### Was brauche ich für die Verbindung?
Host und Port des Service Layers (meist 50000), den Namen der Firmendatenbank und einen B1-Benutzer mit API-Zugriff.

### Kann die KI Belege anlegen oder ändern?
Sie kann mit `b1_create_order` Aufträge anlegen; alles andere liest nur. Nimm das Tool aus der Rolle des MCP-Servers, wenn die KI nur lesen soll.

### Ist das mit einem echten SAP-B1-System getestet?
Noch nicht. Der Adapter folgt der Service-Layer-Dokumentation von SAP; Rückmeldungen sind willkommen.
