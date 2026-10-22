#!/bin/bash
# scripts/deploy_infra.sh
# Deploys the shared services: Vault (security), Loki + Promtail + Prometheus + Grafana (logging), Ollama (ia).
# Run from the repository root.

set -euo pipefail

export KUBECONFIG=${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}
echo "Using KUBECONFIG: $KUBECONFIG"

echo "Updating Helm repositories..."
helm repo add grafana https://grafana.github.io/helm-charts
helm repo add hashicorp https://helm.releases.hashicorp.com
helm repo add jetstack https://charts.jetstack.io
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

echo "Creating namespaces (applications, logging, security, ia)..."
kubectl apply -f kubernetes/namespaces.yaml

# Persistent file-backed storage: dev mode wipes secrets on every restart.
# Vault comes up sealed/uninitialised: `vault operator init` once, then unseal x3.
echo "Deploying Vault..."
helm upgrade --install vault hashicorp/vault \
    --namespace security \
    --set server.dev.enabled=false \
    --set server.dataStorage.enabled=true \
    --set server.dataStorage.size=1Gi \
    --set server.dataStorage.storageClass=local-path

echo "Deploying cert-manager..."
helm upgrade --install cert-manager jetstack/cert-manager \
    --namespace cert-manager --create-namespace --version v1.18.2 \
    -f kubernetes/security/cert-manager-values.yml
kubectl -n cert-manager rollout status deploy/cert-manager-webhook --timeout=180s
kubectl apply -f kubernetes/security/clusterissuers.yaml

echo "Deploying Loki..."
helm upgrade --install loki grafana/loki \
    --namespace logging \
    -f kubernetes/logging/loki-values.yml

echo "Deploying Promtail..."
helm upgrade --install promtail grafana/promtail \
    --namespace logging \
    --set "config.clients[0].url=http://loki-gateway.logging.svc.cluster.local/loki/api/v1/push"

echo "Deploying Prometheus..."
helm upgrade --install prometheus prometheus-community/prometheus \
    --namespace logging \
    -f kubernetes/logging/prometheus-values.yml

echo "Deploying Ollama..."
kubectl apply -f kubernetes/ia/ollama.yaml

echo "Deploying Grafana..."
helm upgrade --install grafana grafana/grafana \
    --namespace logging \
    -f kubernetes/logging/grafana-values.yml

echo "Applying Vault backend and HTTPRoutes..."
kubectl apply -f kubernetes/security/vault-backend.yaml
# GHCR pull secret (template rendered for the applications namespace; needs Vault unsealed)
sed -e 's/{{ namespace }}/applications/g' \
    -e "s/{{ '{{' }}/{{/g" -e "s/{{ '}}' }}/}}/g" \
    kubernetes/security/ghcr-auth.yaml | kubectl apply -f -
kubectl apply -f kubernetes/applications/postgres-externalsecrets.yaml
kubectl apply -f kubernetes/applications/database-seed.yaml   # one-shot Job seeding the shared Postgres
kubectl apply -f kubernetes/applications/auth.yaml
kubectl apply -f kubernetes/applications/payment.yaml
kubectl apply -f kubernetes/applications/swagger-basic-auth.yaml   # needs Vault apps/swagger-basic-auth
kubectl apply -f kubernetes/applications/pgadmin.yaml      # needs Secret pgadmin-credentials (Vault apps/pgadmin)
kubectl apply -f kubernetes/apisix/certificates.yaml
kubectl apply -f kubernetes/apisix/gateway.yaml
kubectl apply -f kubernetes/logging/grafana-externalsecret.yaml
kubectl apply -f kubernetes/apisix/referencegrant.yaml
kubectl apply -f kubernetes/security/vault-httproute.yaml
kubectl apply -f kubernetes/logging/grafana-httproute.yaml

echo "Certificate status (READY must turn True; DNS must point to the node):"
kubectl -n apisix get certificate

echo "Infrastructure deployment complete."
