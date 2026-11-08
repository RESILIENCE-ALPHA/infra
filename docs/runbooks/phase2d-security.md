# Runbook: Phase 2d — security stack under Argo CD

Target layout:

| Namespace | Components | Before |
| --- | --- | --- |
| `security` | Vault (+ UI route), External Secrets, cert-manager, ClusterIssuers, ClusterSecretStore | Vault only |
| `security-apps` | Falco + falcosidekick | Falco was in `security` |

Vault does **not** move: it is adopted in place, never restarted (StatefulSet `OnDelete`), so it
stays unsealed. External Secrets and cert-manager are reinstalled in `security` by Argo CD; their
CRDs, your ExternalSecrets, Certificates and synced Secrets stay as they are. Falco is reinstalled
in `security-apps`.

**Never run `helm uninstall` on external-secrets or cert-manager**: it can delete their CRDs, and
with them every ExternalSecret / Certificate and the Secrets they own. Old copies are removed by
deleting their namespaced objects only (step 7 and 8).

Run everything from the dev container. Expect a few minutes during which ExternalSecrets are not
refreshed and new certificates are not issued (existing Secrets and certificates keep working).

## 0. Pre-checks

```bash
kubectl -n security get sts vault -o jsonpath='{.spec.updateStrategy.type}{"\n"}'   # OnDelete
kubectl -n security exec vault-0 -- vault status | grep -E 'Initialized|Sealed'     # true / false
kubectl -n security get pod vault-0                                                 # note its AGE
pv=$(kubectl -n security get pvc data-vault-0 -o jsonpath='{.spec.volumeName}')
kubectl patch pv "$pv" -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
kubectl get externalsecret -A        # note: all SecretSynced
kubectl get certificate -A           # note: all READY True
```

Stop if the update strategy is not `OnDelete` or Vault is sealed.

## 1. Copy the secrets the moved operators need into `security`

```bash
copy_secret() {   # copy_secret <from-namespace> <name>  -> same name in security
  kubectl -n "$1" get secret "$2" -o json \
  | jq 'del(.metadata.uid,.metadata.resourceVersion,.metadata.creationTimestamp,.metadata.managedFields,.metadata.ownerReferences,.metadata.annotations)
        | .metadata.namespace="security"' \
  | kubectl create -f -
}
copy_secret external-secrets vault-token                  # Vault token used by the ClusterSecretStore
copy_secret cert-manager letsencrypt-prod-account-key     # keeps the same Let's Encrypt accounts
copy_secret cert-manager letsencrypt-staging-account-key
kubectl -n security get secret vault-token letsencrypt-prod-account-key letsencrypt-staging-account-key
```

(If a staging key does not exist, skip it: cert-manager registers a new staging account.)

## 2. Merge the Phase 2d PR, let Argo CD see it

```bash
kubectl -n argocd annotate application root argocd.argoproj.io/refresh=hard --overwrite
sleep 30
kubectl -n argocd get applications
```

`external-secrets`, `cert-manager`, `vault`, `security`, `falco` appear `OutOfSync`.

## 3. Sync, one app at a time

Use `sync_app` (the version with the optional prune argument). Review each App Diff first.

```bash
# Vault: adopted in place
sync_app vault
kubectl -n security get pod vault-0                     # same AGE as in step 0
kubectl -n security exec vault-0 -- vault status | grep Sealed    # false

# External Secrets: stop the old copy, start the new one in security
kubectl -n external-secrets scale deploy --all --replicas=0
sync_app external-secrets
kubectl -n security get pods -l app.kubernetes.io/instance=external-secrets

# cert-manager: same
kubectl -n cert-manager scale deploy --all --replicas=0
sync_app cert-manager
kubectl -n security get pods -l app.kubernetes.io/instance=cert-manager

# Issuers, secret store (now reading security/vault-token), Vault UI route
sync_app security-config
kubectl get clusterissuer                     # READY True
kubectl get clustersecretstore vault-backend  # READY True
```

## 4. Move Falco

```bash
# remove the old Falco (namespaced objects of the Helm release only)
kubectl -n security delete daemonset,deployment,service,configmap,serviceaccount,role,rolebinding \
  -l app.kubernetes.io/instance=falco
kubectl -n security delete secret -l app.kubernetes.io/instance=falco
kubectl -n security delete secret -l owner=helm,name=falco
sync_app falco
kubectl -n security-apps get pods -o wide     # one falco pod per node + falcosidekick
```

## 5. Check

```bash
kubectl -n security get pods
kubectl get externalsecret -A                 # all SecretSynced (force one: annotate force-sync=$(date +%s))
kubectl get certificate -A                    # all READY True
kubectl -n security-apps logs ds/falco --tail=20 | grep -c "Outbound connection in security namespace"   # 0
curl -sI https://vault-ui.karim-portfolio.xyz | head -1
curl -sI https://app.karim-portfolio.xyz | head -1
```

Force-refresh one ExternalSecret to prove the new operator works:

```bash
kubectl -n admin annotate externalsecret grafana-admin force-sync=$(date +%s) --overwrite
kubectl -n admin get externalsecret grafana-admin    # SecretSynced, recent refresh
```

## 6. Remove the old namespaces

```bash
kubectl -n external-secrets get all,secret,externalsecret 2>/dev/null
kubectl -n cert-manager get all,secret,certificate 2>/dev/null
```

Only the stopped deployments, their services, Helm release secrets and the copied secrets should
be left. Then:

```bash
kubectl delete namespace external-secrets cert-manager
kubectl get crd | grep -E 'external-secrets|cert-manager' | wc -l     # CRDs still there
```

## 7. Follow-up PR

Automated sync for the five apps, the Vault Helm release record removed
(`kubectl -n security delete secret -l owner=helm,name=vault`).
