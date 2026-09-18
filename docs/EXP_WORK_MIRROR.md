# EXP-owned repository mirror

The EXP-owned copy lives at:

- https://github.com/nazar-exp/EXP-IP-Scanner

The development/source repository currently lives at:

- https://github.com/kingnazz/EXP-IP-Scanner

## Why this exists

The work repository must remain usable if Nazar leaves EXP, while day-to-day
Claude/Codex/GitHub work can continue through the existing `kingnazz` account.

The work repository is therefore a managed mirror while this arrangement is
active. It receives the same `main` history and tags, copies the exact release
assets, and deploys its own GitHub Pages site.

## One-time bootstrap

From a local clone authenticated as `kingnazz` (which is a collaborator on
the work repository):

```bash
git checkout main
git pull --ff-only origin main
git remote remove exp 2>/dev/null || true
git remote add exp https://github.com/nazar-exp/EXP-IP-Scanner.git
git push exp main --force
git push exp --tags --force
```

Then enable GitHub Pages in the work repository:

**Settings → Pages → Build and deployment → Source → GitHub Actions**

Finally run **Actions → Sync EXP work mirror → Run workflow** once in the
work repository. That copies historical releases and deploys the work Pages
site.

## Automatic sync

The source repository stores a secret named `EXP_MIRROR_TOKEN`. It is a
classic GitHub personal access token belonging to `kingnazz` with only the
`public_repo` scope. Because `kingnazz` is a collaborator on the public
work repository, that is sufficient to send a `repository_dispatch`.

The token does **not** push code or publish releases. It only wakes the work
repository. The work repository then performs the sync with its own
`GITHUB_TOKEN`.

A source release sends a second notification after publication so the release
assets are copied as soon as they exist.

## Offboarding / making the EXP repo independent

Before EXP begins developing directly in the work repository, disable
`.github/workflows/sync-exp-work-mirror.yml` (or remove the dispatch trigger).
At that point the work repository already contains the code, tags, release
assets, changelog, and Pages site and can operate normally using its existing CI
and release workflows.
