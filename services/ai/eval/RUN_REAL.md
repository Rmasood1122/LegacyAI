# Requests for a real-model evaluation run

Changing this file on `main` starts `.github/workflows/evaluation.yml` (it does nothing without a key stored as a
GitHub Actions secret). Each request is one line; results are copied into `API_Test/`.

| Date (UTC) | Asked by | Model | Cap | Note |
|---|---|---|---|---|
| 2026-10-03 | owner ("you can use $0.55 more") | claude-haiku-4-5-20251001 | $0.55 | full pipeline run of docs/phase2/09; everything recorded |
| 2026-10-03 | owner (key now stored as a GitHub secret; "$1 only") | claude-haiku-4-5-20251001 | $0.90 | second request: the first found no key and spent nothing |
