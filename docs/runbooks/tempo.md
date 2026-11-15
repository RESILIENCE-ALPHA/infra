# Tempo replaces Jaeger (traces)

Jaeger is replaced by **Grafana Tempo** (chart `grafana-community/tempo` 3.2.1, Tempo 3.1.1, single
binary). Tempo receives the same data, so the applications only change an endpoint:

| Sender | Protocol | Before | After |
| --- | --- | --- | --- |
| epsi-pay-auth, epsi-pay-payment | OTLP HTTP | `jaeger.admin:4318` | `tempo.admin:4318` |
| APISIX `zipkin` plugin | Zipkin v2 | `jaeger.admin:9411` | `tempo.admin:9411` |

What changes for you:

- **No Jaeger UI any more.** Traces are read in **Grafana → Explore → Tempo** (search, trace view,
  node graph, "logs for this span" in Loki).
- **Service graph**: Tempo's metrics generator writes span metrics and the service graph to
  Prometheus (remote write, now enabled on Prometheus). Grafana → Explore → Tempo → *Service Graph*.
- Traces are kept **7 days** on PVC `storage-tempo-0` (5Gi, local-path, VPS).
- The `jaeger` tailnet URL disappears. Old Jaeger traces (72 h) are not migrated.

## 0. Before

💻 Dev container: note a recent trace exists in Jaeger if you want a comparison, nothing else to save.

## 1. Merge the PR

Argo CD then, in any order:

- creates the `tempo` app (StatefulSet `tempo`, Service `tempo`, PVC `storage-tempo-0`);
- restarts epsi-pay-auth and epsi-pay-payment (new endpoint), reloads the APISIX global rule;
- restarts Prometheus (new flag `--web.enable-remote-write-receiver`) and Grafana (new data sources);
- deletes the Jaeger Deployment, Service, ConfigMap and the `tailnet-jaeger` Ingress.

## 2. Checks (💻 dev container)

```bash
kubectl -n argocd get app tempo logging epsi-pay prometheus grafana tailnet-admin apisix-config
kubectl -n admin get pods -l app.kubernetes.io/name=tempo          # tempo-0 Running 1/1
kubectl -n admin logs tempo-0 --since=5m | grep -iE 'level=(error|warn)' | head
kubectl -n admin get pvc storage-tempo-0                              # Bound
```

Make a payment on https://app.karim-portfolio.xyz, then:

```bash
# Tempo has received spans (counter > 0 and growing)
kubectl -n admin exec tempo-0 -- wget -qO- http://localhost:3200/metrics | grep -E '^tempo_distributor_spans_received_total'
# Prometheus receives the span metrics from the metrics generator
kubectl -n admin exec deploy/prometheus-server -c prometheus-server -- \
  wget -qO- 'http://localhost:9090/api/v1/query?query=count(traces_service_graph_request_total)'
```

In Grafana (https://grafana.taild095e0.ts.net) → Explore → **Tempo**:

1. *Search*: service `epsi-pay-payment` → a trace with spans from `apisix` and `epsi-pay-payment`.
2. *Service Graph*: `apisix` → `epsi-pay-auth` / `epsi-pay-payment` (needs a few minutes of traffic).

## 3. Clean up after a few days

```bash
kubectl -n admin delete pvc jaeger-data     # Jaeger's data volume (kept by Prune=false,Delete=false)
```

## Rollback

Revert the PR. Argo CD recreates Jaeger from Git; its volume `jaeger-data` still holds the old traces
as long as step 3 was not done.
