# Review screenshots

Screenshots of the download website, captured from `/site` for pull-request
review. They are not served by the site or referenced by the application; the
site's own screenshots live in `site/assets/shots/` and are regenerated from the
real interface with `npm run screenshots`.

Recapture these with the site served locally:

```bash
npx serve site -l 4174 &
npm run verify-site     # confirms the page is sound first
```
