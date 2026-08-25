# DevOps Release Workflow

This document describes the deployment and release process for KoalaSync.

## Tag-Based Releases

KoalaSync uses an automated release pipeline triggered by immutable annotated
Git tags.

> [!IMPORTANT]
> **DO NOT** edit individual version files before tagging. The workflow extracts
> the exact SemVer version from the tag and updates every release-version source
> atomically. Markdown-only changes do not require browser or release gates.

### How it Works

When an annotated tag matching exact `vMAJOR.MINOR.PATCH` is pushed, the GitHub
Actions workflow performs these ordered gates:

1. Validates that the tag is an annotated exact `vMAJOR.MINOR.PATCH` tag, points
   at current `origin/main`, and has successful `verify`, `node20`, and `e2e`
   checks. Invalid tags are rejected before any write.
2. Extracts the validated version and uses the tagged commit timestamp so
   repeated preparation is deterministic.
3. Updates and validates all version sources: `extension/manifest.base.json`,
   `shared/constants.js`, `package.json`, root metadata in `package-lock.json`,
   `website/version.json`, `website/template.html`, `website/llms.txt`, and both
   the README badge and release banner.
4. Creates `chore(release): update versions to vX.Y.Z [skip ci]` and pushes it
   directly to `main`. A failed push stops every dependent release job.
5. Checks out that exact prepared commit for full verification, cross-browser
   E2E, the unpublished relay health smoke, Chrome/Firefox/AMO/checksum/archive
   validation, website output, and the relay container build.
6. Creates an attested **draft** GitHub Release after extension checks pass.
7. Publishes the canonical lowercase image `ghcr.io/shik3i/koalasync`, then
   verifies both platforms, attestation identity, digest, tag source, and a
   running health check.
8. Makes the GitHub Release public only after every preceding job succeeds.

---

## Steps to Deploy a New Release

To release a new version (e.g., `v2.5.1`), follow these steps:

1. Fast-forward local `main`, confirm a clean tree at exact `origin/main`, and
   wait for `verify`, `node20`, and `e2e` on that commit:
   ```bash
   git checkout main
   git pull --ff-only origin main
   test -z "$(git status --porcelain=v1)"
   test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
   ```
2. Create an **annotated** exact SemVer tag on that commit. Do not run
   `prepare:release`; the tag workflow owns version updates:
   ```bash
   git tag -a v2.5.1 -m "Release v2.5.1"
   ```
3. Verify the tag target, then push it once:
   ```bash
   test "$(git rev-parse v2.5.1^{commit})" = "$(git rev-parse origin/main)"
   git push origin v2.5.1
   ```

Never reuse or move a published tag. Monitor every release job and verify both
the public GitHub assets and GHCR digest before calling the release complete.

`npm run release:gate -- MAJOR.MINOR.PATCH [--candidate]` remains an optional
Linux/AMD64 parity diagnostic when release code changes. It prepares the target
version only inside an isolated clone. It is not required for Markdown-only
changes and does not replace the tag workflow's own gates.

The relay registry reference is always the canonical lowercase
`ghcr.io/shik3i/koalasync`. Docker repository names reject uppercase characters;
`release:gate` rejects workflows that derive this reference from the
case-preserving `${{ github.repository }}` value.
