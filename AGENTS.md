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

## House rules specific to this codebase

- **Nothing that decides a bet, computes a score, or settles a wager should ever go through an LLM call.** The target architecture (`developer/production-architecture.md` in the docs repo) is explicit: the trigger grid is deterministic code with tests. If you're adding betting logic, it belongs in a pure function, not a prompt.
- **No secrets in source.** `server.js` currently has a hardcoded odds-API key fallback — known issue, not a pattern to repeat. All keys come from env vars, matching `.env.example`. Note the one real gotcha: the Supabase service key env var is `SUPABASE_SERVICE_KEY`, not `SUPABASE_SERVICE_ROLE_KEY`.
- **Migrations must be checked in.** The anti-sharing schema (`user_sessions`, `login_events`, `trusted_devices`, `device_verification_tokens`, `sharing_flags`) was applied directly to Supabase without ever being committed as a migration — don't repeat that. Any new table or column change gets a numbered file in `migrations/`, not an ad hoc script in `db/` and not a change made only in the Supabase dashboard.
- **No staging environment exists yet.** Every push to `main` deploys straight to production on Railway. Be correspondingly careful — this is how the homepage got wiped once before.
- **Deploy access is currently single-person** (Mike, via GitHub `michaelhannon/actionsodds`). Don't assume CI/CD guardrails that don't exist.
