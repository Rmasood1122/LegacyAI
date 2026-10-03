# API_Test — every call made with the owner's AI key

Rules set by the owner on 2026-10-03: use the Anthropic key from the local `.env` without reading or printing it;
stay **under $2 in total**; save every test run made with the key here.

- `SPEND.md` — one line per run with its cost and the running total (currently **$0.403**).
- `*-anthropic-smoke.json` — three first calls that showed the key and the request format work.
- `*-anthropic-model-behaviour-<part>.json` — the evaluation runs: for every call the prompt version, the raw
  output, the token counts and the cost; plus the per-question results.
  The first `interview` file is the run that exposed a bug (15 outputs rejected); the second is the re-run after the fix.
  The first `readiness` file used question prompt v1; the second used v2.

No file here contains the key: the scripts refuse to save a record in which the key text appears.
The scripts: `services/ai/eval/api_test.py` and `services/ai/eval/api_eval.py`. They refuse to start a call if the
recorded total plus that call's worst case could pass the limit. Results are explained in `docs/phase2/EVALUATION.md`.

Data sent to the provider: only the invented "Northfield Bottling Plant (FICTIONAL)" material in
`services/ai/eval/golden/`.
