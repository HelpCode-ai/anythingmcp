### Gibt es einen MCP-Server für den Kaufland Marktplatz?
Ja, diesen hier. Er verbindet die Seller-API von Kaufland über AnythingMCP mit Claude, ChatGPT und Copilot: 7 Tools für Bestellungen, Bestelleinheiten, Angebote, Tickets, Storefronts und Lager.

### Was brauche ich für die Verbindung?
Ein Kaufland-Verkäuferkonto und ein API-Schlüsselpaar aus dem Seller Portal (Einstellungen → API-Schlüssel): Client Key und Secret Key.

### Wird der Secret Key übertragen?
Nein. Kaufland signiert jede Anfrage per HMAC; der Secret Key verlässt deine AnythingMCP-Instanz nie.

### Kann die KI Bestellungen oder Preise ändern?
Nein. Alle acht Tools lesen nur.
