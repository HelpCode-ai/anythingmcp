### Existe-t-il un serveur MCP pour Dolibarr ?
Oui, celui-ci. Il expose l'API REST de Dolibarr sous forme de 10 outils MCP (tiers, factures clients, commandes clients, propositions commerciales, factures fournisseurs, produits et stock par entrepôt, plus un contrôle de statut) via AnythingMCP, sur AnythingMCP Cloud ou sur votre propre hôte Docker. L'adaptateur suit la documentation de l'API REST de Dolibarr et n'a pas encore été testé sur une installation réelle : tout retour sur ce qui fonctionne est le bienvenu.

### Comment connecter Dolibarr à Claude ?
En tant qu'administrateur, activez le module **API REST** (Web Services API REST) dans la configuration des modules : il est désactivé par défaut. Générez ensuite une clé API sur la fiche de l'utilisateur au nom duquel l'IA doit agir. Installez le connecteur avec `DOLIBARR_URL` (la racine de votre installation, sans `/api`) et `DOLIBARR_API_KEY`, puis ajoutez l'URL de votre serveur MCP dans Claude comme connecteur personnalisé. `dolibarr_get_status` est le moyen le plus rapide de vérifier que le module est actif et que la clé est acceptée.

### L'IA peut-elle modifier des données dans Dolibarr ?
Pas avec ce connecteur : les 10 outils sont des requêtes HTTP GET, l'IA peut donc lire mais ni créer ni modifier d'enregistrements. La clé porte les droits de son utilisateur Dolibarr, module par module : créez un utilisateur dédié qui n'a que les droits de lecture nécessaires.

### Pourquoi l'IA obtient-elle une liste vide ou une erreur 403 ?
Les droits Dolibarr se règlent par module. Un utilisateur sans le droit de *lire les factures* reçoit une erreur 403 sur les factures, et un utilisateur sans le droit de *lire les tiers* obtient une liste vide plutôt qu'une erreur. Vérifiez les droits de l'utilisateur à qui appartient la clé API.

### Mon Dolibarr est sur un serveur interne. Puis-je quand même l'utiliser ?
Oui, avec un AnythingMCP auto-hébergé sur le même réseau : ajoutez le nom d'hôte de Dolibarr à `SSRF_ALLOWED_HOSTS`. AnythingMCP Cloud ne peut joindre qu'une installation accessible sur un nom d'hôte public avec un certificat TLS valide ; un certificat auto-signé échoue.

### Est-ce que cela fonctionne aussi avec ChatGPT et Copilot ?
Oui. La même URL de serveur MCP fonctionne dans ChatGPT (qui exige une URL HTTPS publique, comme celle d'AnythingMCP Cloud), GitHub Copilot dans VS Code, Cursor, Claude Code et tout autre client MCP.
