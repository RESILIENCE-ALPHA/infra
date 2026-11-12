# Runbook: VPS hardening — firewall and SSH (Phase 5.3)

Two layers, same public list:

| Layer | Where | Public | Managed by |
| --- | --- | --- | --- |
| IONOS firewall policy | in front of the VPS | TCP 22, 80, 443 · UDP 41641 | IONOS panel (no Terraform provider for the classic VPS) |
| ufw | on the VPS | same list; everything on `tailscale0`; k3s 10.42/16 and 10.43/16 | Ansible role `firewall` |

NodePorts and k3s ServiceLB bypass ufw (DNAT before ufw's rules), so the IONOS policy is the layer
that really filters them. Only `apisix-gateway` (80/443) is exposed today.

SSH stays public on purpose (fallback when Tailscale is down) but **keys only**: role `ssh_hardening`
sets `PasswordAuthentication no`, `PermitRootLogin prohibit-password`, `MaxAuthTries 3`, and a
fail2ban jail (tailnet never banned). Emergency access if everything fails: the IONOS panel
**Console** (password login on the console still works; it does not go through sshd).

## IONOS policy (done 2026-11-12)

Incoming rules kept: TCP 22, TCP 80, TCP 443, UDP 41641. Removed: 8443, 8447, 30001–30100, 32000,
30292–30294, 30301–30303, 30432, 30686, 1883 (old NodePorts, MQTT and "brazil" services, all gone).

## 0. Every machine must log in with a key

From the Mac **and** the dev container (each must print the hostname without asking anything):

```bash
ssh -o PasswordAuthentication=no -o BatchMode=yes root@100.107.194.25 hostname   # over Tailscale
ssh -o PasswordAuthentication=no -o BatchMode=yes root@85.215.234.70 hostname    # public fallback
```

If one fails: `ssh-copy-id root@<ip>` from that machine first (while passwords still work).

## 1. Dry run · dev container

```bash
cd ansible
ansible-galaxy collection install -r requirements.yml
ansible-playbook playbooks/hardening.yml --check --diff
```

Expected: ufw rules added/updated (22, 80, 443, 41641/udp, tailscale0, 10.42/16, 10.43/16), the six
stale rules removed, the sshd drop-in and fail2ban jail created. Nothing else.

## 2. Apply · keep a second SSH session open on the VPS meanwhile

```bash
ansible-playbook playbooks/hardening.yml
```

## 3. Check

On the VPS:

```bash
ufw status numbered
sshd -T | grep -Ei '^(passwordauthentication|permitrootlogin|maxauthtries) '   # no / prohibit-password / 3
fail2ban-client status sshd
```

From the Mac:

```bash
ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no root@85.215.234.70   # must be refused: Permission denied (publickey)
for p in 22 80 443 6443 10250 9100; do printf '%-6s ' $p; nc -z -G 3 85.215.234.70 $p 2>/dev/null && echo OPEN || echo closed; done
```

From the dev container: `kubectl get nodes` (both Ready), the sites (`curl` app/auth/payment), and a
new SSH session over Tailscale.

## Rollback

From the second session (or the IONOS Console): `rm /etc/ssh/sshd_config.d/00-hardening.conf &&
systemctl reload-or-restart ssh`; `ufw disable` turns the host firewall off.
