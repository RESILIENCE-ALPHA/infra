#!/bin/sh
# Managed by Ansible (roles/k3s_agent). Restarts k3s-agent when the node has its pod bridge (cni0)
# but no flannel VXLAN interface (flannel.1): pods then run but cannot reach other nodes.
# Seen 2026-11-12 after a WSL boot: "external interface not found, retrying in 30s" forever.
# Waits 3 minutes after k3s-agent started, so a normal start-up is never interrupted.
set -eu

ip link show cni0 >/dev/null 2>&1 || exit 0        # no pods yet: nothing to check
ip link show flannel.1 >/dev/null 2>&1 && exit 0   # tunnel present: healthy

now_us=$(awk '{printf "%d", $1 * 1000000}' /proc/uptime)
since_us=$(systemctl show k3s-agent -p ActiveEnterTimestampMonotonic --value)
[ "${since_us:-0}" -gt 0 ] || exit 0               # k3s-agent not running: systemd handles it
[ $((now_us - since_us)) -gt 180000000 ] || exit 0  # started less than 3 minutes ago

logger -t flannel-watchdog "cni0 present but flannel.1 missing for 3+ min: restarting k3s-agent"
systemctl restart k3s-agent
