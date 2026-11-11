# Runbook: reboot the VPS (kernel updates, "System restart required")

The VPS is the only control plane: during the reboot (2–5 minutes) the API, Argo CD and every site
on it are down. The laptop node keeps its pods but cannot be managed until the VPS is back.

Vault comes back **sealed** after every reboot: External Secrets cannot refresh and new secrets
cannot be read until it is unsealed with 3 of the unseal keys. Have them at hand before starting.

## 0. Before · dev container

```bash
kubectl get nodes
kubectl -n argocd get applications -o custom-columns=NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status | grep -v "Synced *Healthy" || echo "all Synced Healthy"
kubectl -n security exec vault-0 -- vault status | grep -E 'Sealed|Initialized'
for h in app auth payment pgadmin grafana argocd vault-ui; do
  printf '%-10s ' $h; curl -s -o /dev/null -w '%{http_code}\n' https://$h.karim-portfolio.xyz
done | tee ~/reboot-before.txt
```

Stop if something is already broken: fix it first, so you do not mix old and new problems.

## 1. Backup and reboot · VPS (root)

```bash
mkdir -p /root/backups && chmod 700 /root/backups
kubectl -n applications exec deploy/postgres -- pg_dumpall -U postgres > /root/backups/pg-$(date +%F).sql
chmod 600 /root/backups/pg-*.sql
tail -n 2 /root/backups/pg-$(date +%F).sql          # "-- PostgreSQL database cluster dump complete"
cat /var/run/reboot-required.pkgs 2>/dev/null       # what asked for the reboot
reboot
```

## 2. Wait for the cluster · dev container

k3s waits for Tailscale before starting (systemd drop-in from the Ansible role).

```bash
until kubectl get nodes >/dev/null 2>&1; do echo "API not up yet"; sleep 15; done
kubectl get nodes                                   # ubuntu and apps-node Ready (1–3 min)
kubectl -n security get pod vault-0                 # Running, READY 0/1 = sealed (normal here)
```

## 3. Unseal Vault · dev container

Run 3 times, entering a different unseal key each time (the prompt hides it, nothing is logged):

```bash
kubectl -n security exec -it vault-0 -- vault operator unseal
```

```bash
kubectl -n security exec vault-0 -- vault status | grep Sealed     # false
kubectl -n security get pod vault-0                                 # READY 1/1
```

Then make External Secrets read again right away (otherwise it retries on its own within minutes):

```bash
for es in $(kubectl get externalsecret -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{" "}{end}'); do
  kubectl -n "${es%/*}" annotate externalsecret "${es#*/}" force-sync=$(date +%s) --overwrite >/dev/null
done
sleep 20
kubectl get externalsecret -A | grep -v SecretSynced || echo "all SecretSynced"
```

## 4. Check · dev container

```bash
kubectl get pods -A | grep -vE 'Running|Completed' || echo "all pods Running/Completed"
kubectl -n argocd get applications -o custom-columns=NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status | grep -v "Synced *Healthy" || echo "all Synced Healthy"
kubectl get certificate -A | grep -v True || echo "all certificates Ready"
for h in app auth payment pgadmin grafana argocd vault-ui; do
  printf '%-10s ' $h; curl -s -o /dev/null -w '%{http_code}\n' https://$h.karim-portfolio.xyz
done | diff ~/reboot-before.txt - && echo "same as before"
```

Pods can need a few minutes after the unseal (the ones waiting on secrets). Then make one payment on
https://app.karim-portfolio.xyz.
