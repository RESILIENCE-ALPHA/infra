# Runbook: Phase 2g — remove the old deployment scripts

Everything inside the cluster is now deployed by Argo CD. This phase removes what deployed it before:

| Removed | Replaced by |
| --- | --- |
| `scripts/deploy_infra.sh` (last job: `kubectl apply` of the namespaces) | Argo CD app `namespaces` (wave -10) |
| `ansible/deploy-apps.yml`, `ansible/inventory.ini.example` (namespaces) | Same app |
| Terraform `null_resource.deploy_infra`, `null_resource.deploy_apps` | Nothing: Terraform only keeps `install_k3s` until Phase 3 |

The namespaces already exist. The `namespaces` app adopts them in place: its first sync only adds
annotations. Each Namespace carries `Prune=false,Delete=false`, so Argo CD never deletes one (that
would delete everything inside it). The app has automated sync from the start.

Nothing restarts. The Terraform part only edits the state file; nothing is applied.

## 0. Pre-checks · dev container

```bash
kubectl -n argocd get applications -o custom-columns=NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status
kubectl get nodes
kubectl get ns applications ia admin security security-apps apisix
```

All apps `Synced Healthy`, both nodes `Ready` (root waits on every app's health), the 6 namespaces `Active`.

## 1. Merge the PR · GitHub, then dev container

```bash
kubectl -n argocd annotate application root argocd.argoproj.io/refresh=hard --overwrite
sleep 60
kubectl -n argocd get applications root namespaces
kubectl get ns -o custom-columns=NAME:.metadata.name,STATUS:.status.phase,OPTS:.metadata.annotations.argocd\.argoproj\.io/sync-options
```

`root` and `namespaces` `Synced Healthy`; the 6 namespaces show `Prune=false,Delete=false`.

## 2. Remove the two resources from the Terraform state · VPS (root)

Terraform runs on the VPS, with its state in a local `terraform.tfstate` (not in Git). Find the folder:

```bash
find / -name terraform.tfstate -not -path '/proc/*' 2>/dev/null
cd <that folder>
```

Back up the state, update the code, then forget the two resources (no apply, nothing runs):

```bash
cp terraform.tfstate /root/backups/terraform.tfstate.$(date +%F)
chmod 600 /root/backups/terraform.tfstate.*
git status --short                 # note local changes, if any
git pull
terraform state list               # null_resource.deploy_apps, deploy_infra, install_k3s
terraform state rm null_resource.deploy_apps null_resource.deploy_infra
terraform state list               # null_resource.install_k3s only
terraform plan                     # must say: No changes.
```

Stop if `terraform plan` shows anything for `null_resource.install_k3s` (`must be replaced` would run
`stop_k3s.sh` on apply). Do not run `terraform apply` in this phase.

If `git pull` refuses because of local changes, paste them to Claude first.

## 3. Check · dev container

```bash
kubectl -n argocd get applications -o custom-columns=NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status | grep -v "Synced *Healthy" || echo "all Synced Healthy"
for h in app auth payment pgadmin grafana argocd vault-ui; do
  printf '%-10s ' $h; curl -s -o /dev/null -w '%{http_code}\n' https://$h.karim-portfolio.xyz
done
```

## Rollback

Revert the PR. The namespaces stay (never deleted). The Terraform state backup is in `/root/backups`.
