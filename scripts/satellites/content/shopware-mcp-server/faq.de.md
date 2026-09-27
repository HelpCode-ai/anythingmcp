### Gibt es einen MCP-Server für Shopware?
Ja, diesen hier. Er verbindet die Store API von Shopware 6 über AnythingMCP mit Claude, ChatGPT und Copilot: 6 Tools für Produktsuche, Produktdetails, Kategorien, Suchvorschläge und Cross-Sellings.

### Kann er Bestellungen oder Kunden lesen?
Nein. Die Store API ist die Schnittstelle des Storefronts und sieht den Katalog, nicht das Backend. Bestellungen und Kunden liegen in der Admin API, die dieser Connector nicht nutzt.

### Was brauche ich für die Verbindung?
Die Shop-URL und den Zugangsschlüssel des Verkaufskanals (Verkaufskanäle → dein Storefront → API-Zugang).

### Kann die KI Preise oder Produkte ändern?
Nein. Alle sechs Tools lesen nur.
