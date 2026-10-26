### Esiste un server MCP per TeamSystem?
AnythingMCP può collegare TeamSystem a Claude, ChatGPT e agli altri client MCP tramite le API del tuo prodotto TeamSystem. Un connettore pronto a catalogo non è ancora disponibile per tutti: la documentazione API di TeamSystem non è pubblica e l'accesso alle API viene abilitato per singolo prodotto e per singola installazione da TeamSystem o dal tuo partner TeamSystem. Finché questo non cambia, il collegamento viene configurato sulla tua installazione a partire dalle API fornite dal fornitore.

### Quali prodotti TeamSystem si possono collegare?
Qualsiasi prodotto TeamSystem per il quale la tua licenza preveda l'accesso alle API. TeamSystem comprende una famiglia di prodotti (TeamSystem Enterprise, TS Digital, Alyante e altri), ciascuno con le proprie API, versioni e modalità di autenticazione. Il tuo partner TeamSystem può confermare quale prodotto utilizzi e quali endpoint espone la relativa API.

### Con quali dati TeamSystem può lavorare l'IA?
Con tutto ciò che l'API del tuo prodotto espone e che l'utente API è autorizzato a leggere. In un gestionale ERP si tratta di solito di anagrafiche clienti e fornitori, fatture e altri documenti, articoli e listini, e movimenti contabili. Claude può quindi rispondere a domande trasversali, ad esempio quali fatture risultano scadute o cosa ha acquistato un cliente quest'anno.

### Cosa devo richiedere a TeamSystem o al mio partner?
- Il modulo o la licenza API abilitati per la tua installazione.
- L'URL base dell'API da richiamare.
- Le credenziali di un utente API e il metodo di autenticazione previsto dal prodotto.
- La descrizione dell'API, idealmente come file OpenAPI (Swagger).

### Come posso collegarlo oggi?
In due modi. [Contattaci](https://anythingmcp.com/contact) e configuriamo insieme il connettore per la tua installazione. Oppure configuralo in autonomia: crea un connettore REST in AnythingMCP, importa la specifica OpenAPI fornita dal partner e ogni operazione diventerà un tool. Infine aggiungi l'URL del server MCP in Claude come connettore personalizzato o in ChatGPT come app.

### L'IA può modificare i dati in TeamSystem?
Solo se lo consenti. Assegna al server MCP un ruolo che autorizzi solo le operazioni di lettura: tutte le altre resteranno invisibili al client IA. Richiedi inoltre al partner un utente API con soli permessi di lettura, così che anche TeamSystem applichi lo stesso limite.

### I dati di TeamSystem escono dalla mia rete?
In modalità self-hosted, le credenziali e l'audit log restano sul tuo server; al modello IA che utilizzi arrivano solo i campi restituiti dal singolo tool, e il response mapping permette di rimuovere eventuali campi sensibili prima dell'invio. Se l'installazione TeamSystem è raggiungibile solo all'interno della rete aziendale, esegui AnythingMCP sulla stessa rete; AnythingMCP Cloud può raggiungere solo API esposte su Internet con un certificato HTTPS valido.
