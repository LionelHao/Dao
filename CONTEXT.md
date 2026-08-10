# Identity and room collaboration glossary

- **Account**: A credential record that maps to exactly one human actor.
- **Session**: A server-issued binding to an authenticated human actor. A client does not choose or replace the actor identity carried by a session.
- **Human invitation**: A request targeted at one human actor. The invited human can accept or reject it, and either decision is a recorded result.
- **Agent configuration**: A command that immediately creates or replaces an agent membership with its participation mode and tool permissions. It has no acceptance step.
- **Human membership**: A human actor's room relationship, carrying a social role and the time the actor joined.
- **Agent membership**: An agent actor's room relationship, carrying its participation mode, granted tool permissions, and configuration time.
- **Removal**: Revocation of future room access and addressing for a member. Removal preserves previously authored messages and audit history.
