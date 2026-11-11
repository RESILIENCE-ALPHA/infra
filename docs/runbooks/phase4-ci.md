# Runbook: Phase 4 — CI with GitHub Actions

| Workflow | When | What | Secrets |
| --- | --- | --- | --- |
| `lint` | every PR, every push to main | yamllint, actionlint, ansible-lint, kustomize build + kubeconform of every Argo CD source folder | none |
| `terraform` | PRs and pushes touching `terraform/` | PR: fmt, validate, plan (comment on the PR). main: apply | `TF_API_TOKEN` |

Terraform runs execute in HCP Terraform (workspace `infra-dns`), which keeps the state and the
Cloudflare token. GitHub only gets an HCP token. Argo CD still syncs the cluster by itself: CI never
touches the cluster in this phase.

## 1. HCP Terraform token for GitHub · app.terraform.io

Organization `resilience-alpha` → **Settings** → **Teams** → `owners` → **Team API Token** →
**Create a team token** (expiry: 1 year, write the date down). Copy it, do not paste it anywhere else.

(If team tokens are not offered on the plan: your user token from User settings → Tokens, with an
expiry, works the same.)

## 2. Store it in GitHub · github.com/RESILIENCE-ALPHA/infra

**Settings** → **Secrets and variables** → **Actions** → **New repository secret**:
`TF_API_TOKEN` = the token.

## 3. Open the CI pull request

Merge the Phase 4 PR. Its own checks run on it (`yamllint`, `ansible-lint`, `kubernetes`); the
`terraform` workflow does not run on it (it does not touch `terraform/`). Every check must be green.

## 4. Require the checks on main · github.com/RESILIENCE-ALPHA/infra

**Settings** → **Rules** → **Rulesets** → **New branch ruleset**:

- Name `main`, Enforcement **Active**, Target branches: **Include default branch**
- ✅ Restrict deletions, ✅ Block force pushes
- ✅ Require a pull request before merging (required approvals: 0, you work alone)
- ✅ Require status checks to pass → add `yamllint`, `ansible-lint`, `kubernetes`
  (the names appear after their first run). Do not add `plan`: it only runs on Terraform PRs.

## 5. Test the Terraform path

A PR that changes nothing real, for example a comment in `terraform/dns.tf`:

- The PR gets a comment `Terraform plan (infra-dns): success` → **No changes.**
- After the merge, the `terraform` workflow on main runs `apply` → `No changes`, nothing applied.

## Running the checks locally (dev container)

```bash
yamllint --strict .
(cd ansible && ansible-lint)
scripts/validate-manifests.sh          # needs kustomize and kubeconform
(cd terraform && terraform fmt -check -recursive && terraform validate)
```
