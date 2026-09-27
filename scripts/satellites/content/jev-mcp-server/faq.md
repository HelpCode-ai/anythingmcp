### What is Jev?
Jev is the first System One model from TypeSafe. It does not generate text: you pass evidence (the `state`) and typed questions, and it answers each one with a yes/no probability, one option out of a set you define, or a score on ordered levels, with the probabilities behind the answer. In our tests a call took 220 to 430 ms.

### How do I use Jev in Claude or ChatGPT?
Install the Jev connector on AnythingMCP with your TypeSafe API key, then add the AnythingMCP server URL to Claude as a custom connector or to ChatGPT as a developer-mode app. Both sign in with OAuth, so nothing has to run on your computer. Claude Code, Cursor and other clients take the same URL with an API key header.

### Which tools does the connector have?
`jev_yes_no`, `jev_classify` and `jev_rate` ask one question each with simple parameters; `jev_ask` sends several questions of any type about the same evidence in one call; `jev_list_models` lists the models your key can use; `jev_playbook` explains to the model how to phrase questions and read the answers, without calling the API.

### What does it cost?
TypeSafe bills Jev per input token, about $0.042 per million, and output is free. A call with three questions about a short support ticket used about 500 tokens. AnythingMCP itself is free when self-hosted.

### Can a team share one TypeSafe key?
Yes. The key is stored once, encrypted, on the AnythingMCP server. People connect to the server with their own login, never see the key, and every call is written to the audit log.

### Does Jev understand languages other than English?
It handles them. German and Italian tickets came back correct and confident in our tests; English is where TypeSafe reports the best accuracy, so watch the confidence values for other languages.
