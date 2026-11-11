# Infra

k3s cluster (control plane on the VPS, worker nodes joined over Tailscale) with namespaces: `argocd` (Argo CD), `admin` (Headlamp, Grafana, Prometheus, Loki, Promtail, Jaeger), `security` (Vault, External Secrets, cert-manager), `security-apps` (Falco), `apisix` (gateway), `applications` (Postgres, EPSI Pay), `ia` (Ollama). Everything is deployed by Argo CD from `gitops/apps`.

```
terraform/                            Terraform: Cloudflare DNS of karim-portfolio.xyz, state in HCP Terraform
ansible/playbooks/k3s.yml             k3s cluster: Tailscale, control plane, agents (roles in ansible/roles)
ansible/playbooks/argocd.yml          Argo CD + root app of apps (gitops/root.yaml)
gitops/apps/                          One Argo CD Application per component (GitOps)
docs/migration-plan.md                Plan to move to Ansible + Argo CD + Terraform (HCP) + CI
kubernetes/                           Manifests and Helm values synced by Argo CD (namespaces/, applications/, ...)
.github/workflows/                    CI: lint (YAML, Ansible, Kubernetes manifests), Terraform plan/apply
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
The k3s version is pinned in `ansible/inventory/group_vars/k3s_cluster.yml`.

## Cluster contents (Argo CD)
Everything inside the cluster is in Git: `gitops/root.yaml` (app of apps) points at `gitops/apps/`,
one Application per component, all with automated sync. A change is a pull request; Argo CD applies
it after the merge. Bootstrap on a new cluster: `ansible-playbook playbooks/argocd.yml`.

## CI (GitHub Actions)
Every pull request runs `lint` (yamllint, actionlint, ansible-lint, kustomize + kubeconform) and, when
`terraform/` changes, `terraform` (plan posted as a PR comment). Merging to `main` applies Terraform.
Run the same checks locally: `yamllint --strict .`, `cd ansible && ansible-lint`,
`scripts/validate-manifests.sh`.

## Terraform (DNS)
`terraform/` manages the DNS records in Cloudflare. State and runs are in HCP Terraform
(organization `resilience-alpha`, workspace `infra-dns`); the Cloudflare token is a sensitive
workspace variable. The VPS (classic IONOS VPS) has no Terraform provider: Ansible configures it.
```bash
terraform login          # once
cd terraform && terraform init && terraform plan
```
Runbook: docs/runbooks/phase3-terraform-dns.md.

Vault must be initialised once: `kubectl -n security exec vault-0 -- vault operator init` (store the keys safely, then `vault operator unseal` x3).
After every VPS reboot Vault starts sealed: see docs/runbooks/vps-reboot.md.
