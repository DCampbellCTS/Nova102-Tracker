# Nova102 Schedule Tracker

Static, self-contained HTML tracker (Project Nova / IND-102 UG conduit drawing pipeline).
Deployed to https://nova102scheduletracker.netlify.app/

Every page load seeds itself from a snapshot baked into index.html at publish time
(SEED_STATE, plus SEED_PUSHED_BY / SEED_PUSHED_AT) rather than reading browser
storage, so every viewer sees the same last-pushed position regardless of device.
Edits a viewer makes in their own browser are local only and are not saved back here.

To publish an update: replace index.html with a new build and push to main —
once this repo is linked to the Netlify site for continuous deployment, that push
triggers the live redeploy automatically.