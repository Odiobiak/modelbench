# modelbench

A small harness for testing text models against each other on the things
that actually decide an enterprise deployment: instruction adherence, tool
calling, grounding, hallucination, state tracking, escalation judgment,
injection resistance, robustness to garbled input, and long context.

Latency, tokens, cost and full model provenance are captured on every call,
automatically, because every call goes through one measured client.

There are two ways to use it, and you only need the first:

- **The CLI/engine** (`bench/`) -- no Docker, no database, no service to
  run. Results live in `results/*.parquet` on disk. Everything in this
  README up to "The web app" is this mode.
- **The web app** (`api/` + `frontend/`) -- an optional FastAPI backend
  backed by Postgres (Supabase by default) plus a React UI, for teams who
  want a shared model/settings registry and a browser instead of the CLI.
  See [The web app](#the-web-app-optional) below. It calls the same
  `bench/` engine underneath and writes the same parquet files.

---

## Setup, once

```bash
pip install -r requirements.txt
cp .env.example .env          # paste your OpenRouter key
```

One key is enough. OpenRouter fronts hundreds of models and reports which
upstream actually served each request, the token breakdown including cached
and reasoning tokens, and the real cost.

Verify without spending anything:

```bash
python -m bench.cli run --mock
```

That exercises the entire pipeline offline: 64 cases, all scorers, parquet
write, scorecard render. Zero keys, zero spend.

---

## Daily use

```bash
python -m bench.cli models       # what's registered, and is it reachable
python -m bench.cli packs        # the suites
python -m bench.cli estimate     # projected spend, before you spend it
python -m bench.cli run          # the real thing
python -m bench.cli report --all # rebuild the scorecard from all history
python -m bench.cli dashboard    # trend + drift dashboard from all history
python -m bench.cli latency      # absolute latency probe (direct routes only)
```

Want to see the dashboard before you have weeks of data? `python tools/seed_history.py`
generates six weeks of synthetic runs with a latency regression, a price rise and
a silent model swap planted in them, so you can confirm the drift detector works.
Delete `results/` before your first real run.

`report --all` and `dashboard` exclude `--mock` rows by default. A mock run is a
pipeline smoke test with canned responses, not a model result, and folding it
into aggregate history corrupts `$/success` and reads to the drift detector as a
real regression against every model in the run. Pass `--include-mock` to either
command if you deliberately want to inspect dry-run data.

Narrow a run:

```bash
python -m bench.cli run --models claude-haiku-4.5,gpt-4.1-nano --packs 02_tool_calling --repeats 5
```

---

## Adding a model that dropped this morning

Open `config/models.yaml`, add two lines:

```yaml
  - id: whatever-you-want-to-call-it
    model: vendor/model-slug
```

Then:

```bash
python -m bench.cli run --models whatever-you-want-to-call-it
```

That is the whole workflow. Vendor, pricing, context window, tool support and
the canonical version are discovered from the live model catalogue at run time
and stamped onto every result row. You never hand-maintain a price list, and
the new model is immediately comparable to everything you have ever tested
because the other models' results are already stored.

---

## What gets captured on every single call

132 columns per row. The groups that matter:

| Group | Fields |
|---|---|
| **Provenance** | model alias, requested, **served**, canonical id, vendor, **served-by provider**, family, version string |
| **Capability** | context window, max output, tools, JSON mode, reasoning, prompt caching, tokenizer |
| **Pricing** | input / cached-input / output / reasoning per Mtok, **snapshotted at run time** |
| **Routing** | route, endpoint, region, deployment type, tags |
| **Request** | temperature, top_p, max tokens, seed, system prompt hash, tools offered |
| **Case** | pack, pack version, case id, tags, difficulty, repeat index, turn count |
| **Latency** | TTFT, total, TPOT, tokens/sec, retry time |
| **Tokens** | prompt, **cached**, completion, **reasoning**, total, cache hit ratio |
| **Cost** | input, cached, output, total, and whether it was gateway-reported or computed |
| **Reliability** | HTTP status, ok, error type, retry count, **rate limited** |
| **Scoring** | passed, per-metric scores, failed assertions, judge model + version |
| **Runtime** | harness version, python, host, CI flag, git sha |

`model_served` and `served_by_provider` are not the same as what you asked
for. Keep them whenever you quote a result.

---

## The nine packs

| Pack | Proves | Headline metric |
|---|---|---|
| `01_instruction_following` | obeys format, length, language and brand constraints | format compliance |
| `02_tool_calling` | right tool, right args, **invents nothing** | tool accuracy, hallucinated-call rate |
| `03_grounding_rag` | stays inside supplied context | faithfulness, correct refusal |
| `04_hallucination` | unanswerable, false premise, fictional entity | fabrication rate |
| `05_multiturn_state` | slot retention, corrections, negation, topic switch | slot retention |
| `06_escalation` | escalates when it should, **and not when it shouldn't** | escalation precision + recall |
| `07_safety_injection` | resists indirect injection, no prompt or PII leak | attack success rate |
| `08_robustness` | typos, ASR garbling, disfluency, code-switching | intent stability |
| `09_long_context` | needle at depth, distractors, multi-hop, cost curve | retrieval accuracy |

Packs 04, 06 and 07 each contain a **control case** that a
refuse-everything model would fail. Without those, over-refusal reads as
safety.

Pack 08 is the one that predicts voice behaviour without running voice. ASR
output is garbled text; a model that needs clean input will look fine in a
webchat pilot and fall over on the phone.

---

## Latency: relative vs absolute

This matters and it is easy to get wrong.

A call through OpenRouter includes an extra network hop. Those numbers are
**valid for ranking models against each other**, since every model pays the same
tax, and **must never be quoted to a customer as absolute latency**.

`bench latency` refuses to run on gateway-routed models unless you pass
`--allow-gateway`, and labels the output either way. For a number you will commit
to in a contract, add a `route: direct` entry pinned to the region and deployment
type your customer actually gets, then probe that:

```bash
python -m bench.cli latency --models azure-gpt-4.1-nano-swedencentral --repeats 30
```

The probe uses `suites/00_latency_probe.yaml`: trivially answerable prompts at
three controlled sizes with output forced short, so you are measuring
time-to-respond rather than how chatty a model is. Results break out by prompt-size
tier, because TTFT scales with input length and a single blended number hides it.

Every row carries `latency_authoritative`, so the dashboard can tell the two
apart and say which basis it is showing.

## Reading the scorecard

`results/scorecard.html`. It is a decision matrix, not a leaderboard. There is
rarely one winner. Read it by column: the model for a regulated workload is
the one that wins grounding and hallucination, not the one with the best
average.

**`$/success` is the headline economic figure**: total spend divided by cases
actually passed. A model that is cheaper per token but fails more often lands
higher here, which is correct and is the whole point.

---

## The dashboard

`python -m bench.cli dashboard` builds `results/dashboard.html` from all stored
history. One self-contained file, inline SVG, no CDN, no build step, works from
disk and follows your system theme.

The scorecard answers "which model is best today". The dashboard answers the
question that actually protects you: **what changed, and when**.

- **Drift vs baseline** at the top. Each model's latest run is compared against
  the median of its previous four runs, not against the single previous run. A
  consecutive-run check only catches a regression on the day it lands; a shift
  that arrived two runs ago and stayed looks like "no change" to it. That is the
  failure you least want, so the baseline method is used instead.
- **Served-model change** is always a critical alert. When a provider repoints a
  stable alias at a new build, every comparison across that line is invalid until
  you re-baseline.
- **Price changes** are alerted too, since every cost figure before that point
  used the old rate.
- **Trends** for pass rate, TTFT p95, cost per success and cache hit ratio, with
  target lines and hover crosshairs.
- **Full table** below the charts, always present, so nothing is readable only
  by colour.

## Running it off your laptop

`.github/workflows/bench.yml` runs the suite weekly and on demand. Set
`OPENROUTER_API_KEY` as a repository secret. Parquet history is committed so
drift shows up as a diff; scorecards are uploaded as artifacts.

The weekly run is not busywork. Providers change models behind stable aliases.
A scheduled bench is how you find out before a customer does.

---

## The web app (optional)

Everything above is the CLI, and it's the whole product if you're one person
running benches from a terminal. `api/` and `frontend/` add a shared,
browser-based front end on top of the same engine -- useful once more than
one person needs to launch runs, edit test cases, or read the dashboard
without a Python environment.

The API stores the model registry, settings and run index in Postgres
(Supabase by default); run results themselves still land in
`results/*.parquet` exactly as the CLI writes them, so `bench.cli report`
and `bench.cli dashboard` keep working whether or not the API is running.

Setup, once you have the CLI working:

```bash
# 1. Add SUPABASE_URL / SUPABASE_SERVICE_KEY / DATABASE_URL / DIRECT_URL to
#    .env -- a free Supabase project works. Then apply the schema:
psql "$DIRECT_URL" -f api/migrations/0001_init.sql
psql "$DIRECT_URL" -f api/migrations/0002_suites.sql
psql "$DIRECT_URL" -f api/migrations/0003_run_case_keys.sql

# 2. (optional) pull your existing config/models.yaml, config/settings.yaml
#    and any results/*.parquet history into the DB, so the UI starts from
#    what you already have instead of empty tables:
python -m api.migrate.import_existing

# 3. Run the backend (frontend/.env points the UI at port 8811 by default):
uvicorn api.main:app --reload --port 8811

# 4. Run the frontend, in another terminal:
cd frontend && npm install && npm run dev
```

The frontend's API base is `VITE_API_BASE` in `frontend/.env` (defaults to
`http://localhost:8811`; see `frontend/src/api/client.ts`), and the API
allows CORS from `http://localhost:5173` by default (`CORS_ORIGINS` in
`.env` to change it).
Once both are up: `http://localhost:5173` gives you Dashboard, Models, Packs
(test cases), Runs and Settings pages backed by the same registry and the
same scorers as the CLI.

`GET /health` is the liveness check; `GET /docs` is the interactive OpenAPI
explorer FastAPI generates for every route.

---

## Guardrails already built in

- **Spend ceiling.** `--dry-run` style projection via `estimate`, plus a hard
  runtime ceiling from `config/settings.yaml` and `BENCH_MAX_SPEND_USD`.
  The run aborts mid-flight rather than overrunning.
- **Judge injection containment.** Untrusted model output and context reach
  the judge inside explicit delimiters that are stripped from the content
  first, so a safety case cannot rewrite its own grade.
- **Judge version pinning.** Judge model and served version go on every row.
- **Judge calibration queue.** 10% of judged rows are sampled into
  `results/calibration_queue.jsonl` for you to hand-label. An uncalibrated
  judge is noise; this is the cure.
- **Rate-limit flagging.** A throttled model looks slow. 429s are recorded
  separately so they do not masquerade as latency.
- **Non-zero temperature by default.** You will not deploy at 0. Testing at 0
  hides the variance you will ship with.

## Things to stay honest about

- **Prompt caching skews cost.** Watch `avg_cached_tokens` and
  `cache_hit_ratio`. A model that looks cheap because your prompt caches well
  will not stay cheap when the prompt changes.
- **Never judge with a model under test.** Self-preference bias is large
  enough to change rankings. `config/settings.yaml` pins a separate judge.
- **Time of day matters.** Provider latency varies with load. Compare runs
  taken at similar times, or run weekly and read the trend, not one snapshot.
- **Suite rot.** Refresh cases from real traffic quarterly or you optimise for
  a snapshot of last year's problems.
- **Keys.** `.env` will hold several live provider keys. It is gitignored;
  keep it that way, scope the keys, and prefer the single OpenRouter key over
  six direct ones.
