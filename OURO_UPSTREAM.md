# Ouro Workbench v1 downstream ledger

## Base

- Upstream: [`manaflow-ai/cmux`](https://github.com/manaflow-ai/cmux)
- Stable tag: `v0.64.22`
- Base commit: `ddd4a01bc5d8ebac19643930f5fd7d40e85f1534`
- Downstream branch: `user/arimendelow/v1-copilot-vertical-slice`

## Product boundary

cmux owns terminal rendering, panes, workspaces, browser surfaces, session layout, ordinary agent detection, and the local application shell. Ouro Workbench v1 owns the first-class Copilot/Agency Agent Chat experience, one Desk-aware boss, explicit local-versus-Hub authority, downstream policy and identity, onboarding, and release packaging.

## Upstream rule

After the Copilot CLI integration is validated inside Workbench v1, generally useful Copilot/ACP changes are proposed upstream to cmux. Agency-specific launch profiles, Desk integration, boss semantics, Microsoft policy, Ouro branding, and release configuration stay downstream.

## Exclusions

- No Workbench v0 production code port by default.
- No Ghostty divergence beyond the one owner-authored environment-lifetime patch carried while `manaflow-ai/ghostty` lacks a compatible reachable revision.
- No Herdr dependency.
- No Manaflow cloud, mobile, auth, push, or update-service dependency without an explicit supported arrangement.
