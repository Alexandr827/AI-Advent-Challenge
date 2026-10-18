# File assistant (Cursor SDK)

Goal-driven local agent that reads, searches, and edits files. Point it at your own project, or at the built-in sample.

The agent uses Cursor’s local runtime (`@cursor/sdk`). It can read and edit files in the directory chosen for the run, and it does not get a shell.

## Prerequisites

- Node.js 20+
- [Cursor API key](https://cursor.com/dashboard/integrations) in `CURSOR_API_KEY`

```bash
cp .env.example .env
# edit .env — CURSOR_API_KEY=...
# optional: CURSOR_MODEL=composer-2.5
```

`.env` is gitignored. Shell variables override values from `.env`.

## Run on your project

Ask in text. The agent finds a directory with that name, copies it into `workspace/`, then edits the copy. The original project stays untouched. Search starts at your home directory, two levels down, and skips dependency folders. Point `PROJECTS_ROOT` at the folder that contains your projects if the name is not found.

```bash
npm run assistant -- "у меня есть проект NodeJSproject. Обнови по нему readme.md на основе последних правок в коде"
npm run save
npm run clean
```

`save` writes the changed workspace files back onto the project they were loaded from. Files that were not changed stay as they are. `node_modules`, `.git`, and `.env` are not written back. `clean` removes imported projects from `workspace/`.

You can still copy a project or a single file yourself. Each import replaces `workspace/`. Dependency folders, `.git`, and `.env` are not copied.

```bash
npm run import -- /path/to/your-project
npm run docs
npm run readme
npm run adr
npm run changelog
```

A single file lands in `workspace/` under its own name:

```bash
npm run import -- /path/to/your-project/src/api.ts
npm run docs -- --file api.ts
```

Or edit the project in place. `--project` must be a directory. `--file` must be a file inside it.

```bash
npm run docs -- --project /path/to/your-project
npm run changelog -- --project /path/to/your-project --file src/api.ts
npm run assistant -- --project /path/to/your-project "describe the public API in docs/api.md"
```

| Command | What it does |
|--------|----------------|
| `npm run assistant -- "<request>"` | Import the named project into `workspace/`, then do the work |
| `npm run save` | Replace changed files in the original project with the workspace copies |
| `npm run clean` | Remove imported projects from `workspace/` |
| `npm run import -- <path>` | Copy a file or project into `workspace/` |
| `npm run docs` | Update documentation so it matches the code |
| `npm run readme` | Create or update `README.md` |
| `npm run adr` | Add an ADR under `docs/adr/` |
| `npm run changelog` | Create or update `CHANGELOG.md` |
| `npm run assistant -- "<goal>"` | Run a custom goal on `workspace/` |

After a run, the CLI prints a diff. An imported workspace is compared with a snapshot taken just before the agent started. `--project` on a git checkout prints `git status` and `git diff` in that repo.

## Demo sample

`scenario:docs` and `scenario:changelog` ignore `workspace/` and reload [fixtures/](fixtures/) first.

```bash
npm run scenario:docs
npm run scenario:changelog
npm run reset
```

The sample is a small catalog library:

- `src/items.ts` — catalog helpers
- `src/quote.ts` — `quote(item, qty, options?)` with currency and discount
- `src/index.ts` — public exports
- `docs/api.md` — intentionally outdated

## Exit codes

- `0` — run finished successfully
- `1` — missing API key, bad arguments, or the agent failed to start (`CursorAgentError`)
- `2` — run started but ended in error or was cancelled
