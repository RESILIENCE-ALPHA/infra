# Runbook: admin tools on the tailnet only (Phase 5.6)

| Piece | Where |
| --- | --- |
| Tailscale Kubernetes operator 1.104.4 | Argo CD app `tailscale-operator` (namespace `tailscale`, on the VPS) |
| OAuth client of the operator | Vault `apps/tailscale` (`oauth_client_id`, `oauth_client_secret`) → ExternalSecret `tailscale/operator-oauth` |
| ProxyClass `vps` + 6 Ingresses of class `tailscale` | Argo CD app `tailnet-admin` (`kubernetes/tailscale/access`) |

Each Ingress becomes its own tailnet device with a TLS certificate issued through Tailscale:

| Tool | Tailnet URL | Public URL (removed in step 6) |
| --- | --- | --- |
| Argo CD | `https://argocd.<tailnet>.ts.net` | argocd.karim-portfolio.xyz |
| Grafana | `https://grafana.<tailnet>.ts.net` | grafana.karim-portfolio.xyz |
| Headlamp | `https://headlamp.<tailnet>.ts.net` | headlamp.karim-portfolio.xyz |
| Jaeger | `https://jaeger.<tailnet>.ts.net` | jaeger.karim-portfolio.xyz |
| Vault UI/API | `https://vault.<tailnet>.ts.net` | vault-ui.karim-portfolio.xyz |
| pgAdmin | `https://pgadmin.<tailnet>.ts.net` | pgadmin.karim-portfolio.xyz |

`app`, `auth`, `payment` stay public. Only devices logged in to your tailnet can open the tailnet URLs.

## 1. Tailscale admin console (login.tailscale.com/admin)

1. **Access controls** (policy file): add the tags, keep the rest of the file:

   ```json
   "tagOwners": {
     "tag:k8s-operator": [],
     "tag:k8s": ["tag:k8s-operator"]
   },
   ```

   Your own devices must be allowed to reach `tag:k8s` on port 443. The default policy (allow all
   between members) already does; if the file only has narrow rules, add
   `{"action": "accept", "src": ["autogroup:member"], "dst": ["tag:k8s:443"]}` to `acls`
   (or the equivalent `grants` entry).
2. **DNS**: **MagicDNS** enabled, **HTTPS Certificates** enabled. Note the **tailnet name**
   (`tailXXXX.ts.net`).
3. **Settings → Trust credentials (OAuth clients) → Generate**: scopes with **write**:
   `Devices → Core`, `Keys → Auth Keys`, `General → Services`; tag **`tag:k8s-operator`**.
   Copy the client ID and secret into the password manager (never in a chat).

## 2. Store the OAuth client in Vault · dev container

```bash
read -rs TS_ID; echo "id read"
read -rs TS_SECRET; echo "secret read"
printf 'id length %s, secret starts with tskey-client: %s\n' "${#TS_ID}" "$(case $TS_SECRET in tskey-client-*) echo yes;; *) echo no;; esac)"
kubectl -n security exec -it vault-0 -- sh -c "vault login && vault kv put -mount=apps tailscale oauth_client_id=$TS_ID oauth_client_secret=$TS_SECRET"
unset TS_ID TS_SECRET
```

## 3. Merge the PR

```bash
kubectl -n argocd annotate application root argocd.argoproj.io/refresh=hard --overwrite; sleep 90
kubectl -n argocd get applications namespaces tailscale-operator tailnet-admin
kubectl get externalsecret -n tailscale operator-oauth            # SecretSynced
kubectl -n tailscale get pods -o wide                               # operator + 6 proxies (ts-...), on ubuntu
kubectl get ingress -A | grep tailnet                               # ADDRESS: <host>.<tailnet>.ts.net
```

In the admin console → Machines: `k8s-operator` and six devices tagged `tag:k8s`.

## 4. Open the tools (Mac with Tailscale connected)

`https://argocd.<tailnet>.ts.net` etc. The first request to each host can take up to a minute
(certificate issuance). Then, from a phone **with Tailscale off**: the same URLs must not open.

## 5. Use it for a few days

Bookmark the tailnet URLs. Keep the public ones meanwhile, in case something is missing.

## 6. Remove the public routes (separate PR)

For argocd, grafana, headlamp, jaeger, vault-ui, pgadmin: delete their HTTPRoute, their Gateway
listener and Certificate, and their Cloudflare record in `terraform/dns.tf` (Terraform PR: the plan
must show only those 6 records destroyed). Then check from outside that the six hosts no longer
answer, and that `app`, `auth`, `payment` still do.
