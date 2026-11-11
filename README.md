# Infra

k3s cluster (control plane on the VPS, worker nodes joined over Tailscale) with namespaces: `argocd` (Argo CD), `admin` (Headlamp, Grafana, Prometheus, Loki, Promtail, Jaeger), `security` (Vault, External Secrets, cert-manager), `security-apps` (Falco), `apisix` (gateway), `applications` (Postgres, EPSI Pay), `ia` (Ollama). Everything is deployed by Argo CD from `gitops/apps`.

```
main.tf, providers.tf, variables.tf   Terraform: installs k3s (scripts/install_k3s.sh), until Phase 3
ansible/playbooks/k3s.yml             k3s cluster: Tailscale, control plane, agents (roles in ansible/roles)
ansible/playbooks/argocd.yml          Argo CD + root app of apps (gitops/root.yaml)
gitops/apps/                          One Argo CD Application per component (GitOps)
docs/migration-plan.md                Plan to move to Ansible + Argo CD + Terraform (HCP) + CI
kubernetes/                           Manifests and Helm values synced by Argo CD (namespaces/, applications/, ...)
docs/runbooks/                        Step-by-step procedures (migrations, VPS reboot)
docs/wsl-node.md                      Windows laptop as a k3s agent (WSL2): setup and autostart
```

## k3s cluster (Ansible)
```bash
cd ansible
cp inventory/hosts.yml.example inventory/hosts.yml   # fill in the hosts
ansible-galaxy collection install -r requirements.yml
ansible-playbook playbooks/k3s.yml --check --diff     # dry run
ansible-playbook playbooks/k3s.yml
```
The k3s version is pinned in `ansible/inventory/group_vars/k3s_cluster.yml`. Do not change `k3s_version` in Terraform: replacing `null_resource.install_k3s` stops k3s (see docs/migration-plan.md).

## Cluster contents (Argo CD)
Everything inside the cluster is in Git: `gitops/root.yaml` (app of apps) points at `gitops/apps/`,
one Application per component, all with automated sync. A change is a pull request; Argo CD applies
it after the merge. Bootstrap on a new cluster: `ansible-playbook playbooks/argocd.yml`.

## Terraform
`terraform apply` (run on the VPS) only makes sure k3s is installed, until Phase 3 replaces it.
Do not change `k3s_version` there (see above).

Vault must be initialised once: `kubectl -n security exec vault-0 -- vault operator init` (store the keys safely, then `vault operator unseal` x3).
After every VPS reboot Vault starts sealed: see docs/runbooks/vps-reboot.md.
