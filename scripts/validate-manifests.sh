#!/usr/bin/env bash
# Builds every Argo CD source folder and validates the result against the Kubernetes API schemas
# (kubeconform). CRDs (Gateway API, cert-manager, External Secrets, Argo CD...) are checked against
# the datreeio CRDs catalog; kinds with no published schema are skipped, not failed.
# Needs kustomize and kubeconform in PATH. Used by .github/workflows/lint.yml; runs the same locally.
set -euo pipefail

K8S_VERSION=${K8S_VERSION:-1.35.0}
CRDS_CATALOG='https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'

validate() {
  kubeconform -strict -summary -ignore-missing-schemas -kubernetes-version "$K8S_VERSION" \
    -schema-location default -schema-location "$CRDS_CATALOG" "$@"
}

status=0

# Kustomize folders (one per Argo CD app).
while read -r dir; do
  echo "== kustomize build $dir"
  if ! kustomize build "$dir" | validate -; then status=1; fi
done < <(find kubernetes -name kustomization.yaml -printf '%h\n' | sort)

# Plain manifest folders and the Argo CD Applications. Helm values files are not manifests.
echo "== plain manifests"
if ! find gitops kubernetes/argocd kubernetes/ia kubernetes/headlamp kubernetes/apisix/admin-credentials \
      -name '*.yaml' ! -name '*values*' ! -path 'gitops/argocd/*' -print0 \
    | xargs -0 kubeconform -strict -summary -ignore-missing-schemas -kubernetes-version "$K8S_VERSION" \
        -schema-location default -schema-location "$CRDS_CATALOG"; then
  status=1
fi

exit $status
