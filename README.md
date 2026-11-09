# Infra

k3s cluster (control plane on the VPS, worker nodes joined over Tailscale) with namespaces: `argocd` (Argo CD), `admin` (Headlamp, Grafana, Prometheus, Loki, Promtail, Jaeger), `security` (Vault, External Secrets, cert-manager), `security-apps` (Falco), `apisix` (gateway), `applications` (Postgres, EPSI Pay), `ia` (Ollama). Everything is deployed by Argo CD from `gitops/apps`.

```
main.tf, providers.tf, variables.tf   Terraform: installs k3s (scripts/install_k3s.sh)
scripts/deploy_infra.sh               Ollama and EPSI Pay (the rest is under Argo CD, gitops/apps)
ansible/playbooks/k3s.yml             k3s cluster: Tailscale, control plane, agents (roles in ansible/roles)
ansible/playbooks/argocd.yml          Argo CD + root app of apps (gitops/root.yaml)
gitops/apps/                          One Argo CD Application per component (GitOps)
ansible/deploy-apps.yml               Namespaces (Postgres is under Argo CD)
docs/migration-plan.md                Plan to move to Ansible + Argo CD + Terraform (HCP) + CI
kubernetes/{applications,logging,security,ia,apisix}   Manifests and Helm values, one folder per namespace
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

## Usage
```bash
terraform init && terraform apply   # k3s, then Ansible (namespaces), then deploy_infra.sh (namespaces only)
```
`terraform apply` runs the three layers in order. To run one by hand:
```bash
ansible-playbook -i ansible/inventory.ini ansible/deploy-apps.yml   # namespaces
bash scripts/deploy_infra.sh                                   # Ollama, EPSI Pay
```
Vault must be initialised once: `kubectl -n security exec vault-0 -- vault operator init` (store the keys safely, then `vault operator unseal` x3).
