Der Connector braucht zwei Werte:

| Variable | Wo du sie findest |
|---|---|
| `WECLAPP_TENANT` | Die Subdomain deiner weclapp-URL: `deinefirma` in `deinefirma.weclapp.com` |
| `WECLAPP_API_TOKEN` | weclapp → **Meine Einstellungen → API-Tokens** → Token erzeugen |

Der Token geht als Header `AuthenticationToken` an `https://<mandant>.weclapp.com/webapp/api/v2`. Er handelt mit den Rechten des weclapp-Benutzers, der ihn erstellt hat. Erstelle ihn also mit einem Benutzer, der nur die Daten sieht, die die KI sehen soll.
