# Runbook: Phase 2f — Ollama, Postgres and EPSI Pay under Argo CD

| Argo CD app | Namespace | Contents | Wave |
| --- | --- | --- | --- |
| `ollama` | `ia` | Ollama + 20Gi models PVC | 1 |
| `postgres` | `applications` | Postgres 16 (epsi_pay), 5Gi PVC, its two ExternalSecrets | 1 |
| `epsi-pay` | `applications` | auth, payment, front, pgAdmin (+1Gi PVC), Swagger basic auth, seed Job, GHCR pull secret | 2 |

Everything is adopted in place. Postgres was an Ansible Jinja template; it is now plain YAML
rendered for the values used at install (`databases: [epsi_pay]`, `postgres:16`, label
`environment: prod`). Step 0 checks that this matches the cluster, so Postgres is not restarted.

`service-ia`, `detector-db` and `ia/ghcr-credentials` are deployed from their own repository and
are not touched.

## 0. Pre-checks and backup

From the dev container:

```bash
# Protect the three data volumes
for c in applications/postgres-data applications/pgadmin-data ia/ollama-models; do
  pv=$(kubectl -n "${c%/*}" get pvc "${c#*/}" -o jsonpath='{.spec.volumeName}')
  kubectl patch pv "$pv" -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}' >/dev/null
  echo "$c $pv $(kubectl get pv "$pv" -o jsonpath='{.spec.persistentVolumeReclaimPolicy}')"
done

# The rendered Postgres must match what runs (otherwise Postgres restarts: tell Claude first)
kubectl -n applications get deploy postgres -o jsonpath='{.metadata.labels.environment} {.spec.template.metadata.labels.environment} {.spec.template.spec.containers[0].image}{"\n"}'
#   expected: prod prod postgres:16
kubectl -n applications get deploy postgres -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.name}{"\n"}{end}'
#   expected: POSTGRES_USER PGDATA POSTGRES_PASSWORD DB_PASSWORD_EPSI_PAY

```

**Backup — run this part on the VPS** (`ssh` as root, where `kubectl` uses the k3s kubeconfig).
Not in the dev container: its home directory is container-local and lost on rebuild, and a dump
must never land in the repository folder.

```bash
mkdir -p /root/backups && chmod 700 /root/backups
kubectl -n applications exec deploy/postgres -- pg_dumpall -U postgres > /root/backups/pg-$(date +%F).sql
chmod 600 /root/backups/pg-*.sql
ls -lh /root/backups/
head -c 300 /root/backups/pg-$(date +%F).sql; echo     # starts with "-- PostgreSQL database cluster dump"
```

Optionally keep a second copy on your Mac (outside the repository), from a Mac terminal:
`scp root@85.215.234.70:/root/backups/pg-$(date +%F).sql ~/Backups/`

**Back in the dev container** (same place as step 3, which compares against this file):

```bash

# Site baseline
for h in app auth payment pgadmin; do
  printf '%-10s ' $h; curl -s -o /dev/null -w '%{http_code}\n' https://$h.karim-portfolio.xyz
done | tee ~/apps-before.txt
```

## 1. Merge the Phase 2f PR

```bash
kubectl -n argocd annotate application root argocd.argoproj.io/refresh=hard --overwrite
sleep 30
kubectl -n argocd get applications ollama postgres epsi-pay
```

All three `OutOfSync`. Review each App Diff. Stop if anything is to be deleted, or if the
postgres Deployment or the seed Job shows a change other than annotations.

## 2. Sync, in order

```bash
sync_app ollama
kubectl -n ia get pods -l app=ollama              # same pod, not restarted

sync_app postgres
kubectl -n applications get pods -l app=postgres  # same pod, not restarted (AGE unchanged)

sync_app epsi-pay
kubectl -n applications get pods
kubectl -n applications get job epsi-pay-database-seed   # still the old Completed Job
kubectl get externalsecret -n applications               # all SecretSynced
```

If `epsi-pay` fails on the seed Job with `field is immutable`, the Job in Git differs from the one
that ran. Do not delete it: paste the message (re-creating it would re-run the seed).

## 3. Check

```bash
for h in app auth payment pgadmin; do
  printf '%-10s ' $h; curl -s -o /dev/null -w '%{http_code}\n' https://$h.karim-portfolio.xyz
done | diff ~/apps-before.txt - && echo "same as before"
```

Log in on https://app.karim-portfolio.xyz and make one payment, to check auth, payment and the
database end to end.

## 4. Follow-up

Automated sync for the three apps (follow-up PR). Then Phase 2g: delete `scripts/deploy_infra.sh`
and the Terraform `null_resource`s that run it and `deploy-apps.yml`.
