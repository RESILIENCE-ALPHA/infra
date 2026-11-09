# Runbook: Phase 2e — APISIX gateway under Argo CD

Adopts in place (same namespace `apisix`, same releases and chart versions):

| Argo CD app | What | Change on first sync |
| --- | --- | --- |
| `apisix` | APISIX 3.17 + bundled etcd (chart 2.15.0), admin keys ExternalSecret | Keys read from Secret `apisix-admin-credentials` (rolling restart of APISIX); etcd reuses its JWT key (one etcd restart) |
| `apisix-ingress-controller` | Gateway API controller (chart 1.2.1) | Admin key from the same Secret; admission webhook removed |
| `apisix-config` | GatewayClass, Gateway + listeners, certificates, global rules, ReferenceGrant | None, except the dashboard listener removed (step 6) |

The old `apisix-dashboard` release (0.8.3, retired project) is removed. APISIX's built-in UI
replaces it, reachable only through a port-forward:

```bash
kubectl -n apisix port-forward svc/apisix-admin 9180:9180    # http://localhost:9180/ui/
```

Expected impact: about one minute where APISIX keeps serving traffic from memory but cannot
receive new route changes (etcd restart, APISIX rolling restart). Run from the dev container.

## 0. Pre-checks and Vault

```bash
kubectl -n apisix get pods
kubectl -n apisix get secret apisix-etcd-jwt-token            # must exist (reused by etcd)
pv=$(kubectl -n apisix get pvc data-apisix-etcd-0 -o jsonpath='{.spec.volumeName}')
kubectl patch pv "$pv" -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
kubectl -n apisix get gateway main-gateway -o jsonpath='{range .spec.listeners[*]}{.name}{"\n"}{end}'
for h in app auth payment grafana headlamp argocd vault-ui pgadmin jaeger docs; do
  printf '%-10s ' $h; curl -s -o /dev/null -w '%{http_code}\n' https://$h.karim-portfolio.xyz
done | tee ~/apisix-before.txt
```

Add a random **viewer** key next to the admin key in Vault (the current one is the chart's
public default). Log in with a token that can write `apps/apisix-admin`:

```bash
kubectl -n security exec -it vault-0 -- sh -c \
  'vault login && vault kv patch -mount=apps apisix-admin viewer=$(head -c16 /dev/urandom | od -An -tx1 | tr -d " \n")'
kubectl -n security exec -it vault-0 -- sh -c 'vault login >/dev/null && vault kv get -mount=apps -format=json apisix-admin | grep -o "\"[a-z]*\":" | sort -u'
```

The second command must list `"key":` and `"viewer":` (names only, no values).

## 1. Merge the Phase 2e PR, let Argo CD see it

```bash
kubectl -n argocd annotate application root argocd.argoproj.io/refresh=hard --overwrite
sleep 30
kubectl -n argocd get applications apisix-crds apisix apisix-ingress-controller apisix-config
```

`apisix-crds`, `apisix`, `apisix-ingress-controller`, `apisix-config` all `OutOfSync`. Review each App Diff: nothing deleted except, in
`apisix-ingress-controller`, the webhook configuration and its Secret.

## 1b. Sync `apisix-crds`

APISIX's own CRDs (already installed, adopted in place; never pruned or deleted):

```bash
sync_app apisix-crds
kubectl get crd | grep -c apisix.apache.org        # 11
```

## 2. Sync `apisix`

```bash
sync_app apisix
kubectl -n apisix get externalsecret apisix-admin-credentials     # SecretSynced
kubectl -n apisix get pods                                         # apisix + apisix-etcd-0 Running
```

## 3. Sync `apisix-ingress-controller`

```bash
sync_app apisix-ingress-controller
kubectl -n apisix logs deploy/apisix-ingress-controller --tail=30 | grep -iE "error|401|unauthor" || echo "no errors"
```

## 4. Sync `apisix-config`

```bash
sync_app apisix-config
kubectl -n apisix get gateway main-gateway
kubectl get certificate -A | grep -c True
```

## 5. Check every site

```bash
for h in app auth payment grafana headlamp argocd vault-ui pgadmin jaeger docs; do
  printf '%-10s ' $h; curl -s -o /dev/null -w '%{http_code}\n' https://$h.karim-portfolio.xyz
done | diff ~/apisix-before.txt - && echo "same as before"
```

## 6. Remove the old dashboard

The dashboard listener was applied by `kubectl apply`, so Argo CD's server-side apply does not
remove it on its own:

```bash
kubectl -n apisix get gateway main-gateway -o json \
  | jq '.spec.listeners |= map(select(.name != "https-apisix-dashboard"))' \
  | kubectl replace -f -
helm uninstall apisix-dashboard -n apisix
kubectl -n apisix delete httproute apisix-dashboard-route --ignore-not-found
kubectl -n apisix delete certificate apisix-dashboard-tls --ignore-not-found
kubectl -n apisix delete secret apisix-dashboard-tls --ignore-not-found
```

`helm uninstall` is safe here: the dashboard chart has no CRDs and no data volume. Remove the
`apisix-dashboard` DNS record at your DNS provider too.

## 7. Remove the Helm records of the adopted releases

```bash
kubectl -n apisix delete secret -l owner=helm,name=apisix
kubectl -n apisix delete secret -l owner=helm,name=apisix-ingress-controller
helm list -A      # only argocd
```

## Rollback

Before step 2 nothing changed. If APISIX misbehaves after step 2, set
`apisix.admin.credentials` back to the previous value in a revert PR and sync; the admin key
itself is unchanged (it comes from Vault, the same value as before).
