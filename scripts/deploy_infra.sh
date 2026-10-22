#!/bin/bash
# scripts/deploy_infra.sh
# Deploys the shared services: External Secrets, APISIX (gateway, ingress controller, dashboard),
# cert-manager, Vault (security), Loki + Promtail + Prometheus + Grafana (logging), Ollama (ia),
# the EPSI Pay services, certificates and routes.
# VAULT_TOKEN (write access to apps/apisix-admin) lets it read/store the APISIX admin key in Vault.
# First dashboard install needs APISIX_DASHBOARD_PASSWORD and APISIX_DASHBOARD_SECRET in the environment.
# Run from the repository root.

set -euo pipefail

export KUBECONFIG=${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}
echo "Using KUBECONFIG: $KUBECONFIG"

echo "Updating Helm repositories..."
helm repo add grafana https://grafana.github.io/helm-charts
helm repo add hashicorp https://helm.releases.hashicorp.com
helm repo add jetstack https://charts.jetstack.io
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add external-secrets https://charts.external-secrets.io
helm repo add apisix https://charts.apiseven.com
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

echo "Deploying External Secrets Operator..."
helm upgrade --install external-secrets external-secrets/external-secrets \
    --namespace external-secrets --create-namespace --version 2.4.1 \
    --set installCRDs=true
kubectl -n external-secrets rollout status deploy/external-secrets-webhook --timeout=180s

# APISIX admin key, source of truth = Vault (apps/apisix-admin, field `key`). Resolved in order:
# $APISIX_ADMIN_KEY, Vault (needs $VAULT_TOKEN and an unsealed vault-0), the running ingress
# controller's key (keeps an existing cluster unchanged), else a new random key.
vault_cli() {   # token goes through stdin, not the process list
    kubectl -n security exec -i vault-0 -- sh -c 'VAULT_TOKEN=$(head -n1) vault "$@"' vault "$@" <<<"$VAULT_TOKEN"
}
vault_ok() { [[ -n "${VAULT_TOKEN:-}" ]] && vault_cli status >/dev/null 2>&1; }

if [[ -z "${APISIX_ADMIN_KEY:-}" ]] && vault_ok; then
    APISIX_ADMIN_KEY="$(vault_cli kv get -mount=apps -field=key apisix-admin 2>/dev/null || true)"
fi
if [[ -z "${APISIX_ADMIN_KEY:-}" ]]; then
    APISIX_ADMIN_KEY="$(helm get values apisix-ingress-controller -n apisix -o json 2>/dev/null | jq -r '.config.apisix.adminKey // empty' || true)"
fi
APISIX_ADMIN_KEY="${APISIX_ADMIN_KEY:-$(openssl rand -hex 16)}"

# Gateway API CRDs come with k3s (traefik-crd). Never reuse old values with a 1883:9100 stream port.
echo "Deploying APISIX (gateway + etcd)..."
helm upgrade --install apisix apisix/apisix \
    --namespace apisix --create-namespace --version 2.15.0 --reset-values \
    -f kubernetes/apisix/apisix-values.yaml \
    --set "apisix.admin.credentials.admin=$APISIX_ADMIN_KEY"
kubectl -n apisix rollout status deploy/apisix --timeout=300s

echo "Deploying APISIX ingress controller..."
helm upgrade --install apisix-ingress-controller apisix/apisix-ingress-controller \
    --namespace apisix --version 1.2.1 --reset-values \
    -f kubernetes/apisix/apisix-ingress-controller-values.yaml \
    --set "config.apisix.adminKey=$APISIX_ADMIN_KEY" \
    --set "gatewayProxy.provider.controlPlane.auth.adminKey.value=$APISIX_ADMIN_KEY"

if vault_ok; then
    if [[ "$(vault_cli kv get -mount=apps -field=key apisix-admin 2>/dev/null || true)" != "$APISIX_ADMIN_KEY" ]]; then
        echo "Storing the APISIX admin key in Vault (apps/apisix-admin)..."
        vault_cli kv put -mount=apps apisix-admin key="$APISIX_ADMIN_KEY" >/dev/null
    fi
else
    echo "WARNING: Vault unavailable (set VAULT_TOKEN, unseal vault-0): the APISIX admin key was NOT stored in Vault."
    echo "         Re-run this script once Vault is ready and it will be stored."
fi

# The dashboard login and session secret live only in the Helm release (rotate with
# `helm upgrade --reuse-values --set ...`), so an existing release is left alone.
if helm status apisix-dashboard -n apisix >/dev/null 2>&1; then
    echo "APISIX dashboard already installed, leaving its credentials untouched."
else
    : "${APISIX_DASHBOARD_PASSWORD:?Set APISIX_DASHBOARD_PASSWORD for the first dashboard install}"
    : "${APISIX_DASHBOARD_SECRET:?Set APISIX_DASHBOARD_SECRET (session key) for the first dashboard install}"
    echo "Deploying APISIX dashboard..."
    helm install apisix-dashboard apisix/apisix-dashboard \
        --namespace apisix --version 0.8.3 \
        -f kubernetes/apisix/apisix-dashboard-values.yaml \
        --set "config.authentication.users[0].password=$APISIX_DASHBOARD_PASSWORD" \
        --set "config.authentication.secret=$APISIX_DASHBOARD_SECRET"
fi
kubectl apply -f kubernetes/apisix/gatewayclass.yaml

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
kubectl apply -f kubernetes/apisix/apisix-dashboard-httproute.yaml

echo "Certificate status (READY must turn True; DNS must point to the node):"
kubectl -n apisix get certificate

echo "Infrastructure deployment complete."
