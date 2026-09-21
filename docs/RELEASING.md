# Releasing EXP IP Scanner

`package.json` is the version source of truth.

Every release must include readable website release notes, following the same pattern used by ArcScan.

## Release checklist

1. Update `CHANGELOG.md` with a new `## X.Y.Z` section.
2. Add `site/whats-new-X.Y.Z.html` with a short, user-focused explanation of the important changes.
3. Add the version to `site/releases.html` and link it to the new What's New page.
4. Bump `package.json` to `X.Y.Z`.
5. Run:

   ```bash
   npm run sync-version
   npm run check-release-page
   npm run check-version
   ```

6. Commit everything together and merge to `main`.

The version bump triggers the release workflow. The workflow will refuse to publish if the matching What's New page, changelog entry, homepage link, or release-history entry is missing.

## Writing release notes

Write for the consultant using the tool, not for the commit history.

Good release notes answer:

- What changed?
- Why does it matter during real support work?
- Is there anything the consultant needs to do differently?
- Did privacy, storage, permissions, supported Windows versions, or update behavior change?

Keep implementation details in GitHub or developer documentation unless they materially affect the user.
