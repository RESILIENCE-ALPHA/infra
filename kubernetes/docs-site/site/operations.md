# Operations

The procedures for running the platform day to day and on a bad day. All commands run in the
💻 dev container unless marked 🖥️ (VPS, `ssh root@100.107.194.25`).

---

## Health check (2 minutes)

```bash
kubectl get nodes -o wide
kubectl -n argocd get applications -o custom-columns=NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status \
  | grep -v "Synced *Healthy" || echo "all Synced Healthy"
kubectl get pods -A | grep -vE 'Running|Completed' || echo "all pods Running"
kubectl get externalsecret -A | grep -v SecretSynced || echo "all secrets synced"
kubectl -n backup get jobs; kubectl -n applications get jobs | grep backup
for h in app auth payment; do printf '%-8s ' $h; curl -s -o /dev/null -w '%{http_code}\n' https://$h.karim-portfolio.xyz; done   # 200 404 404
```

---

## Access

### Headlamp token

Headlamp logs in with a ServiceAccount token. A 30-day token is kept in Vault at `admin/headlamp`
(outside what External Secrets can read):

```bash
vault login -no-print
vault kv get -field=token admin/headlamp                                                     # use it
kubectl -n admin create token headlamp-admin --duration=720h | vault kv put admin/headlamp token=-   # renew monthly
kubectl -n admin delete sa headlamp-admin      # if it leaked: every token dies, Argo CD recreates the account
```

A short one for yourself: `kubectl -n admin create token headlamp-admin --duration=8h`.

### Vault by hand

```bash
kubectl -n security exec vault-0 -- vault status | grep -E 'Sealed|Initialized'
kubectl -n security exec -it vault-0 -- vault operator unseal        # ×3 if the unsealer did not
kubectl -n security logs deploy/vault-unsealer --since=10m
```

Never `vault login` without `-no-print`: it would print the token.

---

## Alerts

13 rules (node, disk, Flannel tunnel, deployments, crash loops, Vault, backups, certificates, Argo CD,
targets) → Alertmanager (admin-node) → Discord.

**Test the whole chain:**

```bash
kubectl -n admin exec prometheus-alertmanager-0 -c alertmanager -- amtool alert add TestDiscord severity=warning namespace=admin \
  --annotation='summary="Test alert"' --alertmanager.url=http://localhost:9093
```

`[FIRING:1] TestDiscord` within ~30 s, `[RESOLVED]` ~5 min later.

**Blind spot:** Prometheus and Alertmanager run on admin-node. If that machine is down, no alert is
sent. An **external uptime check** (a free monitor on `https://app.karim-portfolio.xyz`) covers it.

---

## Backups and restore

| What | When (Paris) | Job | Where it goes |
| --- | --- | --- | --- |
| Postgres (`pg_dumpall`) | 02:30 | `applications/postgres-backup` | `s3://backups/postgres/` on RustFS (laptop) |
| k3s datastore | 02:45 | `backup/k3s-backup` | `s3://backups/k3s/` |
| Vault data | 03:00 | `security/vault-backup` | `s3://backups/vault/` |

90 days kept. Not encrypted: the laptop disk holds payment data in clear (accepted). A k3s archive
needs the server token and encryption config (password manager) to be restored; a Vault archive is
useless without the unseal keys.

**Back up now** (before any risky change):

```bash
J=pg-backup-$(date +%H%M)
kubectl -n applications create job --from=cronjob/postgres-backup $J
kubectl -n applications logs -f job/$J        # uploaded pg-….sql.gz
```

**Look at the bucket:**

```bash
kubectl -n backup port-forward svc/rustfs 9000:9000 >/dev/null 2>&1 &
export RCLONE_CONFIG=/dev/null RCLONE_CONFIG_RUSTFS_TYPE=s3 RCLONE_CONFIG_RUSTFS_PROVIDER=Other \
       RCLONE_CONFIG_RUSTFS_ENDPOINT=http://127.0.0.1:9000 RCLONE_CONFIG_RUSTFS_FORCE_PATH_STYLE=true
export RCLONE_CONFIG_RUSTFS_ACCESS_KEY_ID=$(kubectl -n backup get secret rustfs-credentials -o jsonpath='{.data.RUSTFS_ACCESS_KEY}' | base64 -d)
export RCLONE_CONFIG_RUSTFS_SECRET_ACCESS_KEY=$(kubectl -n backup get secret rustfs-credentials -o jsonpath='{.data.RUSTFS_SECRET_KEY}' | base64 -d)
rclone lsl rustfs:backups/postgres/ | tail -5
```

**Restore test** (scratch Postgres, production untouched, ~25 s):

```bash
mkdir -p /tmp/restore && chmod 700 /tmp/restore && cd /tmp/restore
latest=$(rclone lsf rustfs:backups/postgres/ | sort | tail -1); rclone copy "rustfs:backups/postgres/$latest" .
kubectl -n applications run pg-restore-test --image=postgres:16-alpine --restart=Never --env POSTGRES_PASSWORD=restore-test --labels app=pg-restore-test
kubectl -n applications wait --for=condition=Ready pod/pg-restore-test --timeout=120s
gunzip -c "$latest" | kubectl -n applications exec -i pg-restore-test -- psql -U postgres -q -f - > psql.log 2>&1
kubectl -n applications exec pg-restore-test -- psql -U postgres -d epsi_pay -c '\dt'
kubectl -n applications delete pod pg-restore-test; cd ~; rm -rf /tmp/restore
```

**Restore production** (disaster only):

1. Stop the writers. Disable auto-sync of `epsi-pay` first (Argo CD UI → App details → *Disable auto-sync*),
   then `kubectl -n applications scale deploy epsi-pay-auth epsi-pay-payment --replicas=0`.
2. `gunzip -c <backup> | kubectl -n applications exec -i deploy/postgres -- psql -U postgres -q -f -`
3. Re-enable auto-sync (the replicas come back), make a test payment.

**k3s datastore** (cluster lost): 🖥️ reinstall the same k3s version with Ansible, `systemctl stop k3s`,
put `state.db` (from the archive) in `/var/lib/rancher/k3s/server/db/` (remove `state.db-wal`/`-shm`)
and the saved `token` in `/var/lib/rancher/k3s/server/token`, `systemctl start k3s`.

**Vault:** `kubectl -n security scale sts vault --replicas=0`, extract the archive into the
`data-vault-0` volume folder on the VPS (emptied first, files owned by uid 100), scale back to 1; the
unsealer opens it.

If the VPS is gone, the backups are still on the laptop:
`/var/lib/rancher/k3s/storage/pvc-*_backup_rustfs-data/` inside WSL.

---

## Reboot a node

**VPS** (kernel updates; 2–5 min of downtime for everything public):

```bash
kubectl -n applications create job --from=cronjob/postgres-backup pg-backup-before-reboot   # wait for "uploaded"
ssh root@100.107.194.25 reboot
until kubectl get nodes >/dev/null 2>&1; do sleep 15; done; kubectl get nodes
kubectl -n security logs deploy/vault-unsealer --since=5m      # "unsealed" within ~30 s
```

Then the **health check** and a payment. k3s waits for Tailscale before starting; Vault is unsealed
automatically; External Secrets catches up within minutes.

**admin-node / laptop:** nothing to do before. Monitoring (admin-node) or backups (laptop) pause and
come back with the node. Ask the friend before rebooting his server.

---

## Argo CD sync stuck

Symptom: `Running | waiting for completion of hook …` for minutes, often on an **old** commit
(for example after a bad image tag).

```bash
kubectl -n argocd get app <app> -o jsonpath='op: {.status.operationState.operation.sync.revision}{"\n"}git: {.status.sync.revision}{"\n"}'
# stop the running operation (what the UI's TERMINATE does)
kubectl -n argocd patch app <app> --type merge -p '{"status":{"operationState":{"phase":"Terminating"}}}'
# repeat if it starts a retry; when the phase is Failed, sync the latest commit:
kubectl -n argocd patch app <app> --type merge -p '{"operation":{"initiatedBy":{"username":"admin"},"sync":{"revision":"HEAD"}}}'
```

In the UI, *Terminate* is in the panel that opens when you click the sync status at the top of the app.

---

## Move a tool to another node

Stateless tools (Headlamp, the docs site): add to its values or manifest, open a PR, merge.

```yaml
nodeSelector:
  node-role/admin: "true"
tolerations:
  - {key: node-role/admin, operator: Equal, value: "true", effect: NoSchedule}
```

Tools with a volume: `local-path` volumes are folders on one node's disk and never follow the pod.

- **Start fresh** (metrics, logs, traces): after the merge, a StatefulSet pod stays *Pending*; delete
  its claim and pod, the StatefulSet recreates both on the new node:
  `kubectl -n <ns> delete pvc <claim> --wait=false && kubectl -n <ns> delete pod <pod>`.
- **Keep the data** (Grafana, pgAdmin): archive inside the pod, copy, check the md5, restore:
  ```bash
  kubectl -n <ns> exec deploy/<app> -- sh -c 'tar czf /tmp/data.tgz -C <data dir> . && md5sum /tmp/data.tgz'
  kubectl -n <ns> exec deploy/<app> -- cat /tmp/data.tgz > ~/data.tgz && md5sum ~/data.tgz      # same md5
  # merge the PR (new claim + nodeSelector), then into the new pod:
  kubectl -n <ns> cp ~/data.tgz <new-pod>:/tmp/data.tgz && kubectl -n <ns> exec <new-pod> -- md5sum /tmp/data.tgz
  kubectl -n <ns> exec <new-pod> -- sh -c 'tar xzf /tmp/data.tgz -C <data dir>; rm /tmp/data.tgz'
  kubectl -n <ns> delete pod <new-pod>
  ```
  Keep the old claim a few days as a fallback (volumes are `Retain`), then delete it.

**Pending cleanup:** after checking Grafana and Prometheus on admin-node:
`kubectl -n admin delete pvc grafana prometheus-server`.

---

## Network problems

| Symptom | Check / fix |
| --- | --- |
| `FlannelTunnelMissing` alert, cross-node calls time out | 🖥️ on the node: `ip -br addr show flannel.1`; the watchdog restarts k3s within 2 min; by hand: `systemctl restart k3s` (VPS) or `k3s-agent` (agents) |
| A node *NotReady* | `tailscale status` on it; `systemctl status k3s-agent`; the laptop: is WSL running? |
| A new pod cannot reach Postgres | its label in `allow-postgres-clients`; new pods may wait a few seconds for kube-router (the migrate Job waits for it) |
| A tailnet URL does not answer | `tailscale status` on your device; `kubectl -n tailscale get pods`; `kubectl get ingress -A` |

---

## Certificates and DNS

```bash
kubectl get certificate -A          # all READY True; cert-manager renews 30 days before expiry
kubectl -n security logs deploy/cert-manager --since=1h | grep -i error
```

DNS records only change through `terraform/dns.tf` (pull request → plan → merge → apply).
