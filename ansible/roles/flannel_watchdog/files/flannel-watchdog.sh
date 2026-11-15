#!/bin/sh
# Managed by Ansible (roles/flannel_watchdog). Usage: flannel-watchdog <k3s service>
# Restarts the k3s service (k3s on the server, k3s-agent on agents) when the node has its pod
# bridge (cni0) but no flannel VXLAN interface (flannel.1): pods then run but cannot reach other
# nodes. Seen on apps-node after a WSL boot (2026-11-12) and on the VPS (2026-11-14, flannel.1
# vanished while k3s kept running). Waits 3 minutes after the service started, so a normal
# start-up is never interrupted. Restarting k3s does not restart the pods.
set -eu
service=${1:-k3s-agent}

ip link show cni0 >/dev/null 2>&1 || exit 0        # no pods yet: nothing to check
ip link show flannel.1 >/dev/null 2>&1 && exit 0   # tunnel present: healthy

now_us=$(awk '{printf "%d", $1 * 1000000}' /proc/uptime)
since_us=$(systemctl show "$service" -p ActiveEnterTimestampMonotonic --value)
[ "${since_us:-0}" -gt 0 ] || exit 0               # service not running: systemd handles it
[ $((now_us - since_us)) -gt 180000000 ] || exit 0  # started less than 3 minutes ago

logger -t flannel-watchdog "cni0 present but flannel.1 missing for 3+ min: restarting $service"
systemctl restart "$service"
