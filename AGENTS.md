# Repository agent release rules

These rules are mandatory for every automated agent working in this repository.

## Before changing code

- Run `git pull --ff-only` before starting.
- Inspect branch, remote tracking, dirty state, and relevant release workflow.
- Preserve unrelated work and stage only reviewed paths.

## Release verification

- Never treat a host macOS browser run as GitHub Linux parity.
- Run checks proportionate to the changed files. Markdown-only changes do not
  require browser E2E or `release:gate`.
- `npm run release:gate -- MAJOR.MINOR.PATCH [--candidate]` remains available
  when release code itself needs Linux/AMD64 parity validation. It prepares the
  requested version only inside its isolated clone.
- All OCI image references must use the canonical lowercase
  `ghcr.io/shik3i/koalasync`; never construct Docker references from the
  case-preserving `${{ github.repository }}` value. The local gate enforces this.

## Before pushing a release tag

- Fast-forward local `main` and confirm a clean tree at exact `origin/main`.
- Wait for `verify`, `node20`, and `e2e` on that exact `main` commit.
- Do not edit release-version sources manually. The tag workflow owns the
  atomic version update.
- Create an annotated exact SemVer tag such as `v3.1.6`.
- Confirm tag target equals `origin/main`, then push the tag once.
- The workflow must extract the version, update and validate every version
  source, commit `chore(release): update versions to vX.Y.Z [skip ci]`, and push
  that commit directly to `main` before building release outputs.
- Chrome, Firefox, website, and relay outputs must use the exact prepared commit.
- Monitor the complete release workflow. Distinguish tag push, CI, draft assets,
  container publication, attestations, and public GitHub Release status.
- Never call a release complete while any job is pending, failed, or skipped.
- Never reuse, move, or force-push a published tag.
