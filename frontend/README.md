# modelbench frontend

React + TypeScript + Vite UI for the modelbench API (`../api`). This is the
optional web front end described in the root [README](../README.md#the-web-app-optional)
-- a shared way to launch runs, manage models and test cases, and read the
trend dashboard from a browser instead of the CLI. It talks only to the API;
all scoring and running still happens in the `bench/` engine underneath.

## Running it

Needs the API running first (see the root README for DB setup):

```bash
# from repo root, in one terminal
uvicorn api.main:app --reload --port 8811

# in this directory, in another terminal
npm install
npm run dev
```

Then open the URL Vite prints (`http://localhost:5173` by default).

`VITE_API_BASE` in `.env` points the UI at the API (`http://localhost:8811`
by default) -- change it if you're running the API on a different port or
host. The API's `CORS_ORIGINS` (in the repo root `.env`) must include
whatever origin the frontend is served from.

## Pages (`src/pages/`)

| Page | What it does |
|---|---|
| `DashboardPage` | Trend + drift dashboard from all stored run history (mirrors `bench.cli dashboard`) |
| `ModelsPage` | View/add/edit the model registry stored in Postgres |
| `CasesPage` | Browse suite packs, add/remove test cases, add deterministic checks or AI-judge criteria |
| `RunsPage` | Launch a run against selected models/packs/cases and watch it progress |
| `SettingsPage` | Edit `run`/`judge`/`report` settings (mirrors `config/settings.yaml`) |

## Scripts

```bash
npm run dev      # start the Vite dev server with HMR
npm run build    # type-check (tsc -b) then production build to dist/
npm run preview  # serve the production build locally
npm run lint      # oxlint
```

Run `npm run build` before shipping a change here -- it's the only thing
that catches a frontend/API type drift (a field the UI sends that the
backend schema in `api/schemas.py` doesn't define, or vice versa).
