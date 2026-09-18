#!/usr/bin/env bash
set -euo pipefail

WORK_REMOTE="exp"
WORK_URL="https://github.com/nazar-exp/EXP-IP-Scanner.git"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Run this from your EXP-IP-Scanner git clone."
  exit 1
fi

current_repo=$(git remote get-url origin 2>/dev/null || true)
if [[ "$current_repo" != *"kingnazz/EXP-IP-Scanner"* ]]; then
  echo "This bootstrap is intended to run from the kingnazz/EXP-IP-Scanner clone."
  echo "origin is currently: $current_repo"
  exit 1
fi

echo "Updating the source clone..."
git checkout main
git pull --ff-only origin main

if git remote get-url "$WORK_REMOTE" >/dev/null 2>&1; then
  git remote set-url "$WORK_REMOTE" "$WORK_URL"
else
  git remote add "$WORK_REMOTE" "$WORK_URL"
fi

echo "Pushing full main history to the EXP-owned repository..."
git push "$WORK_REMOTE" main --force

echo "Pushing release tags..."
git push "$WORK_REMOTE" --tags --force

cat <<'EOF'

Bootstrap push complete.

Next:
1. In nazar-exp/EXP-IP-Scanner, enable:
   Settings -> Pages -> Build and deployment -> Source -> GitHub Actions

2. In kingnazz/EXP-IP-Scanner, add the Actions secret EXP_MIRROR_TOKEN.
   Use a classic PAT from the kingnazz account with the public_repo scope.

3. In nazar-exp/EXP-IP-Scanner, run:
   Actions -> Sync EXP work mirror -> Run workflow

After that, future source changes and releases sync automatically.
EOF
