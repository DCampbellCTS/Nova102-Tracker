# Nova102 Schedule Tracker

Static, self-contained HTML tracker (Project Nova / IND-102 UG conduit drawing pipeline).
Deployed to https://nova102-tracker.hcgbimassistant.com/

Every page load seeds itself from a snapshot baked into index.html at publish time
(SEED_STATE, plus SEED_PUSHED_BY / SEED_PUSHED_AT) rather than reading browser
storage, so every viewer sees the same last-pushed position regardless of device.
Edits a viewer makes in their own browser are local only and are not saved back here.

To publish an update: replace index.html with a new build and push to main —
Cloudflare redeploys https://nova102-tracker.hcgbimassistant.com/ from `main` automatically.
Hosted on Cloudflare Workers behind Cloudflare Access (HCG sign-in), deployed from `main` by Cloudflare's GitHub integration. The old Netlify site was deleted on 2026-10-09.