# Migration plan: industry-standard infrastructure

Goal: move from "Terraform runs bash scripts on the VPS" to a layered setup where every
change goes through Git, a pull request and CI, and nothing has to be run by hand on a server.

## Target architecture

| Layer | Tool | Runs from | Repo folder |
| --- | --- | --- | --- |
| Cloud resources: DNS records, (servers, firewall when the provider allows it) | Terraform, state in HCP Terraform | CI / laptop | `terraform/` |
| OS + k3s: Tailscale, control plane, agents | Ansible | CI / laptop, over Tailscale SSH | `ansible/` |
| Cluster contents: Helm releases, manifests, apps | Argo CD (GitOps, app-of-apps) | Inside the cluster, pulling this repo | `gitops/`, `kubernetes/` |
| Secrets | Vault + External Secrets Operator | Inside the cluster | `kubernetes/security/` |
| Workflow | PR → lint/plan in CI → review → apply on merge | GitHub Actions | `.github/workflows/` |

Nodes:

- `vps-master` (IONOS VPS): k3s server, public entry point (APISIX via ServiceLB).
- `apps-node` (old Windows laptop, WSL2): k3s agent, tainted `location=home:NoSchedule`, only runs workloads that tolerate it.
- Node-to-node traffic (API, flannel VXLAN) goes over Tailscale (`tailscale0`).

## Decisions

| Topic | Choice | Why |
| --- | --- | --- |
| GitOps | Argo CD | Most common in industry, UI shows sync and drift |
| Terraform state | HCP Terraform (free tier) | Remote state + locking, not stored on the server it manages |
| IaC tool | Terraform | What most job offers ask for |
| k3s install | Ansible roles in this repo | Readable, no extra dependency; replaces `null_resource.install_k3s` |
| Delivery | One branch + PR per phase | Reviewable, revertable |

## Phases

### Phase 1 — k3s with Ansible (this PR)

- `ansible/roles/{tailscale,k3s_server,k3s_agent}`, `ansible/playbooks/k3s.yml`.
- Inventory in `ansible/inventory/hosts.yml` (gitignored, copy `hosts.yml.example`).
- `k3s_version` pinned in `ansible/inventory/group_vars/k3s_cluster.yml`.

Cutover on the existing cluster:

1. Tailscale up on the VPS and the WSL laptop (setup guide, Step 3).
2. `ansible-playbook playbooks/k3s.yml --limit k3s_server --check --diff` and read the diff.
   Expected changes: `config.yaml` (comment lines only), new `10-tailscale.yaml`, one k3s restart.
3. Run it for real on the server, check `kubectl get nodes -o wide` (INTERNAL-IP = Tailscale IP).
4. `ansible-playbook playbooks/k3s.yml --limit k3s_agents` joins the laptop.

Terraform kept `null_resource.install_k3s` until Phase 3, which retired it without ever running
`apply` (its destroy provisioner ran `stop_k3s.sh`). Versions are managed in Ansible.

### Phase 2 — Argo CD replaces `deploy_infra.sh`

Progress:

- [x] 2a — Argo CD bootstrap (`ansible/playbooks/argocd.yml`, values in `gitops/argocd/values.yaml`),
      root app of apps (`gitops/root.yaml`), Headlamp adopted (`gitops/apps/headlamp.yaml`).
- [x] 2b — Headlamp on automated sync; Argo CD UI route + certificate; Argo CD manages itself.
- [x] 2c — Observability: Loki, Promtail, Prometheus, Grafana, Jaeger (automated sync).
- [x] 2c+ — Headlamp and the observability stack moved to the `admin` namespace
      (docs/runbooks/move-to-admin-namespace.md). Argo CD stays in `argocd`.
      Jaeger traces from before the move were lost (PVC pruned before Prune=false existed).
- [x] 2d — Security: cert-manager, External Secrets, Vault, Falco (sync waves -3/-2/-1/0).
      Namespace security = Vault, External Secrets, cert-manager, ClusterIssuers;
      Falco in security-apps (docs/runbooks/phase2d-security.md).
- [x] 2e — Gateway: APISIX, ingress controller, Gateway config (admin + viewer keys from Vault via
      ExternalSecret). Old apisix-dashboard retired: built-in UI at admin API /ui/ (port-forward).
- [x] 2f — Applications: Postgres (rendered from the Ansible template), auth, payment, front,
      pgAdmin, Ollama, GHCR pull secret as a plain ExternalSecret (docs/runbooks/phase2f-apps.md).
- [x] 2g — Deleted `scripts/deploy_infra.sh`, `ansible/deploy-apps.yml`, `null_resource.deploy_infra`,
      `null_resource.deploy_apps`. Namespaces under Argo CD (`gitops/apps/namespaces.yaml`, wave -10,
      never pruned) (docs/runbooks/phase2g-cleanup.md).


- Bootstrap Argo CD once (Ansible task or `helm install`), then a root `Application`
  (app-of-apps) pointing at `gitops/`.
- One `Application` per component: external-secrets, apisix (+ ingress controller, dashboard),
  cert-manager, vault, falco, loki, promtail, prometheus, jaeger, grafana, headlamp, ollama,
  applications (Postgres, auth, payment, front, pgadmin). Sync waves keep the current order
  (CRDs and operators first, routes last).
- The APISIX admin key logic in `deploy_infra.sh` becomes an `ExternalSecret` from Vault.
- Postgres moves from `deploy-apps.yml` to Argo CD.
- Remove `null_resource.deploy_apps`, `null_resource.deploy_infra` and `scripts/deploy_infra.sh`
  (it is also listed in `.gitignore` while tracked; fix that).
- Falco: exclude or tolerate per node; `modern_ebpf` may not run on the WSL kernel.

### Phase 3 — Terraform for DNS, state in HCP Terraform

- [x] Checked: the VPS is a classic IONOS VPS (`my.ionos.fr`), not IONOS Cloud, so the
      `ionos-cloud` provider cannot manage it; Ansible configures it. The domain is registered at
      Namecheap and its DNS is served by Cloudflare.
- [x] `terraform/`: Cloudflare provider v5, `cloud {}` block (organization `resilience-alpha`,
      workspace `infra-dns`), the 20 existing records adopted with `import` blocks (no change).
      Cloudflare token scoped to the zone, stored as a sensitive workspace variable.
- [x] Old root Terraform retired (`main.tf`, `install_k3s.sh`, `stop_k3s.sh`); its local state
      archived on the VPS, never applied again (docs/runbooks/phase3-terraform-dns.md).
- [x] `terraform/imports.tf` deleted after the import (20 records, then `No changes.`).
- [ ] Review the proxied records `@`, `api`, `portainer` (still used?), one small PR each.
- Postgres backups (were in `stop_k3s.sh`): CronJob or Velero, Phase 5.

### Phase 4 — CI/CD with GitHub Actions

- On pull requests: `yamllint`, `ansible-lint`, `terraform fmt/validate/plan`, Argo CD diff.
- On merge to `main`: `terraform apply`, `ansible-playbook playbooks/k3s.yml`.
  The runner joins the tailnet with `tailscale/github-action` (OAuth client, `tag:ci`).
- Argo CD syncs the cluster by itself.

### Phase 5 — Hardening

- Tailscale ACLs: `tag:ci` and admins can SSH to `tag:k3s` nodes, nodes talk to each other.
- kubeconfig mode `0600`, dedicated CI service account instead of the admin kubeconfig.
- Backups: k3s datastore snapshots + Velero for volumes, stored off the VPS.
- Renovate for chart, image and k3s versions.
