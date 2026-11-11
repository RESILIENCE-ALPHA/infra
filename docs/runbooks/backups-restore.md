# Runbook: backups (RustFS + Postgres) and restore test

| Piece | Where | Notes |
| --- | --- | --- |
| Backup storage | RustFS 1.0 in namespace `backup`, pinned to **apps-node** (the laptop) | Argo CD app `rustfs`; data on the laptop's WSL disk (`local-path`), never pruned |
| Postgres backup | CronJob `applications/postgres-backup`, every night 02:30 Paris | `pg_dumpall` → gzip → `s3://backups/postgres/pg-<date>.sql.gz` on RustFS, kept **90 days** |
| Keys | Vault `apps/backup`: `rustfs_access_key`, `rustfs_secret_key` | |

**Not encrypted** (decision of 2026-11-11): the dumps, which contain the payment data, are stored in
clear on the laptop's disk, and that disk is not encrypted (Windows 10 Home, no device encryption).
Anyone with the laptop can read them. To turn encryption on later, see the last section.

A backup only counts once a restore has been tested (step 6).

Run everything from the dev container unless stated otherwise.

## 0. Tools (dev container)

```bash
sudo apt-get update && sudo apt-get install -y rclone
```

## 1–2. Keys in Vault

```bash
kubectl -n security exec -it vault-0 -- sh -c '
  vault login &&
  vault kv put -mount=apps backup \
    rustfs_access_key=backup-$(head -c6 /dev/urandom | od -An -tx1 | tr -d " \n") \
    rustfs_secret_key=$(head -c24 /dev/urandom | od -An -tx1 | tr -d " \n")'
```

## 3. Merge the PR, check the deployment

```bash
kubectl -n argocd annotate application root argocd.argoproj.io/refresh=hard --overwrite
sleep 60
kubectl -n argocd get applications namespaces rustfs postgres
kubectl -n backup get pods,pvc -o wide           # rustfs Running on apps-node, rustfs-data Bound
kubectl get externalsecret -n backup; kubectl get externalsecret -n applications backup-target
kubectl -n applications get cronjob postgres-backup
```

If `rustfs-data` stays `Pending`, paste `kubectl -n backup describe pvc rustfs-data`.

## 4. First backup, by hand

```bash
kubectl -n applications create job --from=cronjob/postgres-backup pg-backup-first
kubectl -n applications logs -f job/pg-backup-first
```

Expected end: `uploaded pg-<date>.sql.gz (<bytes> bytes)` and `kept: N backups`.

## 5. Look at the bucket

```bash
kubectl -n backup port-forward svc/rustfs 9000:9000 9001:9001 >/dev/null 2>&1 &
export RCLONE_CONFIG=/dev/null RCLONE_CONFIG_RUSTFS_TYPE=s3 RCLONE_CONFIG_RUSTFS_PROVIDER=Other \
       RCLONE_CONFIG_RUSTFS_ENDPOINT=http://127.0.0.1:9000 RCLONE_CONFIG_RUSTFS_FORCE_PATH_STYLE=true
export RCLONE_CONFIG_RUSTFS_ACCESS_KEY_ID=$(kubectl -n backup get secret rustfs-credentials -o jsonpath='{.data.RUSTFS_ACCESS_KEY}' | base64 -d)
export RCLONE_CONFIG_RUSTFS_SECRET_ACCESS_KEY=$(kubectl -n backup get secret rustfs-credentials -o jsonpath='{.data.RUSTFS_SECRET_KEY}' | base64 -d)
rclone lsl rustfs:backups/postgres/
```

The web console is at http://localhost:9001/rustfs/console/ (same keys).

## 6. Restore test (into a scratch Postgres, production untouched)

```bash
mkdir -p /tmp/restore && chmod 700 /tmp/restore && cd /tmp/restore
latest=$(rclone lsf rustfs:backups/postgres/ | sort | tail -1); echo "$latest"
rclone copy "rustfs:backups/postgres/$latest" .

# Scratch server
kubectl -n applications run pg-restore-test --image=postgres:16-alpine --restart=Never \
  --env POSTGRES_PASSWORD=restore-test --labels app=pg-restore-test
kubectl -n applications wait --for=condition=Ready pod/pg-restore-test --timeout=120s

time (gunzip -c "$latest" \
  | kubectl -n applications exec -i pg-restore-test -- psql -U postgres -q -f - >/tmp/restore/psql.log 2>&1)
grep -c ERROR /tmp/restore/psql.log      # a few "role postgres already exists / cannot drop current user" are normal
```

Compare row counts, production vs restored:

```bash
q="SELECT table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1"
kubectl -n applications exec deploy/postgres -- psql -U postgres -d epsi_pay -At -c "$q" > prod.txt
kubectl -n applications exec pg-restore-test -- psql -U postgres -d epsi_pay -At -c "$q" > restored.txt
diff prod.txt restored.txt && echo "restore matches production"
```

Differences of a few rows are normal if payments happened since the backup. Then clean up:

```bash
kubectl -n applications delete pod pg-restore-test
cd ~; rm -rf /tmp/restore
kill %1 2>/dev/null     # stop the port-forward
```

Write the restore time down here: ______ (date: ______).

## Restoring production (disaster only)

1. Stop the writers: `kubectl -n applications scale deploy epsi-pay-auth epsi-pay-payment --replicas=0`
   (set the Argo CD app `epsi-pay` sync to manual first, or selfHeal scales them back).
2. Pipe the chosen backup (`gunzip -c`) into `deploy/postgres` as in step 6, instead of the scratch pod
   (`pg_dumpall --clean` drops and recreates the databases).
3. Scale back up, re-enable automated sync, make a test payment.

If the VPS is gone, the backups are still on the laptop:
`/var/lib/rancher/k3s/storage/pvc-*_backup_rustfs-data/` inside WSL. Rebuild the cluster
(Ansible, Argo CD bootstrap) and RustFS comes back on the same folder, or run the `rustfs/rustfs:1.0.0`
container directly on that folder to read the objects.

## Turning encryption on later

1. `age-keygen -o /tmp/k` in the dev container; store the file in the password manager **only**
   (never in a chat, a ticket or Git); `age-keygen -y /tmp/k` prints the public key `age1...`; `shred -u /tmp/k`.
2. `vault kv patch -mount=apps backup age_recipient=age1...`
3. Add `AGE_RECIPIENT` (Vault property `age_recipient`) back to the `backup-target` ExternalSecret.
   The job then writes `.sql.gz.age` and refuses anything that is not an `age1...` public key.
4. Restore: `age -d -i key.txt <file> | gunzip | psql ...`

## Next (5.1b)

k3s datastore (SQLite) and Vault data backups to the same bucket.
