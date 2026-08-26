#!/usr/bin/env bash
# Register the demo service as an ArgoCD Application pointed at this repository,
# and mint the API token the ArgoCD MCP uses.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

repo_url="${REPO_URL:-$(git -C "$root" remote get-url origin 2>/dev/null || true)}"
if [ -z "$repo_url" ]; then
  echo "No git remote found. Push this repository first, or run:" >&2
  echo "  REPO_URL=https://github.com/<owner>/<repo> $0" >&2
  exit 1
fi
# ArgoCD wants the https clone URL, not the ssh form.
repo_url="${repo_url/git@github.com:/https://github.com/}"
repo_url="${repo_url%.git}"

echo "Pointing the ArgoCD application at $repo_url"
sed "s|REPO_URL_PLACEHOLDER|$repo_url|" "$root/demo-env/argocd/application.yaml" | kubectl apply -f -

echo
echo "ArgoCD admin password:"
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' | base64 -d; echo

cat <<EOF

Next, for the ArgoCD MCP:
  1. kubectl -n argocd port-forward svc/argocd-server 8443:443 &
  2. argocd login localhost:8443 --username admin --password <the password above> --insecure
  3. argocd account generate-token --account admin > /dev/null   # then copy it
  4. put it in .env:
       ARGOCD_BASE_URL=https://localhost:8443
       ARGOCD_API_TOKEN=<token>

Sync the app (this is the "deploy" the agent correlates against):
  argocd app sync demo-service
EOF
