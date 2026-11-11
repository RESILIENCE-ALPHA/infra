# Runbook: Phase 3 — Cloudflare DNS in Terraform, state in HCP Terraform

| What | Where |
| --- | --- |
| Terraform code | `terraform/` (Cloudflare provider v5) |
| State, locking, runs | HCP Terraform: organization `resilience-alpha`, workspace `infra-dns` (CLI-driven, remote execution) |
| Cloudflare API token | Workspace variable `CLOUDFLARE_API_TOKEN` (environment, **sensitive**). Never in Git. |

The 20 existing records are **adopted**, not recreated: `terraform/imports.tf` maps each one to its
Cloudflare record ID. The first plan must be `20 to import, 0 to add, 0 to change, 0 to destroy`.
Nothing changes in DNS during this phase.

The old root Terraform (`main.tf` with `null_resource.install_k3s`, `scripts/install_k3s.sh`,
`scripts/stop_k3s.sh`) is deleted. It is never applied again: its local state on the VPS is
archived (step 6), so `stop_k3s.sh` can never run.

Run steps 1–5 on the Mac, in the repository.

## 1. Log in to HCP Terraform (once)

```bash
terraform login        # opens the browser, creates a user token, stores it in ~/.terraform.d/
```

## 2. Create the workspace

```bash
git checkout feat/terraform-dns
cd terraform
terraform init         # creates workspace infra-dns in resilience-alpha, downloads the provider
```

## 3. Add the Cloudflare token to the workspace

app.terraform.io → `resilience-alpha` → Workspaces → `infra-dns` → **Variables** → **Add variable**:

- Category: **Environment variable**
- Key: `CLOUDFLARE_API_TOKEN`
- Value: the token (zone `karim-portfolio.xyz`, DNS Edit + DNS Read + Zone Read)
- **Sensitive**: ticked

## 4. Plan

```bash
terraform fmt -check -recursive
terraform validate
terraform plan
```

Expected last line: `Plan: 20 to import, 0 to add, 0 to change, 0 to destroy.`

Stop if the plan wants to change, add or destroy anything: paste the plan to Claude. A change on a
record means the code does not match Cloudflare yet (the code is fixed, not the record).

## 5. Commit the provider lock file, merge

```bash
cd ..
git add terraform/.terraform.lock.hcl
git commit -m "terraform: provider lock file"
git push
```

Open the PR, merge it. Then apply from `main`:

```bash
git checkout main && git pull
cd terraform
terraform plan          # same as step 4
terraform apply         # review, then type: yes
terraform plan          # No changes.
```

## 6. Retire the old root Terraform · VPS (root)

```bash
cd ~/workshop-m2/infra
git pull                                  # removes main.tf, providers.tf, variables.tf, the k3s scripts
ls *.tf 2>/dev/null || echo "no root .tf files left"
tar czf /root/backups/old-root-terraform-$(date +%F).tgz terraform.tfstate* .terraform .terraform.lock.hcl 2>/dev/null
chmod 600 /root/backups/old-root-terraform-*.tgz
rm -rf terraform.tfstate terraform.tfstate.backup .terraform .terraform.lock.hcl
git status --short                        # nothing
```

From now on nobody runs Terraform on the VPS.

## 7. Follow-up PR

- Delete `terraform/imports.tf` (import blocks are one-shot), plan: `No changes.`
- Review the proxied records `@`, `api`, `portainer` (still used?), one small PR each.

## Rollback

Before step 5's apply nothing changed. After it, only the HCP state exists: `terraform state rm`
on a record stops managing it without touching Cloudflare.
