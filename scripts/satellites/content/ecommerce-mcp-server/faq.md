### How do I connect my shop or marketplace to Claude?
Install the adapter for each channel in AnythingMCP, authorise it, and add the MCP server URL to Claude as a custom connector. ChatGPT, Copilot and Cursor use the same URL.

### Can I ask about several marketplaces in one question?
Yes. Put every channel on the same MCP server and the AI calls each one and combines the answers.

### Which channels are verified against a real account?
The "Verified live" column says so per channel, with the date. The others follow the vendor's API documentation and have not been confirmed yet.

### Can the AI change prices, stock or orders?
Only through write tools, and only when a role allows them. Most marketplace adapters only read; WooCommerce, Magento, BigCommerce, Ecwid, OTTO Market and eBay have write tools.

### Does customer data reach the AI provider?
Only the fields a tool returns. Response mapping drops addresses or phone numbers before they leave your AnythingMCP instance, and Amazon buyer data is not requested at all.
