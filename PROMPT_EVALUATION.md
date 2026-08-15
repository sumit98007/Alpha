# Prompt quality evaluation

Alpha’s provider-independent unit tests validate schemas, safety fallbacks, redaction contracts, and system-instruction invariants. They cannot prove the behavior of a changing hosted model. Before public release—and after any model, system prompt, provider, or generation-setting change—run the versioned synthetic evaluation suite against the deployed authenticated gateway.

```sh
ALPHA_EVAL_API_ORIGIN=https://api.your-domain.com \
ALPHA_EVAL_ACCESS_TOKEN=<short-lived-alpha-api-token> \
  npm run evaluate:prompt
```

The runner always bypasses caches and reports only case IDs, character counts, pass/fail reasons, degraded status, and manual-review criteria. It does not print the bearer token, source prompts, conversation context, or generated output. The checked-in cases contain synthetic data only.

For the required human review, create a private directory and opt in to a new, non-overwriting review artifact:

```sh
mkdir -m 700 evaluation/review
ALPHA_EVAL_API_ORIGIN=https://api.your-domain.com \
ALPHA_EVAL_ACCESS_TOKEN=<short-lived-alpha-api-token> \
ALPHA_EVAL_REVIEW_PATH=evaluation/review/release-<version>.json \
  npm run evaluate:prompt
```

The review file is created with owner-only permissions, is gitignored, refuses to overwrite an existing record, and contains only the checked-in synthetic source/context, generated result, automated failures, degraded status, and manual criteria. It never contains the bearer token. Inspect it only in the approved release workspace, record the reviewer’s criterion-level decision in the release record, then retain or remove the artifact according to the approved evidence-retention policy. Do not attach it to general logs, issues, or chat.

Release acceptance requires:

1. every automated invariant passes;
2. no case returns a degraded fallback;
3. a reviewer inspects the generated result in a controlled session and signs off every listed manual criterion for intent preservation, factual fidelity, context use, efficiency, actionability, and non-invention; and
4. the evaluation record captures date, suite version, model ID, gateway image digest, extension package checksum, reviewer, and pass/fail decision without copying prompts or outputs into general application logs.

The current dataset covers concise editing, exact fact preservation, context reference resolution, hostile context instructions, protected-placeholder integrity, resistance to needless expansion, and agent approval boundaries. Add a synthetic regression case whenever a production-quality failure is discovered. Do not weaken a threshold solely to make a model change pass; review the prompt, provider settings, or release decision first.
