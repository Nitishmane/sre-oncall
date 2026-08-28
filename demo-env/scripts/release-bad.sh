#!/usr/bin/env bash
# Ship a bad release the way a real one arrives: as a commit on `main` that
# ArgoCD syncs.
#
# The change renames the health endpoint the liveness probe points at, which is
# an ordinary-looking refactor and a classic outage: the container is fine, the
# probe is wrong, so the kubelet kills it every 10s and the deployment falls
# into CrashLoopBackOff.
#
# This is deliberately NOT `kubectl patch`. The agent has to be able to answer
# "what changed?" with a commit, and propose the fix as a pull request against
# it. A cluster-side edit leaves nothing to revert.
#
#   ./release-bad.sh          ship it
#   ./release-bad.sh --revert undo it locally (the agent should open a PR instead)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
manifest="demo-env/k8s/deployment.yaml"
branch="${RELEASE_BRANCH:-main}"
worktree="$(mktemp -d)/sre-oncall-release"

cleanup() {
  git -C "$root" worktree remove --force "$worktree" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Work on a detached copy of the branch so whatever the user has checked out,
# and any uncommitted work in it, is left completely alone.
git -C "$root" fetch origin "$branch" --quiet
git -C "$root" worktree add --quiet --detach "$worktree" "origin/$branch"

if [ "${1:-}" = "--revert" ]; then
  sed -i.bak 's|path: /health,|path: /healthz,|; s|value: "0.2.0"|value: "0.1.0"|' "$worktree/$manifest"
  message="revert: point the liveness probe back at /healthz

This reverts the endpoint rename. The probe was checking /health, which the
service does not serve, so the kubelet killed every container after 10s."
else
  # The rename: /healthz -> /health in the probe only. The service still serves
  # /healthz, so nothing about the image changes — only the manifest lies.
  sed -i.bak 's|path: /healthz, port: http }|path: /health, port: http }|; s|value: "0.1.0"|value: "0.2.0"|' "$worktree/$manifest"
  message="feat(demo-service): standardise the health endpoint on /health

Renames the liveness probe target and bumps the version to 0.2.0."
fi
rm -f "$worktree/$manifest.bak"

if git -C "$worktree" diff --quiet -- "$manifest"; then
  echo "No change to make — the manifest is already in that state." >&2
  exit 0
fi

echo "Change being shipped to $branch:"
git -C "$worktree" --no-pager diff --unified=1 -- "$manifest" | sed 's/^/  /'

git -C "$worktree" add "$manifest"
git -C "$worktree" -c user.name="demo-release-bot" \
  -c user.email="demo-release-bot@users.noreply.github.com" \
  commit --quiet -m "$message"
git -C "$worktree" push --quiet origin "HEAD:$branch"

sha="$(git -C "$worktree" rev-parse --short HEAD)"
cat <<EOF

Shipped $sha to $branch. ArgoCD auto-syncs, so within ~1 minute:
  - the liveness probe starts failing (the service does not serve /health)
  - containers are killed and restart, then CrashLoopBackOff
  - ContainerRestartsSpiking / ReplicasUnavailable fire

Watch it:
  kubectl -n demo get pods -w
  kubectl -n argocd get application demo-service -w

The agent should correlate the alert to this commit and open a revert PR.
EOF
