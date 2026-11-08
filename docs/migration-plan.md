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
- `deploy-apps.yml` now waits for the control plane only, so an offline laptop doesn't block it.

Cutover on the existing cluster:

1. Tailscale up on the VPS and the WSL laptop (setup guide, Step 3).
2. `ansible-playbook playbooks/k3s.yml --limit k3s_server --check --diff` and read the diff.
   Expected changes: `config.yaml` (comment lines only), new `10-tailscale.yaml`, one k3s restart.
3. Run it for real on the server, check `kubectl get nodes -o wide` (INTERNAL-IP = Tailscale IP).
4. `ansible-playbook playbooks/k3s.yml --limit k3s_agents` joins the laptop.

Terraform keeps `null_resource.install_k3s` until Phase 3. It is harmless (it only makes
sure k3s is running), but **do not change `k3s_version` in Terraform**: replacing that
resource runs `stop_k3s.sh`. Versions are managed in Ansible from now on.

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
- [ ] 2e — Gateway: APISIX, ingress controller, dashboard (admin key from Vault via ExternalSecret).
- [ ] 2f — Applications: Postgres, auth, payment, front, pgadmin, Ollama.
- [ ] 2g — Delete `scripts/deploy_infra.sh`, `null_resource.deploy_infra`, `null_resource.deploy_apps`.


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

### Phase 3 — Terraform for real infrastructure, state in HCP Terraform

- `terraform/` folder with a `cloud {}` block (HCP organization + workspace).
- Check the IONOS product first: the classic IONOS **VPS** is not managed by the
  `ionos-cloud` provider (that one covers IONOS Cloud / Cubes). If it stays a classic VPS,
  Terraform manages the DNS records (and later anything API-driven); if it moves to IONOS
  Cloud, Terraform also creates the server and its firewall.
- Remove `null_resource.install_k3s`, `scripts/install_k3s.sh`, `scripts/stop_k3s.sh`
  (Postgres backups move to a CronJob or Velero, managed by Argo CD).

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
