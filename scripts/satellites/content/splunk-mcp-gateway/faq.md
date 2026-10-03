### Splunk already has an MCP server. Why put AnythingMCP in front of it?
The Splunk MCP Server app provides the tools; AnythingMCP adds what a team needs around them: OAuth sign-in for Claude and ChatGPT (no token pasted into each laptop), roles that decide which people may call which tool, an audit log of every call in your own database, response mapping to drop fields before they reach the model, and Splunk next to your other systems behind one MCP endpoint.

### Which tools do I get?
Exactly the ones your Splunk MCP Server lists. At install AnythingMCP asks your server for its tools, so a newer or older app version gives you its own set. Today that is SPL searches, saved searches, indexes, hosts and sources, knowledge objects, KV Store, users and, where Splunk AI Assistant is available, tools that write, explain and optimise SPL. After upgrading the app, click **Discover tools** on the connector.

### Can the AI change data in Splunk?
SPL can write (`collect`, `outputlookup`, `delete`), which is why Splunk marks `splunk_run_query` and `splunk_run_saved_search` as able to change data. Give the token's user a role that cannot write to indexes or lookups. The two dashboard tools install switched off; turn them on per tool if you want the AI to create or edit dashboards.

### Does it work with Splunk Cloud and Splunk Enterprise?
Yes, wherever the Splunk MCP Server app runs. On Splunk Cloud Platform the management port 8089 only answers addresses on your stack's search API allow list, so the address AnythingMCP calls from has to be added there.

### Do I need to host anything?
No. Use AnythingMCP Cloud, or run the open-source AnythingMCP yourself (Docker) if the token should never leave your network.
