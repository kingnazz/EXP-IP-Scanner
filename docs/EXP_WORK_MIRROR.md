# EXP-owned repository mirror

The EXP-owned copy lives at:

- https://github.com/nazar-exp/EXP-IP-Scanner

The development/source repository lives at:

- https://github.com/kingnazz/EXP-IP-Scanner

## Design

The personal repository is the development source while this mirror is enabled.
The EXP repository remains a complete company-owned copy that can continue
independently if access to the personal account is later removed.

On every push to source `main`:

1. `EXP_MIRROR_TOKEN` pushes the exact `main` history and tags to the
   EXP-owned repository.
2. The source-side release sync copies any missing GitHub Releases and their
   exact assets into the EXP-owned repository.
3. A `repository_dispatch` wakes the EXP-owned repository, which builds and
   deploys its own GitHub Pages site.

The EXP-owned repository does not rebuild release binaries. Release assets are
copied byte-for-byte from the source release, so both repositories distribute
the same files.

## Token

The source repository contains the Actions secret `EXP_MIRROR_TOKEN`.

It is a classic PAT belonging to `kingnazz`, which is a collaborator on the
public work repository. GitHub requires the classic `repo` and `workflow`
scopes for this mirror because the pushed history contains GitHub Actions
workflow files.

The token exists only in the personal source repository. The EXP-owned
repository does not store this PAT.

## GitHub Pages

Both repositories use GitHub Pages.

The EXP-owned Pages site is deployed by
`.github/workflows/sync-exp-work-mirror.yml` after each mirror dispatch.

## Releases

Only `kingnazz/EXP-IP-Scanner` performs the official Windows build and release
pipeline. The same release notes, tags, installer, portable ZIP and checksums
are copied into `nazar-exp/EXP-IP-Scanner`.

The release workflow is explicitly gated so the mirrored work repository never
rebuilds and publishes a second set of binaries.

## Offboarding / making EXP independent

Before EXP begins developing directly in the work repository, disable the
source-side mirror workflows or revoke `EXP_MIRROR_TOKEN`.

At that point the work repository already has the source history, tags,
releases, release assets, changelog, workflows and Pages site. EXP can then
develop from its own repository normally.
