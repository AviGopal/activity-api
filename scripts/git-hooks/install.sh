#!/usr/bin/env bash
#
# Install the metabob-activity-api git hooks for this clone.
#
# Sets `core.hooksPath` to scripts/git-hooks so the versioned hooks here run
# on commit. Idempotent. Run after a fresh clone or after pulling new hooks.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK_DIR="scripts/git-hooks"

cd "$REPO_ROOT"

if [[ ! -d "$HOOK_DIR" ]]; then
  echo "error: $HOOK_DIR not found; run from the metabob-activity-api repo root." >&2
  exit 1
fi

chmod +x "$HOOK_DIR"/* 2>/dev/null || true

git config core.hooksPath "$HOOK_DIR"
echo "core.hooksPath -> $HOOK_DIR"
echo "hooks: $(ls "$HOOK_DIR" | grep -v '\.\(md\|sh\)$' | tr '\n' ' ')"

if ! command -v gitleaks >/dev/null 2>&1; then
  cat <<'EOF'

note: gitleaks is not installed; the pre-commit hook will skip the secrets
      scan and print a hint until you install it.
      install:  brew install gitleaks
                go install github.com/gitleaks/gitleaks/v8@latest
                https://github.com/gitleaks/gitleaks/releases
EOF
fi
