#!/bin/bash
# Stops k3s but keeps all cluster data on disk (/var/lib/rancher/k3s), so
# `terraform apply` brings the cluster back as it was.
set -euo pipefail

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
BACKUP_DIR=${BACKUP_DIR:-/root/altitude0-backups/$(date +%Y%m%d-%H%M%S)}

# The Postgres pods have no persistent volume: their data is lost when the
# containers stop, so dump every database first. Any failed dump aborts the
# shutdown.
if command -v kubectl >/dev/null 2>&1 && kubectl get nodes >/dev/null 2>&1; then
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  kubectl get pods -A -l app=postgres --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.metadata.namespace} {.metadata.name}{"\n"}{end}' |
  while read -r ns pod; do
    echo "Dumping $ns/$pod to $BACKUP_DIR/$ns-$pod.sql"
    kubectl exec -n "$ns" "$pod" -- sh -c 'pg_dumpall -U "$POSTGRES_USER"' \
      < /dev/null > "$BACKUP_DIR/$ns-$pod.sql"
  done
fi

systemctl disable --now k3s
/usr/local/bin/k3s-killall.sh
echo "k3s stopped. Cluster data kept in /var/lib/rancher/k3s, Postgres dumps in $BACKUP_DIR."
