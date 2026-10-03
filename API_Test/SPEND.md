# Spend with the Anthropic key (owner's limit: under $2 in total)

Computed from the token counts the provider returned and the price table in `services/ai/app/ai_gateway/prices.yaml`. Compare with the provider's own usage page.

| Run (UTC) | What | Calls | Cost (USD) | Running total (USD) |
|---|---|---|---|---|
| 20261003T131712Z | smoke test, no database | 3 | 0.002966 | 0.002966 |
| 20261003T132213Z | model behaviour, no database: questions | 88 | 0.163962 | 0.166928 |
| 20261003T132338Z | model behaviour, no database: judge | 39 | 0.031271 | 0.198199 |
| 20261003T132438Z | model behaviour, no database: interview | 30 | 0.024140 | 0.222339 |
| 20261003T132655Z | model behaviour, no database: interview | 30 | 0.026050 | 0.248389 |
| 20261003T132951Z | model behaviour, no database: readiness | 70 | 0.086057 | 0.334446 |
| 20261003T133249Z | model behaviour, no database: readiness | 70 | 0.068596 | 0.403042 |
| 20261003 (GitHub run 37117933999) | full pipeline evaluation requested, cap $0.55: NOT RUN - no key stored as a GitHub secret | 0 | 0.000000 | 0.403042 |
| 20261003T111436Z (GitHub run 37118690255) | FULL PIPELINE evaluation on GitHub (cap $0.90), cost from the service's own ledger | 212 | 0.238481 | 0.641523 |
