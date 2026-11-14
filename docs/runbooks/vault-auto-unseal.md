# Runbook: Vault auto-unseal (Phase 5.5)

| Step | What | Where |
| --- | --- | --- |
| 5.5a | k3s **Secrets encryption at rest** (aescbc): every Kubernetes Secret is encrypted in the datastore | Ansible `group_vars/k3s_server.yml` (`secrets-encryption: true`) + `k3s secrets-encrypt` on the VPS |
| 5.5b | **vault-unsealer** Deployment: every 30 s, if `vault-0` is sealed, unseal it with 3 keys | `kubernetes/security/vault-unsealer.yaml` (Argo CD app `security-config`) |

The 3 unseal keys live in the Secret `security/vault-unseal-keys`, created **by hand** (not in Git,
not in Vault). Because of 5.5a it is encrypted in the datastore, and the k3s backup no longer contains
the server token or the encryption config: both go to the password manager. A copy of a backup alone
therefore does not reveal any Secret.

Accepted risk: someone with root on the VPS can read the keys (as they could read Vault's memory).
The `VaultNotReady` Discord alert stays as the safety net.

Restarting k3s does **not** restart the pods (containerd keeps them running): Vault stays unsealed
during 5.5a.

## 0. Pre-checks

VPS (root):

```bash
k3s secrets-encrypt status                 # Encryption Status: Disabled, no configuration file found
apt-get install -y sqlite3 >/dev/null
```

Dev container:

```bash
kubectl -n security get svc vault-internal -o jsonpath='{.spec.publishNotReadyAddresses}{"\n"}'   # true
kubectl -n backup get jobs | grep k3s-backup        # last night's backup Complete
```

## 5.5a — Secrets encryption

Apply the patch on a branch first: Ansible runs from your checkout.

1. VPS: `k3s secrets-encrypt enable`
2. Dev container (adds `secrets-encryption: true` to `/etc/rancher/k3s/config.yaml`, restarts k3s):

   ```bash
   cd ansible
   ansible-playbook playbooks/k3s.yml --limit k3s_server --check --diff   # only config.yaml changes
   ansible-playbook playbooks/k3s.yml --limit k3s_server
   kubectl get nodes
   ```

3. VPS:

   ```bash
   k3s secrets-encrypt status          # Disabled, Current Rotation Stage: start
   k3s secrets-encrypt rotate-keys
   systemctl restart k3s && sleep 30
   k3s secrets-encrypt status          # Enabled, reencrypt_finished, All hashes match
   ```

   (If it still shows `reencrypt_active`, wait a minute and check again.)

4. Check a Secret is really encrypted on disk (VPS):

   ```bash
   sqlite3 /var/lib/rancher/k3s/server/db/state.db \
     "select substr(value,1,18) from kine where name='/registry/secrets/security/vault-token' order by id desc limit 1;"
   # k8s:enc:aescbc:v1:
   ```

5. Copy into the password manager, item `k3s – token and encryption config` (never in a chat):
   `cat /var/lib/rancher/k3s/server/token` and `cat /var/lib/rancher/k3s/server/cred/encryption-config.json`.
   Both are needed to restore the datastore backup.

## 5.5b — Unsealer

1. Create the keys Secret (dev container). Paste 3 different unseal keys, each followed by Enter:

   ```bash
   read -rs K1; read -rs K2; read -rs K3
   kubectl -n security create secret generic vault-unseal-keys \
     --from-literal=key1="$K1" --from-literal=key2="$K2" --from-literal=key3="$K3"
   unset K1 K2 K3
   kubectl -n security get secret vault-unseal-keys -o jsonpath='{.data}' | jq -r 'keys[]'   # key1 key2 key3
   ```

2. Push the branch, merge the PR. Then:

   ```bash
   kubectl -n argocd annotate application root argocd.argoproj.io/refresh=hard --overwrite; sleep 60
   kubectl -n security get pods -l app=vault-unsealer
   kubectl -n security logs deploy/vault-unsealer      # watching http://vault-0.vault-internal...:8200 every 30s
   ```

3. Real test: restart Vault and watch it come back by itself.

   ```bash
   kubectl -n security delete pod vault-0
   kubectl -n security logs -f deploy/vault-unsealer   # "sealed: unsealing" then "unsealed" within ~30 s
   kubectl -n security get pod vault-0                 # 1/1 Running
   kubectl -n security exec vault-0 -- vault status | grep Sealed    # false
   ```

## After the first night

The k3s backup no longer contains the token. Check the new archive, then delete the older ones (they
hold the token and unencrypted Secrets):

```bash
rclone lsl rustfs:backups/k3s/
rclone cat rustfs:backups/k3s/<newest> | tar tz          # state.db only
rclone delete rustfs:backups/k3s/ --max-age 0 --include 'k3s-2026-11-1[1-3]*'   # adjust to the old dates
```

## Restoring the k3s datastore now

As in backups-restore.md, plus: put the **token** back in `/var/lib/rancher/k3s/server/token` and the
**encryption config** in `/var/lib/rancher/k3s/server/cred/encryption-config.json` (from the password
manager) before starting k3s. Without the encryption config the Secrets cannot be read.
