# Runbook: move Headlamp and the observability stack to the `admin` namespace

Moves Loki, Promtail, Prometheus, Grafana, Jaeger (namespace `logging`) and Headlamp
(namespace `headlamp`) into one namespace, `admin`. Argo CD stays in `argocd`.
The four data volumes are kept: each PersistentVolume is detached from its old claim and
attached to a claim with the same name in `admin`.

| Claim | Used by | Size |
| --- | --- | --- |
| `grafana` | Grafana | 10Gi |
| `prometheus-server` | Prometheus | 10Gi |
| `storage-loki-0` | Loki (StatefulSet) | 10Gi |
| `jaeger-data` | Jaeger | 2Gi |

Downtime: Grafana, Prometheus, Loki and Jaeger are stopped from step 3 to step 6
(about 15 minutes). The public apps keep running; traces and logs sent meanwhile are lost.

Run every command from the dev container (`kubectl` pointing at the cluster).

> Lesson from the first run: `Delete=false` only protects a resource when its whole app is
> deleted. Pruning (a resource removed from Git, or moved to another namespace) needs
> `Prune=false`. Data volumes carry both, and step 2 (Retain) must run before any sync.

## 1. Pause automated sync (PR 1)

Merge the PR that removes `automated` from the six apps, then check:

```bash
kubectl -n argocd annotate application root argocd.argoproj.io/refresh=hard --overwrite
sleep 20
kubectl -n argocd get applications -o custom-columns='NAME:.metadata.name,AUTO:.spec.syncPolicy.automated.selfHeal'
```

`headlamp`, `grafana`, `loki`, `prometheus`, `promtail`, `logging` must show `<none>`.
Do not continue until they do: otherwise Argo CD scales the workloads back up in step 3.

## 2. Keep the data when the claims are deleted

```bash
CLAIMS="grafana prometheus-server storage-loki-0 jaeger-data"
for c in $CLAIMS; do
  pv=$(kubectl -n logging get pvc "$c" -o jsonpath='{.spec.volumeName}')
  size=$(kubectl get pv "$pv" -o jsonpath='{.spec.capacity.storage}')
  kubectl patch pv "$pv" -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}' >/dev/null
  echo "$c $pv $size"
done | tee ~/admin-move-pvs.txt
kubectl get pv $(awk '{print $2}' ~/admin-move-pvs.txt) \
  -o custom-columns='PV:.metadata.name,RECLAIM:.spec.persistentVolumeReclaimPolicy,CLAIM:.spec.claimRef.name'
```

All four must show `RECLAIM` = `Retain`. Keep `~/admin-move-pvs.txt`: the next steps read it.

## 3. Stop everything that writes to the volumes

```bash
kubectl -n logging scale deploy grafana prometheus-server jaeger --replicas=0
kubectl -n logging scale statefulset loki --replicas=0
kubectl -n logging wait --for=delete pod -l app.kubernetes.io/name=grafana --timeout=120s
kubectl -n logging wait --for=delete pod/loki-0 --timeout=120s
kubectl -n logging get pods      # no grafana, prometheus-server, jaeger or loki-0 pod left
```

## 4. Detach the volumes from the old claims

```bash
while read -r c pv size; do
  kubectl -n logging delete pvc "$c" --wait=true
  kubectl patch pv "$pv" --type json -p '[{"op":"remove","path":"/spec/claimRef"}]'
done < ~/admin-move-pvs.txt
kubectl get pv $(awk '{print $2}' ~/admin-move-pvs.txt)      # STATUS Available
```

## 5. Create the claims in `admin`, bound to the same volumes

```bash
kubectl create namespace admin --dry-run=client -o yaml | kubectl apply -f -
while read -r c pv size; do
kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: $c
  namespace: admin
  annotations:
    argocd.argoproj.io/sync-options: Prune=false,Delete=false
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: local-path
  volumeName: $pv
  resources:
    requests:
      storage: $size
EOF
done < ~/admin-move-pvs.txt
kubectl -n admin get pvc      # all four Bound, each to its old volume
```

## 6. Deploy into `admin` (PR 2)

Merge the PR that points everything at `admin`, then refresh `root`:

```bash
kubectl -n argocd annotate application root argocd.argoproj.io/refresh=hard --overwrite
```

In the Argo CD UI, sync each app **with "Prune" ticked**, in this order, and wait for
`Synced` / `Healthy` before the next one:

1. `logging` (Jaeger, Grafana admin ExternalSecret, routes, dashboards)
2. `loki`
3. `promtail`
4. `prometheus`
5. `grafana`
6. `headlamp`

Prune removes the old copies in `logging` and `headlamp`. The diff must show the new
objects in `admin`; it must not show any PVC being deleted (the old claims are already gone).

Then apply the files that are not under Argo CD yet:

```bash
kubectl apply -f kubernetes/namespaces.yaml \
              -f kubernetes/apisix/referencegrant.yaml \
              -f kubernetes/apisix/tracing.yaml \
              -f kubernetes/applications/auth.yaml \
              -f kubernetes/applications/payment.yaml
```

## 7. Check

```bash
kubectl -n admin get pods,pvc
kubectl -n argocd get applications
curl -I https://grafana.karim-portfolio.xyz
curl -I https://headlamp.karim-portfolio.xyz
curl -I https://jaeger.karim-portfolio.xyz        # 401: basic auth still required
```

- Grafana: log in, the dashboards are there, Explore → Prometheus shows history from
  before the move, Explore → Loki shows old logs, the Jaeger data source finds traces.
- Headlamp: log in with a new token: `kubectl -n admin create token headlamp-admin --duration=1h`
  (tokens of the old `headlamp` namespace no longer work).

## 8. Clean up (PR 3)

Once everything works: automated sync back on, the old namespaces removed from the
ReferenceGrant, `namespaces.yaml` and `deploy-apps.yml`, then:

```bash
kubectl -n logging get all,pvc,secret      # nothing left that matters
kubectl -n headlamp get all,secret
kubectl delete namespace logging headlamp
```

## Rollback

Before step 6 nothing has changed for Argo CD: recreate the claims in `logging` with the
same `volumeName` (step 5 with `namespace: logging`) and scale the workloads back up.
After step 6, revert PR 2 and repeat steps 3 to 6 in the other direction.
