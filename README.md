# Infra

Single-node k3s cluster with namespaces: `applications` (Postgres), `logging` (Loki, Promtail, Prometheus, Grafana), `security` (Vault, ModSecurity WAF), `ia` (Ollama).

```
main.tf, providers.tf, variables.tf   Terraform: installs k3s (scripts/install_k3s.sh)
scripts/deploy_infra.sh               Helm: Vault, Loki, Promtail, Prometheus, Grafana; Ollama; HTTPRoutes
ansible/deploy-apps.yml               Namespaces + Postgres
kubernetes/{applications,logging,security,ia,apisix}   Manifests and Helm values, one folder per namespace
```

## Usage
```bash
terraform init && terraform apply                              # 1. k3s
ansible-playbook -i ansible/inventory.ini ansible/deploy-apps.yml   # 2. namespaces + Postgres
bash scripts/deploy_infra.sh                                   # 3. Vault, Loki, Grafana
```
Vault must be initialised once: `kubectl -n security exec vault-0 -- vault operator init` (store the keys safely, then `vault operator unseal` x3).
