### Do I need a Google Ads developer token?
No. Google retired developer tokens on 9 September 2026. API access now depends on the access level of your Google Cloud project: Test reaches only test accounts, Explorer (2,880 operations a day) reads real accounts, Basic and Standard raise the quota.

### How do I use Google Ads in Claude or ChatGPT?
Install the Google Ads connector on AnythingMCP, authorize it once in the browser, then add the AnythingMCP server URL to Claude as a custom connector or to ChatGPT as a developer-mode app. Both sign in with OAuth, so nothing runs on your computer. Claude Code, Cursor and other clients use the same URL with an API key header.

### Can the AI change my campaigns?
No. All 17 tools read: reports, lists and GAQL queries. There is no tool to pause, create or edit anything, and every tool is annotated as read-only for the client.

### Which reports are covered?
Account settings and manager hierarchies, daily account metrics, campaign, ad group, ad and keyword performance with Quality Score components, the search terms report, budget pacing with impression share lost to budget and rank, conversion actions, change history and recommendations. Anything else goes through `gads_run_gaql`, and `gads_playbook` gives the model tested queries for device, location, hour, landing page, Performance Max, asset and audience reports.

### Does it work with manager (MCC) accounts?
Yes. Set `GOOGLE_ADS_LOGIN_CUSTOMER_ID` to the manager's id; `gads_list_client_accounts` lists the accounts below it.

### How much quota does a question use?
A report is one operation. Answering a question usually takes 2 to 8 calls, well inside the 2,880 operations a day of Explorer access. The quota belongs to the Cloud project, so connectors sharing one OAuth client share it.
