# PrimePlot Backend — Working Rules

## Before starting work
1. Read `docs/PROGRESS.md` (current status, next step, open decisions).
2. Read `docs/ARCHITECTURE.md` (locked decisions and domain rules). Do not go outside what it says. To change anything, take the owner's approval first.

## Working rules
- Stack: Node ≥ 24, Express 5, port 5030, ESM, pure JavaScript, Mongoose. No TypeScript.
- Modular MVC: `src/modules/<name>/` → routes → controller → service → model (+ validation).
- Every schema uses `baseSchema` plugin (`orgId` required). Every query is scoped by `orgId`.
- Money is always integer poisha. Phone numbers are E.164. Ledger is append-only.
- No Redis. Background work uses the Mongo job scheduler (`src/jobs/`).
- File storage only through the `integrations/storage` adapter.
- Make targeted, minimal changes; no full-file rewrites (except new files).
- Before delivery: run syntax verification on changed files (`node --check <file>`, or `npx esbuild <file> --log-level=error > /dev/null`), and the relevant tests.
- Write API contracts in `docs/API.md` before frontend work starts.

## At the end of every task (mandatory)
1. Update `docs/PROGRESS.md`: checkboxes, "Current status", "Next step", Session Log entry.
2. Report to the owner **in Bangla**, in 3 sections:
   - **কী করেছি** (what changed, and which files)
   - **আপনার করণীয়** (env values, accounts, commands, manual tests)
   - **পরের ধাপে কী করব** (detailed)
3. At phase milestones, sync the updated docs to the claude.ai Project docs (`primeplot/`).
