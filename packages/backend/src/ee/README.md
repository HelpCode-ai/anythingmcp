# Enterprise Edition (EE)

Everything under this directory is licensed under the [AnythingMCP
Commercial License](LICENSE), **not** the AGPL that covers the rest of
the repository.

EE code contains operator-only functionality used by the AnythingMCP
Cloud offering (e.g. onboarding lifecycle emails). It is inert in
self-hosted deployments: EE modules are only loaded when
`DEPLOYMENT_MODE=cloud`, and a community deployment works fully
without them.

If you are self-hosting, you don't need anything in here. If you want
to use EE features commercially, contact licensing@helpcode.ai.
