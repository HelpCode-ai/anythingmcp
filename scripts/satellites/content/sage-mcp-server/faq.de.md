### Gibt es einen MCP-Server für Sage 100?
Ja, diesen hier. Er verbindet die deutsche Sage 100 über die Sage 100 Web API (OData) mit Claude, ChatGPT und Copilot: 6 lesende Tools für `$metadata`, `Adressen`, `Artikel`, `Belege` sowie beliebige freigegebene OData-Entity-Sets.

### Ist der Connector für die deutsche Sage 100 gedacht?
Ja, dieser Connector richtet sich an die deutsche **Sage 100** für den Mittelstand (nicht an das US-Produkt Sage 100cloud). Er nutzt die deutschen Entity-Namen wie `Adressen`, `Artikel` und `Belege` der Sage 100 Web API.

### Was benötige ich vorab von meinem Sage-Business-Partner?
Sage 100 bringt von Haus aus keinen offenen HTTP-Endpunkt mit: Der **Sage 100 Web API**- bzw. OData-Dienst muss auf dem Applikationsserver installiert und lizenziert sein. Dein Sage-Partner nennt dir die genaue OData-Basis-URL (`SAGE100_URL`), die Mandanten-Kennung (`SAGE100_COMPANY`) und richtet einen lesenden Sage-Benutzer (`SAGE100_USERNAME`, `SAGE100_PASSWORD`) ein.

### Warum sollte zuerst `sage_100_get_metadata` aufgerufen werden?
Fast jede Sage-100-Installation ist durch Partner-Anpassungen individuell erweitert, sodass kaum zwei Systeme dieselben Entity-Sets und Zusatzfelder veröffentlichen. Über `$metadata` sieht die KI zuerst alle tatsächlich vorhandenen Tabellen und Feldnamen deiner Installation, bevor sie per `sage_100_query` abfragt.

### Kann die KI Daten in Sage 100 ändern?
Nein. Alle 6 Tools senden ausschließlich lesende HTTP-GET-Anfragen, und darüber hinaus greift das Berechtigungskonzept des hinterlegten Sage-100-Benutzers.

### Wurde der Connector bereits gegen eine Live-Installation getestet?
Noch nicht: Da Sage die Web-API-Dokumentation nur über das Partnerportal vergibt, konnten der Standardpfad und die Entity-Namen noch nicht an einem Live-System geprüft werden. Rückmeldungen aus dem Echtbetrieb sind herzlich willkommen.
