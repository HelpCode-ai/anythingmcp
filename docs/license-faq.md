# License FAQ

> Plain-language explanation of the AnythingMCP license. This is not legal advice — see the full [LICENSE](../LICENSE) for the binding terms.

[Back to README](../README.md)

---

## What license does AnythingMCP use?

AnythingMCP is licensed under the **GNU Affero General Public License v3** (AGPL-3.0-only), an OSI-approved **open-source** license. It is the same license used by Twenty, Cal.com, Grafana, Plausible and Mastodon.

The only exception is code under `ee/` directories (e.g. `packages/backend/src/ee/`), which contains operator-only functionality for the AnythingMCP Cloud offering and is licensed under the [AnythingMCP Commercial License](../packages/backend/src/ee/LICENSE). EE code is inert in self-hosted deployments — you don't need it.

---

## What can I do?

| Use Case | Allowed? |
|----------|----------|
| Use AnythingMCP internally at my company | **Yes** |
| Use it for personal projects | **Yes** |
| Use it for development and testing | **Yes** |
| Use it for academic research or teaching | **Yes** |
| Modify the source code | **Yes** |
| Self-host for my own team or organization | **Yes** |
| Build internal tools on top of it | **Yes** |
| Offer it (even modified) as a hosted service | **Yes** — but see the copyleft condition below |
| Contribute back to the project | **Yes** — after signing the [CLA](../CLA.md) |

---

## What does the AGPL require from me?

The AGPL is a **copyleft** license. In short:

1. **Internal/personal use:** no obligations. Use and modify freely.
2. **Distributing AnythingMCP** (modified or not): you must provide the source code under the AGPL.
3. **Running a modified AnythingMCP as a network service** for other people: you must offer those users the source code of your modified version. This is the "Affero" clause — it closes the SaaS loophole of the ordinary GPL.

If you don't modify the code, simply pointing users at this repository satisfies the source-offer requirement.

---

## Can I build a proprietary product on top of AnythingMCP?

You can *use* AnythingMCP from a proprietary product over its API (your product is a separate work). But if you *incorporate or modify* AnythingMCP code, the combined work must be AGPL. If that doesn't fit your business, we offer **commercial licenses without copyleft obligations** — contact [licensing@helpcode.ai](mailto:licensing@helpcode.ai).

---

## What is the `ee/` directory?

Code under `ee/` directories powers the AnythingMCP Cloud operation (e.g. onboarding lifecycle emails). It is:

- **Visible** — you can read and audit it like the rest of the repo
- **Not AGPL** — it's under the AnythingMCP Commercial License
- **Not needed for self-hosting** — EE modules only load when `DEPLOYMENT_MODE=cloud`

This split (AGPL core + commercial `ee/`) is the same model used by Cal.com and GitLab.

---

## What about old releases?

Versions of AnythingMCP released **before** the AGPL adoption remain under the **Business Source License 1.1** they were published with. Those releases convert automatically to Apache 2.0 on their Change Date (2030-03-04). Everything from the AGPL adoption onward is AGPL-3.0-only.

---

## Why the AGPL and not MIT/Apache?

The AGPL lets us:

1. **Be genuinely open source** — OSI-approved, with all the freedoms that implies
2. **Allow free self-hosting** — organizations can deploy AnythingMCP internally at no cost, forever
3. **Keep improvements open** — anyone who offers a modified AnythingMCP as a service must share their changes
4. **Build sustainably** — the copyleft, our commercial licenses, and the `ee/` features fund continued development

---

## Why do contributors sign a CLA?

The [Contributor License Agreement](../CLA.md) lets helpcode.ai GmbH re-license contributions — which is what makes the dual model (AGPL + commercial licenses) possible with a single codebase. **You keep the copyright** on your contribution; the CLA is a license, not an assignment. Signing happens automatically on your first pull request and takes one click.

---

## How do I get a commercial license?

Contact [licensing@helpcode.ai](mailto:licensing@helpcode.ai) or visit [anythingmcp.com/pricing](https://anythingmcp.com/pricing) for commercial licensing options.

---

[Back to README](../README.md) | [Full License Text](../LICENSE)
