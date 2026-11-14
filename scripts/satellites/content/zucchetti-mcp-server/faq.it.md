### Esiste un server MCP per Zucchetti?
AnythingMCP può collegare Zucchetti a Claude, ChatGPT e agli altri client MCP tramite le API della tua installazione Zucchetti. Un connettore pronto a catalogo non è ancora disponibile per tutti: Zucchetti non pubblica la documentazione delle proprie API e ogni prodotto e installazione espone una propria API, resa disponibile da Zucchetti o dal partner Zucchetti. Finché questo non cambia, il collegamento viene configurato sulla tua installazione a partire dalle API fornite dal fornitore.

### Quali prodotti Zucchetti si possono collegare?
Qualsiasi prodotto Zucchetti la cui installazione preveda l'accesso API nella tua licenza. Zucchetti non è un unico prodotto: Infinity Zucchetti, Ad Hoc Revolution, HR Zucchetti, Mago e altri hanno ciascuno le proprie API, versioni e modalità di autenticazione. Il tuo partner Zucchetti può indicarti quali API sono attive sulla tua installazione e quali dati espongono.

### Con quali dati Zucchetti può lavorare l'IA?
Con tutto ciò che l'API della tua installazione espone e che l'utente API è autorizzato a leggere. Nei gestionali ERP si tratta di solito di anagrafiche (clienti e fornitori), documenti come fatture, ordini e DDT, e articoli; nei prodotti HR, anagrafiche dipendenti e presenze. Claude può quindi rispondere a domande trasversali, ad esempio quali ordini sono ancora aperti o quali fatture risultano scadute.

### Cosa devo richiedere a Zucchetti o al mio partner?
- Il modulo o la licenza API abilitati per la tua installazione.
- L'URL base dell'API della tua installazione.
- Le credenziali di un utente API e il metodo di autenticazione previsto dal prodotto.
- La descrizione dell'API, idealmente come file OpenAPI (Swagger).

### Come posso collegarlo oggi?
In due modi. [Contattaci](https://anythingmcp.com/contact) e configuriamo insieme il connettore per la tua installazione. Oppure configuralo in autonomia: crea un connettore REST in AnythingMCP, importa la specifica OpenAPI fornita dal partner e ogni operazione diventerà un tool. Infine aggiungi l'URL del server MCP in Claude come connettore personalizzato o in ChatGPT come app.

### L'IA può modificare i dati in Zucchetti?
Solo se lo consenti. Assegna al server MCP un ruolo che autorizzi solo le operazioni di lettura: tutte le altre resteranno invisibili al client IA. Richiedi inoltre al partner un utente API con soli permessi di lettura, così che anche Zucchetti applichi lo stesso limite. I dati HR sono dati personali: esponi solo le operazioni effettivamente necessarie al team.

### I dati di Zucchetti escono dalla mia rete?
In modalità self-hosted, le credenziali e l'audit log restano sul tuo server; al modello IA che utilizzi arrivano solo i campi restituiti dal singolo tool, e il response mapping permette di rimuovere eventuali campi sensibili prima dell'invio. Se l'installazione Zucchetti è raggiungibile solo all'interno della rete aziendale, esegui AnythingMCP sulla stessa rete; AnythingMCP Cloud può raggiungere solo API esposte su Internet con un certificato HTTPS valido.
