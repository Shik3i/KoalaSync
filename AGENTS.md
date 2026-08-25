# Repository agent release rules

These rules are mandatory for every automated agent working in this repository.

## Before changing code

- Run `git pull --ff-only` before starting.
- Inspect branch, remote tracking, dirty state, and relevant release workflow.
- Preserve unrelated work and stage only reviewed paths.

## Before claiming a release is ready

- Never treat a host macOS browser run as GitHub Linux parity.
- On a release branch, commit all intended changes and run:
  `npm run release:gate -- MAJOR.MINOR.PATCH --candidate`
- This command must use the official lockfile-matched Playwright image with
  `linux/amd64`, Ubuntu Noble, and `CI=1`; it must run clean installs, full
  verification, all browser E2E tests, the relay image build, and health smoke.
- A failed, interrupted, ARM64, skipped, or partial run is not a passing gate.
- All OCI image references must use the canonical lowercase
  `ghcr.io/shik3i/koalasync`; never construct Docker references from the
  case-preserving `${{ github.repository }}` value. The local gate enforces this.
- Do not say "release-ready" until the candidate gate and PR required checks
  are green for the exact commit.

## Before pushing a release tag

- Merge through a PR; resolve every review thread.
- Fast-forward local `main` and confirm a clean tree at exact `origin/main`.
- Wait for `verify`, `node20`, and `e2e` on the merged `main` commit.
- Run the final gate: `npm run release:gate -- MAJOR.MINOR.PATCH`.
- Create an annotated tag only after the final gate succeeds.
- Confirm tag target equals `origin/main`, then push the tag once.
- Monitor the complete release workflow. Distinguish tag push, CI, draft assets,
  container publication, attestations, and public GitHub Release status.
- Never call a release complete while any job is pending, failed, or skipped.

The final gate deliberately simulates the release workflow seeing its own
in-progress `preflight` check. This is a permanent regression guard for the
failed first `v3.1.5` release attempt.
