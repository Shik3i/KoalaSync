# DevOps Release Workflow

This document describes the deployment and release process for KoalaSync.

## Tag-Based Releases

KoalaSync uses a gated release pipeline triggered by immutable Git tags.

> [!IMPORTANT]
> **DO NOT** edit individual version files or tag an unmerged branch. Run
> `npm run prepare:release -- MAJOR.MINOR.PATCH` on a branch, review all generated
> source changes, then run the exact Linux/AMD64 candidate gate before opening
> or updating the pull request:
> `npm run release:gate -- MAJOR.MINOR.PATCH --candidate`.
> Merge only through a pull request with successful CI.

### How it Works

When an annotated tag matching exact `vMAJOR.MINOR.PATCH` is pushed, the GitHub
Actions workflow performs these ordered gates:

1. Confirms that the tag is annotated, points exactly at current `origin/main`,
   and matches every committed version source.
2. Requires successful `verify`, `node20`, and `e2e` checks for that commit.
3. Re-runs release verification, cross-browser E2E, and an unpublished relay
   container smoke test.
4. Builds and locally validates Chrome/Firefox archives, checksums, AMO output,
   website output, archive parity, and manifests.
5. Creates an attested **draft** GitHub Release.
6. Publishes the multi-architecture relay image, verifies both platforms,
   attestation identity, digest, tag source, and a running health check.
7. Makes the GitHub Release public only after every preceding gate succeeds.

The release workflow never writes to `main` and never derives shell code from a
tag. Version changes must pass normal branch protection first.

---

## Steps to Deploy a New Release

To release a new version (e.g., `v2.5.1`), follow these steps:

1. Create a release-preparation branch from current `main` and update every
   version source atomically:
   ```bash
   git checkout main
   git pull origin main
   git checkout -b release/v2.5.1
   npm run prepare:release -- 2.5.1
   git add <reviewed-release-paths>
   git commit -m "release: prepare v2.5.1"
   npm run release:gate -- 2.5.1 --candidate
   ```
2. Push the already committed and candidate-gated changes, open a pull request,
   and wait for required `verify`, `node20`, and `e2e` checks.
3. After the PR is merged, fast-forward local `main`, wait for `verify`,
   `node20`, and `e2e` on the merge commit, then run the final local gate. It
   refuses a dirty tree, a non-`main` branch, a commit different from
   `origin/main`, missing/failed required checks, version drift, non-AMD64
   Linux browser execution, or an unhealthy relay container:
   ```bash
   git checkout main
   git pull --ff-only origin main
   npm run release:gate -- 2.5.1
   ```
4. Only after that command succeeds, create an **annotated** tag on the exact
   checked commit:
   ```bash
   git tag -a v2.5.1 -m "Release v2.5.1"
   ```
5. Verify the tag target, then push it once:
   ```bash
   test "$(git rev-parse v2.5.1^{commit})" = "$(git rev-parse origin/main)"
   git push origin v2.5.1
   ```

Never reuse or move a published tag. Monitor every release job and verify both
the public GitHub assets and GHCR digest before calling the release complete.

`npm run verify` or a host-only Playwright run is not a substitute for
`release:gate`. The gate pins the official Playwright image to the exact
lockfile version and forces `linux/amd64`, matching GitHub's Ubuntu runner even
when the developer host is macOS or ARM64.

The relay registry reference is always the canonical lowercase
`ghcr.io/shik3i/koalasync`. Docker repository names reject uppercase characters;
`release:gate` rejects workflows that derive this reference from the
case-preserving `${{ github.repository }}` value.
