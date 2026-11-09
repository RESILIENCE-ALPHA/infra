#!/bin/bash
# scripts/deploy_infra.sh
# Everything is deployed by Argo CD (gitops/apps). Kept only until Phase 2g removes it and the
# Terraform null_resource that runs it.
# Run from the repository root.

set -euo pipefail

export KUBECONFIG=${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}
echo "Using KUBECONFIG: $KUBECONFIG"

echo "Creating namespaces..."
kubectl apply -f kubernetes/namespaces.yaml

echo "Certificate status (READY must turn True; DNS must point to the node):"
kubectl -n apisix get certificate

echo "Infrastructure deployment complete."
