### Gibt es einen MCP-Server für SAP HANA?
Ja, diesen hier. Er verbindet die HANA-Datenbank unter SAP S/4HANA über AnythingMCP mit Claude, ChatGPT und Copilot. Dazu gehören ein Leitfaden zum SAP-Datenmodell, acht Tools, die das Data Dictionary und die Organisationsstruktur von SAP lesen (Tabellen- und Feldtexte, Festwerte, Join-Pfade, freigegebene CDS-Views), und eines, das ein `SELECT` ausführt. So weiß das Modell, was `BUKRS`, `HSL` oder `VBRK` bedeuten, bevor es eine Abfrage schreibt.

### HANA SQL oder OData: was nehme ich?
SQL erreicht jede Tabelle und jeden CDS-View und aggregiert in der Datenbank, gut für Auswertungen über Finanzen, Vertrieb und Bestand. Es umgeht die Berechtigungsprüfungen der SAP-Anwendung, die Grenze sind also die Datenbankrechte, und deine HANA-Lizenz muss SQL-Zugriff durch Drittanwendungen erlauben. OData läuft über das SAP Gateway, prüft bei jedem Aufruf die Berechtigungen des technischen Benutzers und erreicht nur veröffentlichte Services, so wie es SAPs API-Richtlinie erwartet. Der OData-Weg ist der Connector SAP S/4HANA (OData) in sap-mcp-server; beide laufen auch parallel.

### Kann die KI Daten in SAP ändern?
Nein. Die Session läuft mit `SET TRANSACTION READ ONLY`, nur ein einzelnes `SELECT` kommt durch, sperrende Lesezugriffe werden abgewiesen, Ergebnisse enden bei 1000 Zeilen und jede Anweisung bricht nach 60 Sekunden ab. Lege trotzdem einen Datenbankbenutzer an, der nur lesen darf.

### Was brauche ich für die Verbindung?
Einen HANA-Datenbankbenutzer mit `SELECT` auf die Dictionary-Tabellen und die Fachtabellen, die gelesen werden sollen (die Grants stehen unter Authentifizierung), den SQL-Port des Tenants, das ABAP-Schema (meist `SAPHANADB` oder `SAPABAP1`) und den SAP-Mandanten. Der HANA-Port ist normalerweise intern, AnythingMCP läuft also selbst gehostet im Netz oder erreicht es per VPN.

### Geht das mit RISE with SAP und Private Cloud?
Ja, geprüft wurde es auf einem S/4HANA 2025 Private Cloud-System. In SAPs Private-Cloud-Angeboten beantragst du Datenbankbenutzer und Netzwerkzugang bei SAP.

### Erlaubt meine SAP-Lizenz das?
Direkter SQL-Zugriff einer Drittanwendung auf das ABAP-Schema richtet sich nach deiner SAP-HANA-Lizenz. Eine mit S/4HANA gebündelte Runtime-Lizenz deckt das meist nicht ab, eine Full-Use-Lizenz schon. Kläre das mit deinem SAP-Ansprechpartner, bevor du ein Produktivsystem anbindest.

### Kann sie HR-Daten lesen?
HR- und Benutzer-/Passworttabellen stehen standardmäßig auf der Sperrliste des Connectors; Anweisungen, die sie nennen, werden abgewiesen. Gib dem Datenbankbenutzer nur, was der Agent braucht; `GRANT SELECT ON SCHEMA` macht auch HR-Tabellen lesbar.
