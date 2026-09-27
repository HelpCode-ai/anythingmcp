### Gibt es einen MCP-Server für Billbee?
Ja, diesen hier. Er verbindet Billbee über AnythingMCP mit Claude, ChatGPT und Copilot: 8 Tools für Bestellungen, Artikel, Kunden und Versandanbieter.

### Was brauche ich für die Verbindung?
Drei Werte: einen API-Key, den du bei Billbee beantragst, die E-Mail-Adresse deines Logins und ein eigenes API-Passwort, das du in Billbee unter **Einstellungen → Billbee API** festlegst. Alle drei sind nötig.

### Kann die KI Bestellungen in Billbee ändern?
Nein. Alle 8 Tools lesen nur.

### Kann ich eine Bestellung über die Marktplatz-Bestellnummer finden?
Ja. `billbee_get_order_by_extref` findet eine Billbee-Bestellung über die externe Referenz von Amazon, eBay, Kaufland, OTTO oder deinem Shop.
