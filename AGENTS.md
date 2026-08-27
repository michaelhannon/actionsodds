# AGENTS.md — Action$ Odd$

Instructions for any AI coding agent (Claude Code, Codex, Cursor, etc.) working in this repository.

## The documentation repo is the source of truth — read it first

Full business context, architecture, and an ongoing audit trail live in a **separate repo**, not in this one:

- **GitHub:** https://github.com/kavimade/actionsodds-docs (private)
- **Local (this machine):** `~/scworkspace/actions-odds-docs`

If that path doesn't exist in your environment, clone it: `git clone https://github.com/kavimade/actionsodds-docs`

Read `business/README.md` and `developer/README.md` there before making non-trivial changes here — in particular, **`developer/architecture.md`** (current verified state) and **`audit/2026-08-27-repo-review/02-known-conflicts.md`** (the trigger-system spec actively disagrees with itself across three sources — do not assume any single doc, including this repo's own `docs/` folder, is current without checking that page first).

## Mandatory: update the docs repo alongside code changes

This project's biggest recurring failure mode — documented repeatedly in its own history — is **drift**: the deployed app quietly diverging from what the operator (Kenny) actually runs, multiple copies of the same file, specs that contradict each other with no note of which won. The docs repo exists specifically to stop that. Treat updating it as part of the task, not a follow-up.

**Update the docs repo in the same session, whenever you:**

- Change or add an API endpoint, cron job, or scheduled job
- Add, remove, or rename an environment variable
- Write or apply a database migration, or change table/column structure
- Touch the trigger/scoring system (`morning-scan.js` or anything implementing T1–T16/overlays) — update `developer/trigger-system.md` and note whether the change resolves or adds to the known spec conflicts
- Add, remove, or reconfigure a third-party service/integration
- Change the deploy process, add a staging environment, or change auth/session behavior
- Discover something during a code review or debugging session that contradicts what a doc claims (a stale status, a missing file the docs assume exists, a hardcoded secret, etc.) — this belongs in a **new dated folder under `audit/`**, not a silent edit to an old page

**Skip the doc update for:** pure styling/copy changes, internal refactors with no behavioral change, or anything that doesn't change what a reader of the docs would believe about the system.

## How to update it

1. Edit the relevant file(s) directly in `~/scworkspace/actions-odds-docs` (or the freshly-cloned copy).
2. New findings from reading code/infra go under a **dated** folder: `audit/YYYY-MM-DD-<short-name>/`. Don't overwrite a previous finding — add a new one and cross-reference it if it supersedes something.
3. Mark confidence explicitly: **verified today** vs. **per some other doc, not re-checked** vs. **discrepancy** — this repo has been burned before by treating unverified claims as current fact.
4. Commit with a message describing what was verified or changed, and push to `kavimade/actionsodds-docs`.

## Secrets — Railway is the source of truth, chat/files are never a store

This project has already leaked one API key by hardcoding it in `server.js` as a fallback value (see the docs repo audit). The rules below exist specifically to stop that from happening again.

- **Never display a real secret value** — API key, password, token, webhook secret, DB connection string, anything — in chat output, a code comment, a commit message, a markdown doc, or any file other than a developer's own local `.env` (gitignored, never committed). If a command would print one to stdout, redirect it to a file or otherwise suppress the output instead of letting it appear in a terminal/tool response. When confirming a secret is set, report the variable **name** and that it's present (optionally its length) — never the value.
- **Railway → Variables is the single source of truth for every production secret.** Whenever you add, change, or rotate a secret as part of a task, push it to Railway — don't leave it sitting only in a local `.env` while production drifts out of sync. If you don't have Railway access to do this yourself, say so explicitly and hand off the exact variable name (never the value) for whoever does.
- **`.env.example` is the checked-in template** — variable names and placeholder values only, kept up to date whenever a var is added, renamed, or removed. Real values never go here.
- **Never hardcode a fallback secret value in source**, even "just for local dev" — that's exactly how the odds-API key leak happened. Missing env vars should fail the app closed at boot (see `server/auth.js` and the `ODDS_API_KEY` check in `server.js` for the existing pattern), not silently fall back to a baked-in value.
- Note the one real env-var-naming gotcha in this codebase: the Supabase service key env var is `SUPABASE_SERVICE_KEY`, not `SUPABASE_SERVICE_ROLE_KEY`.

## House rules specific to this codebase

- **Nothing that decides a bet, computes a score, or settles a wager should ever go through an LLM call.** The target architecture (`developer/production-architecture.md` in the docs repo) is explicit: the trigger grid is deterministic code with tests. If you're adding betting logic, it belongs in a pure function, not a prompt.
- **Migrations must be checked in.** The anti-sharing schema (`user_sessions`, `login_events`, `trusted_devices`, `device_verification_tokens`, `sharing_flags`) was applied directly to Supabase without ever being committed as a migration — don't repeat that. Any new table or column change gets a numbered file in `migrations/`, not an ad hoc script in `db/` and not a change made only in the Supabase dashboard.
- **No staging environment exists yet.** Every push to `main` deploys straight to production on Railway. Be correspondingly careful — this is how the homepage got wiped once before.
- **Deploy access is currently single-person** (Mike, via GitHub `michaelhannon/actionsodds`). Don't assume CI/CD guardrails that don't exist.
