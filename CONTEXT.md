# Identity and room collaboration glossary

## Current product and design inputs

- Product requirements: [`docs/reconstruction/2026-08-agent群聊协作模式-prd.reconstructed.md`](./docs/reconstruction/2026-08-agent群聊协作模式-prd.reconstructed.md)
- UI / interaction design baseline and spec adoption rules: [`docs/design/README.md`](./docs/design/README.md)
- Protocol specifications: [`docs/protocols/`](./docs/protocols/)
- Implementation plans and historical task contracts: [`docs/plans/`](./docs/plans/)

The PRD owns product semantics and permissions; protocols/specs own authoritative commands, ACKs, events, and recovery; the design baseline maps those contracts to Desktop UI and interaction states. Prototype-only effects are not authoritative product behavior.

- **Account**: A credential record that maps to exactly one human actor.
- **Session**: A server-issued binding to an authenticated human actor. A client does not choose or replace the actor identity carried by a session.
- **Human invitation**: A request targeted at one human actor. The invited human can accept or reject it, and either decision is a recorded result.
- **Agent configuration**: A command that immediately creates or replaces an agent membership with its participation mode and tool permissions. It has no acceptance step.
- **Human membership**: A human actor's room relationship, carrying a social role and the time the actor joined.
- **Agent membership**: An agent actor's room relationship, carrying its participation mode, granted tool permissions, and configuration time.
- **Removal**: Revocation of future room access and addressing for a member. Removal preserves previously authored messages and audit history.
