# metabob-activity-api git hooks

Versioned git hooks for the activity-api vessel. Installed by running:

```bash
scripts/git-hooks/install.sh
```

This sets `core.hooksPath` to `scripts/git-hooks/` so updates to the hooks land via `git pull`. Same pattern as the `metabob-devbob` super-repo and the deployment repo.

## Philosophy

metabob-activity-api is the **trace store + Thompson Sampling learner** — a TypeScript / Bun / Hono backend that records execution traces and resolves activity-related impulse shapes. Its tree holds:

- `src/` — Hono routes, services, models, websocket broadcasters
- `sql/`, `migrations/` — SurrealDB schema migrations
- `test/`, `tests/` — real test suites
- `scripts/` — operational migration runners + smoke tests
- `activities/` — activity templates that ship with the vessel
- `docs/` — stateless reference documentation
- `packages/` — shared packages (if any)
- `.github/` — CI workflows

Anything else accumulates as cruft. The pre-commit hook rejects new cruft at commit time. Existing files are grandfathered — the hook only checks newly-added or renamed-into entries.

## Where things go

| You have | Put it in |
|---|---|
| Stateless reference doc | `docs/<topic>.md` |
| Migration script | `scripts/apply-migration-NNN.sh` + `sql/migrations/NNN-name.surql` |
| Operational helper script | `scripts/<verb>-<noun>.sh` (only if durable) |
| Unit / integration test | `test/<area>.test.ts` |
| Activity template | `activities/<id>.json` |
| Screenshots / playwright output | gitignored — these are session artefacts |
| Status snapshot, fix-complete, investigation note | nowhere — write a commit message instead |
| Helm chart, k8s manifest | the deployment repo, not here |

## What the pre-commit hook does

The hook runs two layers, in order:

1. **Placement check** — rejects newly-added or renamed-into entries that violate the placement rules below. Pre-existing files are grandfathered.
2. **Secrets scan (`gitleaks protect --staged`)** — uses the repo's `.gitleaks.toml` ruleset. If gitleaks isn't installed, the scan is skipped with a one-line install hint.

Bypass with `git commit --no-verify`. Use sparingly.

## What the pre-commit hook blocks

A commit is rejected when it adds (or renames into) a file that violates any of these rules:

1. **Files at the vessel root** are limited to a small allowlist of project metadata: `CLAUDE.md`, `README.md`, `package.json`, `package-lock.json`, `bun.lock`, `bunfig.toml`, `tsconfig.json` (and variants), `jsconfig.json`, `Dockerfile` (and variants), `.gitignore`, `.gitleaks.toml`, `.dockerignore`, `.eslintrc.*`, `.prettierrc.*`, `.nvmrc`, `.env.example`, `vitest.config.ts`, `vessel.json`, `index.js`/`index.ts`. Everything else needs a home.
2. **No new top-level markdown** outside `docs/`. The exceptions are `CLAUDE.md`, `README.md`, `CHANGELOG.md`, `LICENSE.md`.
3. **No new YAML at root** (CI configs go in `.github/workflows/`; helm/k8s manifests live in the deployment repo).
4. **No new ad-hoc scripts at root** (`*.sh`, `*.ts`, `*.js`, `*.py`). Source goes in `src/`; scripts in `scripts/`; tests in `test/`.
5. **No new test/verify/validate files at root**. Tests go in `test/` or `tests/`.
6. **No new image / video / archive files** anywhere outside `docs/assets/` or `public/`.
7. **No new top-level directories** outside the allowed set (`src`, `test`, `tests`, `docs`, `scripts`, `sql`, `migrations`, `activities`, `packages`, `public`, `.github`, `.minibob`, `.archive`).

## Gitleaks

`gitleaks protect --staged --redact --no-banner` runs after a successful placement check. The redact flag masks matched secrets in the output so the terminal scrollback doesn't itself become a leak source.

`.gitleaks.toml` carves out `node_modules/`, `bun.lock`, `package-lock.json`, and adds custom rules for Metabob API keys (`mb-...`) and Anthropic keys (`sk-ant-...`).

Install:

```bash
brew install gitleaks                                      # macOS
go install github.com/gitleaks/gitleaks/v8@latest          # Go toolchain
# or grab a binary: https://github.com/gitleaks/gitleaks/releases
```

If gitleaks is not on `PATH` the hook prints an install hint and lets the commit through. The first defence against credential leaks remains the `.gitignore` patterns; gitleaks is the second.

## What the pre-commit hook does NOT do

- It does not run `bun test`, `bun run typecheck`, or `bun run lint`.
- It does not validate SurrealQL migrations.
- It does not deploy.

CI/CD runs lint / test / typecheck on push to `dev` (canary deploy via the deployment repo). The local hook is for tree cleanliness only.

## Bypass

```bash
git commit --no-verify
```

Use sparingly. The rules exist to keep `git blame` readable; bypassing routinely undoes that.

## Extending the rules

Edit `scripts/git-hooks/pre-commit`:

- `ROOT_ALLOWLIST` — exact-name files allowed at the vessel root.
- `ALLOWED_TOPLEVEL_DIRS` — directories allowed at the vessel root.
- `ARTEFACT_EXTENSIONS` — pipe-separated extensions treated as binary artefacts.

Add a comment explaining the change so future readers understand the carve-out.

## Related

- The super-repo (`metabob-devbob`) has a parallel hook at `scripts/git-hooks/pre-commit` with super-repo-appropriate placement rules.
- The deployment repo has a parallel hook at `scripts/git-hooks/pre-commit` with helm/charts-appropriate placement rules.
- The previous `lefthook.yml` was an unwired hook config from before this versioned hook system; it was removed in the cruft sweep that preceded this hook installation.
