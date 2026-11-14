# Runbook: alerting to Discord (Phase 5.4)

| Piece | Where |
| --- | --- |
| Alertmanager | `prometheus` app (chart prometheus 29.38.0, subchart alertmanager), StatefulSet `admin/prometheus-alertmanager`, on the VPS |
| Rules | `kubernetes/logging/prometheus-values.yml`, `serverFiles.alerting_rules.yml` (13 rules) |
| Discord webhook | Vault `apps/alerting` (`discord_webhook`) → ExternalSecret `admin/alertmanager-discord` → file `/etc/alertmanager/discord/webhook-url` |
| Argo CD metrics | `gitops/argocd/values.yaml`: `controller.metrics` with `prometheus.io/scrape` annotations |

Rules: NodeNotReady, NodeDiskAlmostFull, FlannelTunnelMissing, KubeDeploymentUnavailable, KubePodCrashLooping,
VaultNotReady, BackupTooOld (>26 h), BackupJobFailed, CertificateExpiringSoon (<14 d),
CertificateNotReady, ArgoCDAppUnhealthy, ArgoCDAppOutOfSync (30 min), TargetDown.
Grouped by alert and namespace, repeated every 12 h while firing, "resolved" message when it clears.

## 1. Discord webhook

Discord → your server → the channel for alerts (e.g. `#alerts`) → ⚙️ **Edit channel** →
**Integrations** → **Webhooks** → **New Webhook** → name it `Alertmanager` → **Copy Webhook URL**.

The URL is a secret (anyone with it can post in the channel): password manager and Vault only,
never in a chat, a ticket or Git.

## 2. Store it in Vault · dev container

```bash
read -rs HOOK                                   # paste the URL, Enter (nothing is shown)
case "$HOOK" in https://discord.com/api/webhooks/*) echo "format OK" ;; *) echo "STOP: not a Discord webhook URL" ;; esac
kubectl -n security exec -it vault-0 -- sh -c "vault login && vault kv put -mount=apps alerting discord_webhook=$HOOK"
unset HOOK
```

## 3. Merge the PR, check the deployment

```bash
kubectl -n argocd annotate application root argocd.argoproj.io/refresh=hard --overwrite; sleep 60
kubectl -n argocd get applications logging prometheus argocd
kubectl get externalsecret -n admin alertmanager-discord          # SecretSynced
kubectl -n admin get pods -l app.kubernetes.io/name=alertmanager  # Running
kubectl -n argocd get svc argocd-application-controller-metrics
```

## 4. Check Prometheus sees the metrics the rules need

```bash
kubectl -n admin port-forward svc/prometheus-server 9090:80 >/dev/null 2>&1 &
q() { curl -s "http://localhost:9090/api/v1/query" --data-urlencode "query=$1" | jq -r '.data.result | length'; }
echo "argocd apps:   $(q 'argocd_app_info')"                                          # ~23
echo "certificates:  $(q 'certmanager_certificate_expiration_timestamp_seconds')"     # > 0
echo "backup crons:  $(q 'kube_cronjob_status_last_successful_time{cronjob=~".*-backup"}')"   # 3
echo "rules loaded:  $(curl -s localhost:9090/api/v1/rules | jq '[.data.groups[].rules[]] | length')"   # 13
curl -s localhost:9090/api/v1/alerts | jq -r '.data.alerts[] | "\(.state)  \(.labels.alertname)  \(.labels.namespace // "")"'
```

A `0` for certificates means cert-manager's metrics are not scraped yet. Alerts already firing are
real findings: fix or tune them in a PR.

## 5. Test message

```bash
kubectl -n admin exec statefulset/prometheus-alertmanager -c alertmanager -- \
  amtool alert add TestAlert severity=warning --annotation='summary="Test from Alertmanager"' \
  --alertmanager.url=http://localhost:9093
```

Within ~30 s a message appears in the Discord channel; about 5 minutes later a "RESOLVED" one.

## Silencing alerts (planned work, e.g. the VPS reboot)

```bash
kubectl -n admin exec statefulset/prometheus-alertmanager -c alertmanager -- \
  amtool silence add alertname=~".+" --duration=1h --comment="VPS reboot" --alertmanager.url=http://localhost:9093
```
