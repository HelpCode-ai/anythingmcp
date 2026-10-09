# Enterprise Edition (EE)

Everything under this directory is licensed under the [AnythingMCP
Commercial License](LICENSE), **not** the AGPL that covers the rest of
the repository.

- `cloud/` — operator-only functionality of AnythingMCP Cloud (e.g.
  onboarding lifecycle emails). Loaded only when `DEPLOYMENT_MODE=cloud`.
- `licensing/` — which edition a self-hosted instance runs (Community
  or a licensed plan) and what each allows. Loaded everywhere; single
  sign-on, SCIM and role sync (Enterprise) are active only with an
  Enterprise licence key (or an existing Business key), during the trial,
  or during the transition period of an upgraded instance.

For licensing questions, contact info@helpcode.ai.
