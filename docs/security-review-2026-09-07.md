# Security and quality review — 2026-09-07

Scope: GitHub Security and quality findings, Dependabot PR #43, installed
dependency paths, and the repository verification suite. This is a dated
repository review, not evidence of a production deployment.

## Dependency findings

| Finding | Assessment | Remediation |
| --- | --- | --- |
| Dependabot #19, #20, #22, #23: `fast-uri` host normalization | The pinned `3.1.5` is affected. Dependency path: development-only `addons-linter -> ajv -> fast-uri`; not a relay runtime dependency. No application SSRF path was identified. | Update the existing override and lockfile to `3.1.7`, within AJV's `^3.0.1` range. |
| Dependabot #21: `qs` array-limit bypass | `6.15.3` is affected. The advisory requires comma parsing; KoalaSync does not configure `comma: true`, an extended query parser, or URL-encoded body middleware. Express defaults to its simple query parser. | PR #43 updates the server lockfile to `6.16.0`; merged as `7bac8d48acd695a25efb867312081670a7896e9c`. GitHub subsequently marked #21 fixed. |
| Additional npm advisory: `qs` attacker-controlled `isBuffer` | A second advisory affects the old server dependency, even though it was absent from the five open GitHub alerts. | Also fixed by `qs@6.16.0`. |
| Dependabot #16/#17: `image-size` parser loops | Existing GitHub auto-dismissals, not fixed packages. `npm audit` still reports ICNS and JXL/HEIF loop advisories through the development-only `addons-linter`. Current extension icons are repository PNG assets; this is not a production image-upload service. Untrusted build assets remain a relevant boundary. | No patched npm version was available: latest `image-size` was `2.0.2`; latest `addons-linter@10.10.0` still required it. Keep the residual finding explicit. Do not downgrade the AMO validator to `2.21.0` merely to satisfy `npm audit fix --force`. |

Advisories:

- [fast-uri IDN normalization](https://github.com/advisories/GHSA-5jgf-p345-68v8)
- [fast-uri repeated decoding](https://github.com/advisories/GHSA-fph4-wmhf-6fwf)
- [fast-uri IPv6 normalization](https://github.com/advisories/GHSA-f65p-4m7j-42xc)
- [fast-uri scheme normalization](https://github.com/advisories/GHSA-jqff-g426-hqxp)
- [fast-uri unclosed authority bracket](https://github.com/fastify/fast-uri/security/advisories/GHSA-58mr-gqgx-xq4g)
- [fast-uri unvalidated serialized port](https://github.com/fastify/fast-uri/security/advisories/GHSA-qw65-cvwx-89v3)
- [qs array limits](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx)
- [qs isBuffer](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g)
- [image-size ICNS](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr)
- [image-size JXL/HEIF](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq)

The final pin is `3.1.7`, not the initial `3.1.6` candidate. PR #44's review
identified two additional maintainer advisories absent from the npm audit
response. Both were verified against the upstream advisories above. A local
`3.1.6` reproduction serialized an injected port into a URL targeting a different
host; `3.1.7` rejects that port. This is why a clean npm result for `fast-uri`
alone was insufficient evidence for the final version choice.

## Other GitHub reports

- Code scanning on `main`: 0 open, 20 closed. Eighteen are recorded as fixed.
  The two existing false-positive dismissals were checked against current code:
  #13's health route calls `checkHealthRate` and returns HTTP 429; #1 concerns
  fast HMAC hashing of ephemeral in-memory room passwords, with online attempt
  limits, rather than a persistent account-password database. This assessment
  depends on that threat model and deployment configuration; a fast HMAC is not
  a substitute for a password KDF in a persistent account system.
- Secret scanning: 0 open, 0 closed.
- Dependabot malware: 0 open, 0 closed.
- Security advisories: 0 triage, 0 draft, 0 published, 0 closed.
- No alert was manually dismissed during this review.

## Verification

- PR #43 head `44e20a8d9bed4704387862ef48afbfbc7d7dd5a3`:
  Linux CI run `33749307931`, `verify`, `node20`, and `e2e` successful.
- Clean `npm ci` and `npm run verify` succeeded with the updated root lockfile
  on Windows, Node `v25.2.1`, npm `11.6.2`: 327 unit tests, coverage gate,
  relay route/WebSocket integrations, remaining scripted checks, lint,
  extension and website builds, and AMO validation with no errors or warnings.
- Root and server production audits: 0 vulnerabilities.
- Full root audit: only `image-size` and its affected parent `addons-linter`
  remain (two high-severity package entries, stemming from two advisories).
- A local `npm install --package-lock-only` initially removed unrelated
  optional-platform metadata and broke `npm ci`. Those changes were discarded;
  the final lockfile diff changes only `fast-uri` version, URL, and integrity.
  The subsequent clean install and full verification passed.
- Windows verification is not Linux CI parity. Merge requires the fix PR's
  `verify`, `node20`, and `e2e` checks to pass.
