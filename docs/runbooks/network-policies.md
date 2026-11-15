# Runbook: NetworkPolicies, namespace applications (Phase 5.7)

Enforced by k3s's built-in kube-router. Ingress only for now: default deny, then one policy per flow.

| To | From | Port |
| --- | --- | --- |
| front | APISIX gateway pods (`apisix` namespace) | 8080 |
| auth, payment | APISIX gateway pods; front | 3000 |
| postgres | auth, payment, pgadmin, postgres-backup, epsi-pay-database (seed); `service-ia` in `ia` | 5432 |
| pgadmin | APISIX gateway pods; Tailscale proxy (`tailscale` namespace) | 80 |

Not restricted yet: egress (DNS, Jaeger, Vault, internet), other namespaces.

## 0. Before merging · dev container

APISIX gateway pods must carry the label the policies use:

```bash
kubectl -n apisix get pods -l app.kubernetes.io/name=apisix -o name     # the gateway pod(s)
kubectl -n ia get pods -o wide                                          # service-ia (talks to postgres)
```

## 1. Merge, then check right away

```bash
kubectl -n argocd annotate application root argocd.argoproj.io/refresh=hard --overwrite; sleep 60
kubectl -n applications get networkpolicy
for h in app auth payment; do printf '%-8s ' $h; curl -s -o /dev/null -w '%{http_code}\n' https://$h.karim-portfolio.xyz; done   # 200 404 404 as before
```

Then, by hand:

- a real **payment** on https://app.karim-portfolio.xyz (front, auth, payment, postgres);
- **pgAdmin** on https://pgadmin.taild095e0.ts.net (Tailscale proxy, postgres);
- a **backup** run: `kubectl -n applications create job --from=cronjob/postgres-backup pg-backup-netpol && kubectl -n applications logs -f job/pg-backup-netpol`;
- **service-ia** logs: `kubectl -n ia logs deploy/<service-ia> --since=10m | grep -iE 'error|timeout|refused'` (nothing new).

## 2. Proof that the deny works

A pod in another namespace must not reach postgres:

```bash
kubectl -n default run netpol-test --rm -i --restart=Never --image=alpine:3.22 -- \
  sh -c 'nc -zv -w 5 postgres.applications.svc.cluster.local 5432; echo rc=$?'      # rc=1 (timed out)
```

## Rollback

Emergency (the app broke): stop Argo CD from re-creating the policies, then delete them.

```bash
kubectl -n argocd patch application epsi-pay --type=merge -p '{"spec":{"syncPolicy":{"automated":null}}}'
kubectl -n applications delete networkpolicy --all
```

Then revert the PR, and turn automated sync back on (merge restores it: the Application is in Git).
