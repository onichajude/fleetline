# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub's **Report a vulnerability** button on the repository's Security tab (private vulnerability reporting). Don't open a public issue.

Please include the affected component (backend, dispatch console, driver web app, native app), steps to reproduce, and the impact you expect.

## What happens next

| Severity | Acknowledge | Fix or mitigate |
|---|---|---|
| Critical | 2 business days | 7 days |
| High | 5 business days | 30 days |
| Medium / low | 10 business days | Next planned release |

Fixed issues are retested and recorded in the risk register (`docs/architecture/registers.md`). If a fix isn't possible within the deadline, the risk is accepted with a mitigation, owner and expiry date.

## Scope notes

- Fleetline stores drivers' location history. Treat any finding that exposes it as at least high severity.
- Development-only defaults (seeded demo passwords, `REQUIRE_STAFF_MFA=false`, public map tile and routing services) are not vulnerabilities in themselves. A deployment that runs with them in production is a configuration problem.
