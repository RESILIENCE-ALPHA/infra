# Runbook: External Secrets → Vault with Kubernetes authentication (Phase 5.5c)

Before: External Secrets used a static Vault token (Secret `security/vault-token`): first the root
token (leaked in a chat on 2026-11-14, revoked the same day), then a read-only token that expires
after 32 days. After: External Secrets authenticates with its service account; Vault verifies it with
the Kubernetes TokenReview API. Nothing static to store or rotate.

| Vault object | Value |
| --- | --- |
| Auth method | `kubernetes/` (`kubernetes_host=https://kubernetes.default.svc:443`; CA and reviewer JWT from Vault's own pod) |
| Role | `external-secrets`: service account `external-secrets` in `security`, policy `external-secrets-read`, token TTL 1 h |
| Policy | `external-secrets-read`: read `apps/data/*`, read/list `apps/metadata/*` (created on 2026-11-14) |

All `vault` commands below use the root token from the password manager, read into `$ROOT`
(never printed, never pasted in a chat).

## 0. Pre-checks · dev container

```bash
kubectl -n security get sa external-secrets                        # exists
kubectl get clusterrolebinding -o wide | grep -i vault             # vault-server-binding -> system:auth-delegator
read -rs ROOT; case "$ROOT" in hvs.*) echo "format OK";; *) echo "STOP";; esac
```

## 1. Configure Vault (before merging)

```bash
V() { kubectl -n security exec -i vault-0 -- env VAULT_TOKEN="$ROOT" vault "$@"; }
V auth list | grep -q '^kubernetes/' || V auth enable kubernetes
V write auth/kubernetes/config kubernetes_host="https://kubernetes.default.svc:443"
V write auth/kubernetes/role/external-secrets \
  bound_service_account_names=external-secrets bound_service_account_namespaces=security \
  policies=external-secrets-read ttl=1h
V read -format=json auth/kubernetes/role/external-secrets | jq -c '.data | {bound_service_account_names, bound_service_account_namespaces, policies}'
```

Test the login as External Secrets would (prints only the policies):

```bash
SA_JWT=$(kubectl -n security create token external-secrets --duration=10m)
V write -format=json auth/kubernetes/login role=external-secrets jwt="$SA_JWT" | jq -c '.auth.policies'
unset SA_JWT
```

Expected: `["default","external-secrets-read"]`.

## 2. Merge the PR, check

```bash
kubectl -n argocd annotate application root argocd.argoproj.io/refresh=hard --overwrite; sleep 60
kubectl get clustersecretstore vault-backend                        # Valid, READY True
for es in $(kubectl get externalsecret -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{" "}{end}'); do
  kubectl -n "${es%/*}" annotate externalsecret "${es#*/}" force-sync=$(date +%s) --overwrite >/dev/null; done
sleep 20; kubectl get externalsecret -A | grep -v SecretSynced || echo "all SecretSynced"
```

Then check which auth the live store really uses:

```bash
kubectl get clustersecretstore vault-backend -o jsonpath='{.spec.provider.vault.auth}{"\n"}'
```

If `tokenSecretRef` is still there next to `kubernetes` (it was on 2026-11-14: the field had been
written by an old `kubectl apply`, so Argo CD's server-side apply could not remove it, and External
Secrets uses `tokenSecretRef` first), remove it by hand and run the checks again:

```bash
kubectl patch clustersecretstore vault-backend --type=json \
  -p='[{"op":"remove","path":"/spec/provider/vault/auth/tokenSecretRef"}]'
```

## 3. Remove the static token

Only once step 2 shows `all SecretSynced`:

```bash
kubectl -n security exec vault-0 -- env VAULT_TOKEN="$(kubectl -n security get secret vault-token -o jsonpath='{.data.token}' | base64 -d)" \
  vault token revoke -self && echo "static token revoked"
kubectl -n security delete secret vault-token
unset ROOT
```

Check once more that every ExternalSecret still syncs (the loop of step 2).

Done on 2026-11-14: store `Valid`, all ExternalSecrets synced with Kubernetes auth, static token
revoked and Secret `vault-token` deleted. No Vault token is stored in the cluster anymore.
