#!/bin/bash
# scripts/deploy_infra.sh
# Deploys what is not under Argo CD yet: Ollama (ia), the EPSI Pay services and front.
# Run from the repository root.
# Being replaced by Argo CD (gitops/apps); Headlamp, observability, security and the APISIX gateway already moved there.

set -euo pipefail

export KUBECONFIG=${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}
echo "Using KUBECONFIG: $KUBECONFIG"

echo "Creating namespaces..."
kubectl apply -f kubernetes/namespaces.yaml

echo "Deploying Ollama..."
kubectl apply -f kubernetes/ia/ollama.yaml


# GHCR pull secret (template rendered for the applications namespace; needs Vault unsealed)
sed -e 's/{{ namespace }}/applications/g' \
    -e "s/{{ '{{' }}/{{/g" -e "s/{{ '}}' }}/}}/g" \
    kubernetes/security/ghcr-auth.yaml | kubectl apply -f -
kubectl apply -f kubernetes/applications/postgres-externalsecrets.yaml
kubectl apply -f kubernetes/applications/database-seed.yaml   # one-shot Job seeding the shared Postgres
kubectl apply -f kubernetes/applications/auth.yaml
kubectl apply -f kubernetes/applications/payment.yaml
kubectl apply -f kubernetes/applications/swagger-basic-auth.yaml   # needs Vault apps/swagger-basic-auth
kubectl apply -f kubernetes/applications/front.yaml   # SPA + /api/* routes to auth / payment
kubectl apply -f kubernetes/applications/pgadmin.yaml      # needs Secret pgadmin-credentials (Vault apps/pgadmin)

echo "Certificate status (READY must turn True; DNS must point to the node):"
kubectl -n apisix get certificate

echo "Infrastructure deployment complete."
