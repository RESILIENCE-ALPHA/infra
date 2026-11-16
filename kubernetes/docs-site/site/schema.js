/* Interactive, animated diagram of the Workshop M2 cluster (3 nodes).
 * Pure SVG + vanilla JS, no build step.
 *  - VIEWS recolour the same picture: placement, teams, networks, exposure & security, storage.
 *  - SCENARIOS animate real traffic hop by hop; the nodes and pods involved light up.
 *  - Click any box for details. Exposes window.Schema.init() and window.Schema.rerender().
 */
(function () {
  'use strict';

  const SVGNS = 'http://www.w3.org/2000/svg';
  const W = 1560, H = 1000;
  const BUS_Y = 872;                       // tailnet "bus" line
  const CHIP_W = 80, CHIP_H = 28, GAP = 8, PAD = 10, TITLE = 22;

  // ------------------------------------------------------------------ layers (network view)
  const LAYERS = {
    internet: { name: 'Internet', color: '--l-internet',
      desc: 'Public network. Cloudflare DNS (Terraform) points app, auth and payment to the VPS. The IONOS firewall and ufw only let TCP 22 (keys only), 80, 443 and UDP 41641 in. The Kubernetes API is not public.',
      meta: { 'Entry': '85.215.234.70 :80 :443', 'Open ports': 'TCP 22/80/443, UDP 41641', 'DNS': 'Cloudflare, Terraform in HCP' } },
    tailnet: { name: 'Tailnet (WireGuard)', color: '--l-tailnet',
      desc: 'Private mesh VPN between the three nodes, the admins’ devices and the admin-tool proxies. Every packet is encrypted with WireGuard; devices connect peer to peer through NAT, or through a DERP relay. k3s uses it for all node-to-node traffic.',
      meta: { 'Range': '100.64.0.0/10', 'Names': '*.taild095e0.ts.net (MagicDNS)', 'VPS': '100.107.194.25', 'admin-node': '100.71.130.76', 'Laptop': '100.105.193.72' } },
    host: { name: 'Host networks', color: '--l-host',
      desc: "Each machine's own network: the VPS's public interface; the friend's server behind its own network (reached by its owner through Teleport); the laptop's WSL2 network behind Windows NAT and the home router. k3s binds to the tailnet IPs, so the cluster does not depend on them.",
      meta: { 'VPS': 'eth0 85.215.234.70', 'admin-node': 'KVM VM, Debian 13', 'Laptop': 'WSL2 NAT → home router', 'Firewall (VPS)': 'IONOS policy + ufw + fail2ban' } },
    pod: { name: 'Pod network (Flannel)', color: '--l-pod',
      desc: "Every pod gets its own IP. Pods on the same node talk through the cni0 bridge; across nodes, Flannel wraps packets in VXLAN (UDP 8472) addressed to the other node's tailnet IP, so the overlay rides inside WireGuard.",
      meta: { 'Range': '10.42.0.0/16', 'Per node': '10.42.0 VPS · 10.42.1 laptop · 10.42.2 admin-node', 'Tunnel': 'VXLAN UDP 8472 on tailscale0', 'Watchdog': 'restarts k3s if flannel.1 vanishes' } },
    service: { name: 'Service network', color: '--l-service',
      desc: 'Services are virtual: a stable ClusterIP and DNS name that exist only as iptables rules on every node. kube-proxy rewrites (DNAT) the ClusterIP to one of the pods behind it, wherever that pod runs.',
      meta: { 'Range': '10.43.0.0/16', 'Implementation': 'kube-proxy, iptables DNAT', 'DNS': 'CoreDNS 10.43.0.10', 'Names': '<svc>.<namespace>.svc.cluster.local' } },
    netpol: { name: 'Network policies', color: '--l-netpol',
      desc: "A firewall between pods, enforced by k3s's embedded kube-router controller. Namespace applications denies all incoming traffic by default; allow rules open only the paths the app needs.",
      meta: { 'Default': 'default-deny-ingress', 'Allow': 'gateway→web, front→api, clients→postgres, tailnet→pgAdmin' } },
    edge: { name: 'Edges', color: '--l-edge',
      desc: 'Where traffic enters the cluster. Public: k3s ServiceLB holds ports 80/443 on the VPS and hands connections to APISIX (TLS, routing, plugins). Admin: the Tailscale operator runs one proxy pod per tool, each its own tailnet device with an HTTPS certificate.',
      meta: { 'Public': 'ServiceLB → APISIX (Gateway API)', 'Admin': 'Tailscale operator proxies ×6' } },
    gitops: { name: 'GitOps / control', color: '--l-gitops', focus: false }
  };

  // ------------------------------------------------------------------ frames
  const NODES = [
    { id: 'vps', x: 226, y: 40, w: 650, h: 790, fill: '--node-vps', title: 'master-node',
      sub: ['IONOS VPS · k3s server (control plane)', 'tailnet 100.107.194.25 · public 85.215.234.70'] },
    { id: 'adm', x: 900, y: 40, w: 350, h: 790, fill: '--node-adm', title: 'admin-node',
      sub: ['Friend’s server · KVM · Debian 13', 'k3s agent · 100.71.130.76'] },
    { id: 'lap', x: 1274, y: 40, w: 272, h: 790, fill: '--node-laptop', title: 'apps-node',
      sub: ['Windows laptop › WSL2', 'k3s agent · 100.105.193.72'] }
  ];

  const NAMESPACES = [
    { id: 'apisix', x: 238, y: 92, w: 196, h: 108, chips: ['apisix', 'etcd', 'ingressctl'] },
    { id: 'applications', x: 444, y: 92, w: 420, h: 108, chips: ['front', 'auth', 'payment', 'postgres', 'pgadmin', 'pgbackup', 'migrate'], shield: true },
    { id: 'security', x: 238, y: 210, w: 284, h: 108, chips: ['vault', 'unsealer', 'eso', 'certmgr', 'vaultbackup'] },
    { id: 'security-apps', x: 532, y: 210, w: 108, h: 108, chips: ['falco', 'sidekick'] },
    { id: 'ia', x: 650, y: 210, w: 214, h: 108, chips: ['serviceia', 'ollama'] },
    { id: 'argocd', x: 238, y: 328, w: 284, h: 108, chips: ['argoserver', 'reposerver', 'controller'] },
    { id: 'tailscale', x: 532, y: 328, w: 196, h: 108, chips: ['tsoperator', 'tsproxies'] },
    { id: 'backup', key: 'backup-vps', x: 738, y: 328, w: 126, h: 108, chips: ['k3sbackup'] },
    { id: 'kube-system', x: 238, y: 446, w: 284, h: 108, chips: ['coredns', 'svclb', 'localpath'] },
    { id: 'admin', key: 'admin-vps', x: 532, y: 446, w: 332, h: 108, chips: ['lokicache', 'promtail1', 'nodeexp1'] },
    { id: 'admin', key: 'admin-adm', x: 912, y: 92, w: 326, h: 200, chips: ['prometheus', 'alertmanager', 'ksm', 'loki', 'lokigw', 'tempo', 'grafana', 'headlamp', 'docs', 'promtail3', 'nodeexp3'] },
    { id: 'backup', key: 'backup-lap', x: 1286, y: 92, w: 248, h: 108, chips: ['rustfs'] },
    { id: 'admin', key: 'admin-lap', x: 1286, y: 210, w: 248, h: 108, chips: ['promtail2', 'nodeexp2'] }
  ];

  // Teams (who owns what): drives the "Teams" view
  const TEAMS = {
    apps: { name: 'Applications team', color: '#34d399', desc: 'EPSI Pay: front, auth, payment, database schema and migrations.' },
    ia: { name: 'IA team', color: '#c084fc', desc: 'service-ia and the Ollama LLM: attack analysis and remediation.' },
    sec: { name: 'Security team', color: '#f87171', desc: 'Vault, External Secrets, cert-manager, Falco, network policies.' },
    obs: { name: 'Observability', color: '#38bdf8', desc: 'Prometheus, Alertmanager, Loki, Tempo, Grafana: metrics, logs, traces, alerts.' },
    plat: { name: 'Platform (Karim)', color: '#facc15', desc: 'k3s, Argo CD, APISIX, Tailscale, backups, nodes (Ansible), DNS (Terraform).' }
  };
  const NS_TEAM = { applications: 'apps', ia: 'ia', security: 'sec', 'security-apps': 'sec', admin: 'obs', argocd: 'plat', tailscale: 'plat', backup: 'plat', 'kube-system': 'plat', apisix: 'plat' };
  const NS_COLOR = { apisix: '#f472b6', applications: '#34d399', security: '#f87171', 'security-apps': '#fb7185', ia: '#c084fc', argocd: '#facc15', tailscale: '#a78bfa', backup: '#2dd4bf', 'kube-system': '#94a3b8', admin: '#38bdf8' };

  // ------------------------------------------------------------------ components
  // kind: pod | job | svc | host | bar | ext | device
  // exposure: public | tailnet | internal   ·  vol: volume label   ·  vault: secrets from Vault   ·  app: Argo CD app
  const C = {
    // Internet column
    user: { kind: 'ext', label: 'Customer browser', x: 105, y: 140, w: 150, h: 40, info: { kind: 'Client', where: 'Internet', text: 'Anyone using EPSI Pay at https://app.karim-portfolio.xyz. Only reaches the public edge (APISIX).' } },
    cloudflare: { kind: 'ext', label: 'Cloudflare DNS', x: 105, y: 230, w: 150, h: 40, info: { kind: 'DNS provider', where: 'Internet', addr: 'karim-portfolio.xyz', text: 'Authoritative DNS. app, auth, payment → 85.215.234.70, not proxied. Managed by Terraform (HCP workspace infra-dns), never by hand.' } },
    letsencrypt: { kind: 'ext', label: "Let's Encrypt", x: 105, y: 320, w: 150, h: 40, info: { kind: 'Certificate authority', where: 'Internet', text: 'Issues the public TLS certificates requested by cert-manager, renewed automatically.' } },
    github: { kind: 'ext', label: 'GitHub', sub: 'infra + epsi_pay', x: 105, y: 410, w: 150, h: 40, layers: ['internet', 'gitops'], info: { kind: 'Source of truth + CI', where: 'Internet', addr: 'RESILIENCE-ALPHA/infra, /epsi_pay', text: 'infra: desired state of the platform (Argo CD pulls main). epsi_pay: application code; every merge to master builds new images.' } },
    ghcr: { kind: 'ext', label: 'GHCR images', x: 105, y: 500, w: 150, h: 40, layers: ['internet', 'gitops'], info: { kind: 'Container registry', where: 'Internet', addr: 'ghcr.io/resilience-alpha/epsi-pay-*', text: 'Images built by the epsi_pay CI, tagged <date>.<run> (e.g. 20261116.12). The infra repo pins exact tags.' } },
    hcp: { kind: 'ext', label: 'HCP Terraform', x: 105, y: 590, w: 150, h: 40, layers: ['internet', 'gitops'], info: { kind: 'Terraform service', where: 'Internet', addr: 'org resilience-alpha / infra-dns', text: 'Runs Terraform remotely, stores the state, holds the Cloudflare token as a sensitive variable.' } },
    discord: { kind: 'ext', label: 'Discord', x: 105, y: 680, w: 150, h: 40, info: { kind: 'Alert channel', where: 'Internet', text: 'Receives Alertmanager notifications through a webhook (URL kept in Vault).' } },
    teleport: { kind: 'ext', label: 'Teleport', sub: 'owner access', x: 105, y: 770, w: 150, h: 40, info: { kind: 'Access proxy (friend’s)', where: 'Internet', addr: 'teleport.personnaz.cloud', text: 'How the owner of admin-node reaches it. We used it once, to install Tailscale; Ansible and k3s go through the tailnet.' } },

    // apisix
    apisix: { kind: 'pod', label: 'apisix', layers: ['pod', 'edge'], exposure: 'public', vault: true, app: 'apisix', info: { kind: 'API gateway', addr: 'LoadBalancer :80 :443', text: 'Terminates TLS for app, auth and payment, routes by host and path (Gateway API HTTPRoutes), applies plugins: HTTPS redirect, tracing, basic auth on Swagger.' } },
    etcd: { kind: 'pod', label: 'etcd', vol: 'PVC', app: 'apisix', info: { kind: 'StatefulSet', text: "APISIX's configuration store." } },
    ingressctl: { kind: 'pod', label: 'ingress-ctl', layers: ['pod', 'edge'], app: 'apisix-ingress-controller', info: { kind: 'Controller', text: 'Watches Gateway and HTTPRoute objects and pushes the routes into APISIX.' } },

    // applications
    front: { kind: 'pod', label: 'front', layers: ['pod', 'netpol'], exposure: 'public', netpol: true, app: 'epsi-pay', info: { kind: 'EPSI Pay web app (nginx)', addr: ':8080', text: 'React app served at https://app.karim-portfolio.xyz/. Allowed in: APISIX only.' } },
    auth: { kind: 'pod', label: 'auth', layers: ['pod', 'netpol'], exposure: 'public', netpol: true, vault: true, app: 'epsi-pay', info: { kind: 'EPSI Pay API (NestJS)', addr: ':3000', text: 'Sign-up, login, sessions, passkeys (WebAuthn). Traces to Tempo. Allowed in: APISIX and front.' } },
    payment: { kind: 'pod', label: 'payment', layers: ['pod', 'netpol'], exposure: 'public', netpol: true, vault: true, app: 'epsi-pay', info: { kind: 'EPSI Pay API (NestJS)', addr: ':3000', text: 'Wallets and payments; a passkey signature is required once the user has one. Traces to Tempo.' } },
    postgres: { kind: 'pod', label: 'postgres', layers: ['pod', 'netpol'], netpol: true, vault: true, vol: 'PVC', app: 'postgres', info: { kind: 'Database (PostgreSQL 16)', addr: ':5432', text: 'EPSI Pay data. Allowed in: auth, payment, pgAdmin, backup, seed and migrate jobs, service-ia. Dumped every night at 02:30.' } },
    pgadmin: { kind: 'pod', label: 'pgadmin', layers: ['pod', 'netpol'], exposure: 'tailnet', netpol: true, vault: true, vol: 'PVC', app: 'epsi-pay', info: { kind: 'Database UI', addr: 'https://pgadmin.taild095e0.ts.net', text: 'Tailnet only. Allowed in: the Tailscale proxy namespace.' } },
    pgbackup: { kind: 'job', label: '⏱ pg-backup', layers: ['pod', 'netpol'], netpol: true, vault: true, app: 'postgres', info: { kind: 'CronJob 02:30', text: 'pg_dumpall | gzip, uploaded with rclone to RustFS on the laptop. Keeps 90 days.' } },
    migrate: { kind: 'job', label: '⇧ migrate', layers: ['pod', 'netpol', 'gitops'], netpol: true, app: 'epsi-pay', info: { kind: 'Argo CD PreSync hook', text: 'Runs `npm run migrate` (Prisma migrate deploy) before every sync of epsi-pay: new tables exist before the new code starts. Checks the database against schema.prisma.' } },

    // security
    vault: { kind: 'pod', label: 'vault', exposure: 'tailnet', vol: 'PVC', app: 'vault', info: { kind: 'Secrets store', addr: 'vault :8200 · https://vault.taild095e0.ts.net', text: 'Single source of every secret (apps/..., admin/...). Shamir-sealed (3 of 5 keys), Kubernetes auth for External Secrets.' } },
    unsealer: { kind: 'pod', label: 'unsealer', app: 'security-config', info: { kind: 'Auto-unseal loop', text: 'Checks Vault every 30 s and submits 3 key shares after a restart.' } },
    eso: { kind: 'pod', label: 'ext-secrets', app: 'external-secrets', info: { kind: 'External Secrets Operator', text: 'Logs in to Vault with its ServiceAccount (Kubernetes auth, read-only policy) and writes Kubernetes Secrets.' } },
    certmgr: { kind: 'pod', label: 'cert-mgr', app: 'cert-manager', info: { kind: 'cert-manager', text: "Requests and renews Let's Encrypt certificates for the public hosts." } },
    vaultbackup: { kind: 'job', label: '⏱ vault-bkp', vault: true, app: 'security-config', info: { kind: 'CronJob 03:00', text: "Copies Vault's data volume (read-only) to RustFS." } },

    // security-apps, ia
    falco: { kind: 'pod', label: 'falco', layers: ['pod', 'host'], app: 'falco', info: { kind: 'Runtime security (eBPF)', text: 'Watches every system call on the VPS kernel and matches rules (e.g. unexpected outbound connection).' } },
    sidekick: { kind: 'pod', label: 'sidekick', app: 'falco', info: { kind: 'falcosidekick', text: 'Forwards Falco events to service-ia /remediate.' } },
    serviceia: { kind: 'pod', label: 'service-ia', app: 'ia (own repo)', info: { kind: 'AI remediation service', addr: ':5000', text: 'Receives security events, asks the local LLM to classify them, then remediates (restart the impacted pod).' } },
    ollama: { kind: 'pod', label: 'ollama', vol: '20Gi', app: 'ollama', info: { kind: 'Local LLM server', addr: ':11434', text: 'Runs open models inside the cluster: no data sent to a cloud AI. To be moved off the VPS by the IA team.' } },

    // argocd, tailscale, backup, kube-system, admin on VPS
    argoserver: { kind: 'pod', label: 'argocd-srv', layers: ['pod', 'gitops'], exposure: 'tailnet', app: 'argocd', info: { kind: 'Argo CD UI / API', addr: 'https://argocd.taild095e0.ts.net', text: 'Web UI and API: sync status, diffs, history, manual sync.' } },
    reposerver: { kind: 'pod', label: 'repo-server', layers: ['pod', 'gitops'], app: 'argocd', info: { kind: 'Argo CD repo-server', text: 'Pulls the Git repository and renders manifests (Helm with our values, Kustomize).' } },
    controller: { kind: 'pod', label: 'controller', layers: ['pod', 'gitops'], app: 'argocd', info: { kind: 'Argo CD application controller', text: 'Compares Git and the cluster, applies differences (server-side apply, sync waves, hooks), self-heals drift.' } },
    tsoperator: { kind: 'pod', label: 'ts-operator', layers: ['pod', 'tailnet'], vault: true, app: 'tailscale-operator', info: { kind: 'Tailscale operator', text: 'Turns every Ingress of class tailscale into a proxy that joins the tailnet.' } },
    tsproxies: { kind: 'pod', label: 'proxies ×6', layers: ['pod', 'tailnet', 'edge'], exposure: 'tailnet', app: 'tailnet-admin', info: { kind: 'Tailnet proxies', addr: 'argocd, grafana, headlamp, vault, pgadmin, docs', text: 'One tailnet device per admin tool, with its own 100.x IP and HTTPS certificate; forwards to the tool wherever it runs.' } },
    k3sbackup: { kind: 'job', label: '⏱ k3s-bkp', vault: true, app: 'rustfs', info: { kind: 'CronJob 02:45', text: 'Online copy of the k3s SQLite datastore with an integrity check, uploaded to RustFS.' } },
    coredns: { kind: 'pod', label: 'coredns', layers: ['pod', 'service'], app: 'k3s add-on', info: { kind: 'Cluster DNS', addr: '10.43.0.10', text: 'Resolves <service>.<namespace>.svc.cluster.local to ClusterIPs.' } },
    svclb: { kind: 'pod', label: 'svclb', layers: ['pod', 'edge', 'host'], exposure: 'public', app: 'k3s add-on', info: { kind: 'k3s ServiceLB', addr: 'hostPort 80, 443', text: 'Opens ports 80/443 on the VPS and forwards them to the APISIX LoadBalancer Service.' } },
    localpath: { kind: 'pod', label: 'local-path', app: 'k3s add-on', info: { kind: 'Storage provisioner', text: 'Creates each volume as a folder on the disk of the node where the pod runs: a volume never follows a pod to another node.' } },
    lokicache: { kind: 'pod', label: 'loki-caches', app: 'loki', info: { kind: 'memcached ×2', text: 'Loki chunk and results caches: no data to keep, stay on the VPS on purpose (memory).' } },
    promtail1: { kind: 'pod', label: 'promtail', app: 'promtail', info: { kind: 'Log shipper (DaemonSet)', text: 'Reads container logs on this node and pushes them to Loki on admin-node.' } },
    nodeexp1: { kind: 'pod', label: 'node-exp', app: 'prometheus', info: { kind: 'Node metrics (DaemonSet)', addr: ':9100', text: 'CPU, memory, disk and network of the VPS.' } },

    // admin-node
    prometheus: { kind: 'pod', label: 'prometheus', vol: '10Gi', app: 'prometheus', info: { kind: 'Metrics + alert rules', addr: 'prometheus-server :80', text: 'Scrapes all three nodes and the pods every minute; 13 alert rules; receives span metrics from Tempo. 15 days.' } },
    alertmanager: { kind: 'pod', label: 'alertmgr', vol: '100Mi', vault: true, app: 'prometheus', info: { kind: 'Alert routing', addr: ':9093', text: 'Groups alerts and posts them to Discord.' } },
    ksm: { kind: 'pod', label: 'kube-state', app: 'prometheus', info: { kind: 'kube-state-metrics', text: 'Exposes the state of Kubernetes objects (deployments, jobs, pods) as metrics.' } },
    loki: { kind: 'pod', label: 'loki', vol: '10Gi', app: 'loki', info: { kind: 'Log store', text: 'Stores logs pushed by Promtail, indexed by labels (namespace, app, pod).' } },
    lokigw: { kind: 'pod', label: 'loki-gw', app: 'loki', info: { kind: 'Loki gateway (nginx)', addr: 'loki-gateway :80', text: 'Entry point for pushes and queries.' } },
    tempo: { kind: 'pod', label: 'tempo', vol: '5Gi', app: 'tempo', info: { kind: 'Trace store', addr: ':3200 · OTLP :4318 · Zipkin :9411', text: 'Receives spans from APISIX and auth/payment, keeps 7 days, writes the service graph to Prometheus.' } },
    grafana: { kind: 'pod', label: 'grafana', exposure: 'tailnet', vol: '10Gi', vault: true, app: 'grafana', info: { kind: 'Dashboards', addr: 'https://grafana.taild095e0.ts.net', text: 'One UI for metrics, logs and traces, linked together.' } },
    headlamp: { kind: 'pod', label: 'headlamp', exposure: 'tailnet', app: 'headlamp', info: { kind: 'Kubernetes UI', addr: 'https://headlamp.taild095e0.ts.net', text: 'Browse and manage the cluster with a ServiceAccount token (kept in Vault admin/headlamp).' } },
    docs: { kind: 'pod', label: 'docs-site', exposure: 'tailnet', app: 'docs-site', info: { kind: 'This site (nginx)', addr: 'https://docs.taild095e0.ts.net', text: 'Static files from a ConfigMap generated by Kustomize; a change in Git rolls the pod.' } },
    promtail3: { kind: 'pod', label: 'promtail', app: 'promtail', info: { kind: 'Log shipper (DaemonSet)', text: 'Logs of admin-node to Loki.' } },
    nodeexp3: { kind: 'pod', label: 'node-exp', app: 'prometheus', info: { kind: 'Node metrics (DaemonSet)', addr: ':9100', text: 'Metrics of admin-node.' } },

    // laptop
    rustfs: { kind: 'pod', label: 'rustfs', w: 120, vol: '200Gi', vault: true, app: 'rustfs', info: { kind: 'S3 object storage', addr: 'rustfs.backup :9000', text: 'Target of the three nightly backups, 90 days retention. Off the VPS on purpose.' } },
    promtail2: { kind: 'pod', label: 'promtail', app: 'promtail', info: { kind: 'Log shipper (DaemonSet)', text: "Laptop logs to Loki on admin-node." } },
    nodeexp2: { kind: 'pod', label: 'node-exp', app: 'prometheus', info: { kind: 'Node metrics (DaemonSet)', addr: ':9100', text: 'Laptop metrics.' } },

    // host interfaces: VPS
    cni0vps: { kind: 'bar', node: 'vps', label: 'cni0 bridge · pods 10.42.0.0/24', x: 238, y: 652, w: 626, h: 24, layers: ['pod', 'host'], info: { kind: 'Linux bridge', where: 'master-node', addr: '10.42.0.1/24', text: 'Every pod on the VPS is plugged into this bridge with a veth pair.' } },
    eth0vps: { kind: 'host', node: 'vps', label: 'eth0 · 85.215.234.70', sub: 'IONOS firewall + ufw', x: 310, y: 730, w: 150, h: 40, layers: ['host', 'internet'], exposure: 'public', info: { kind: 'Public interface', where: 'master-node', addr: '85.215.234.70', text: 'Only TCP 22 (keys only), 80, 443 and UDP 41641 are open. Outbound traffic from pods is NATed here.' } },
    apiserver: { kind: 'host', node: 'vps', label: 'k3s server', sub: 'API :6443 · SQLite', x: 476, y: 730, w: 150, h: 40, layers: ['host', 'gitops'], vol: 'state.db', info: { kind: 'Control plane', where: 'master-node', addr: 'https://100.107.194.25:6443 (tailnet only)', text: 'API server, scheduler, controllers and SQLite datastore in the k3s binary. Secrets encrypted at rest. Backed up nightly.' } },
    flannelvps: { kind: 'host', node: 'vps', label: 'flannel.1', sub: 'VXLAN UDP 8472', x: 640, y: 730, w: 130, h: 40, layers: ['host', 'pod'], info: { kind: 'VXLAN device', where: 'master-node', text: "Encapsulates packets for pods on other nodes, sent to the peer node's tailnet IP." } },
    ts0vps: { kind: 'host', node: 'vps', label: 'tailscale0', sub: '100.107.194.25', x: 800, y: 730, w: 120, h: 40, layers: ['host', 'tailnet'], info: { kind: 'WireGuard interface', where: 'master-node', addr: '100.107.194.25', text: 'Encrypts everything sent to other tailnet devices.' } },
    // admin-node
    cni0adm: { kind: 'bar', node: 'adm', label: 'cni0 · pods 10.42.2.0/24', x: 912, y: 652, w: 326, h: 24, layers: ['pod', 'host'], info: { kind: 'Linux bridge', where: 'admin-node', addr: '10.42.2.1/24', text: 'Bridge for the pods on admin-node.' } },
    kubelet3: { kind: 'host', node: 'adm', label: 'k3s agent', sub: 'kubelet :10250', x: 995, y: 728, w: 150, h: 40, layers: ['host', 'gitops'], info: { kind: 'Node agent', where: 'admin-node', text: 'kubelet + containerd + kube-proxy + flannel; joined with Ansible (k3s.yml).' } },
    flanneladm: { kind: 'host', node: 'adm', label: 'flannel.1', sub: 'VXLAN', x: 1160, y: 728, w: 130, h: 40, layers: ['host', 'pod'], info: { kind: 'VXLAN device', where: 'admin-node', text: 'Overlay endpoint of admin-node.' } },
    ts0adm: { kind: 'host', node: 'adm', label: 'tailscale0', sub: '100.71.130.76', x: 995, y: 782, w: 150, h: 40, layers: ['host', 'tailnet'], info: { kind: 'WireGuard interface', where: 'admin-node', addr: '100.71.130.76', text: 'Reaches the other nodes through the friend’s network; no inbound port needed.' } },
    eth0adm: { kind: 'host', node: 'adm', label: 'eth0 · KVM', sub: 'friend’s network', x: 1160, y: 782, w: 130, h: 40, layers: ['host'], info: { kind: 'Host network', where: 'admin-node', text: 'Owned by the friend. Not hardened by our Ansible on purpose: his firewall, his Teleport access.' } },
    // laptop
    cni0lap: { kind: 'bar', node: 'lap', label: 'cni0 · 10.42.1.0/24', x: 1286, y: 652, w: 248, h: 24, layers: ['pod', 'host'], info: { kind: 'Linux bridge', where: 'apps-node', addr: '10.42.1.1/24', text: 'Bridge for the pods on the laptop.' } },
    kubelet2: { kind: 'host', node: 'lap', label: 'k3s agent', sub: 'kubelet', x: 1345, y: 728, w: 110, h: 40, layers: ['host', 'gitops'], info: { kind: 'Node agent', where: 'apps-node', text: 'Registers with the API server over the tailnet.' } },
    flannellap: { kind: 'host', node: 'lap', label: 'flannel.1', sub: 'VXLAN', x: 1478, y: 728, w: 110, h: 40, layers: ['host', 'pod'], info: { kind: 'VXLAN device', where: 'apps-node', text: 'Overlay endpoint of the laptop.' } },
    ts0lap: { kind: 'host', node: 'lap', label: 'tailscale0', sub: '100.105.193.72', x: 1345, y: 782, w: 110, h: 40, layers: ['host', 'tailnet'], info: { kind: 'WireGuard interface', where: 'apps-node', addr: '100.105.193.72', text: 'Reaches the VPS through the home router NAT, or a DERP relay.' } },
    eth0lap: { kind: 'host', node: 'lap', label: 'eth0 · WSL', sub: 'NAT → router', x: 1478, y: 782, w: 110, h: 40, layers: ['host'], info: { kind: 'WSL2 network', where: 'apps-node', text: 'Private 172.x address behind Windows and the home router.' } },

    // tailnet devices
    mac: { kind: 'device', label: "Admin's Mac", x: 105, y: 916, w: 140, h: 32, info: { kind: 'Tailnet device', where: 'tailnet', text: 'Logged in to Tailscale: reaches the admin tools at *.taild095e0.ts.net.' } },
    devcontainer: { kind: 'device', label: 'Dev container', x: 270, y: 916, w: 140, h: 32, layers: ['tailnet', 'gitops'], info: { kind: 'Tailnet device', where: 'tailnet', text: 'kubectl, Ansible, Terraform, linters. API at 100.107.194.25:6443.' } },
    phone: { kind: 'device', label: 'Phone', x: 425, y: 916, w: 110, h: 32, info: { kind: 'Tailnet device', where: 'tailnet', text: 'Tailscale app: admin tools on the go; Discord alerts.' } },
    derp: { kind: 'device', label: 'DERP relay', x: 1210, y: 916, w: 120, h: 32, info: { kind: 'Tailscale relay', where: 'Internet', text: 'Used only when two devices cannot connect directly; forwards encrypted packets it cannot read.' } }
  };

  const SERVICES = [
    ['apisix', 'apisix LB', ':80 :443'], ['front', 'front', ':8080'], ['auth', 'auth', ':3000'], ['payment', 'payment', ':3000'],
    ['postgres', 'postgres', ':5432'], ['vault', 'vault', ':8200'], ['serviceia', 'service-ia', ':5000'], ['ollama', 'ollama', ':11434'],
    ['apiserver', 'kubernetes', ':443 → 6443'], ['prometheus', 'prometheus', ':80'], ['alertmanager', 'alertmgr', ':9093'],
    ['lokigw', 'loki', ':80'], ['tempo', 'tempo', ':3200 :4318 :9411'], ['grafana', 'grafana', ':80'], ['headlamp', 'headlamp', ':80'],
    ['rustfs', 'rustfs', ':9000']
  ];

  // ------------------------------------------------------------------ views (mappings)
  const VIEWS = {
    placement: {
      name: 'Placement', icon: '▦',
      desc: 'Where each pod runs, coloured by namespace. Namespaces are logical and cluster-wide: the same namespace can have pods on several nodes (admin, backup).',
      legend: () => Object.entries(NS_COLOR).map(([ns, color]) => ({ color, text: 'ns/' + ns })),
      style: (c) => ({ color: c.nsLabel ? NS_COLOR[c.nsLabel] : null })
    },
    teams: {
      name: 'Teams', icon: '◎',
      desc: 'Who owns what. Each team changes its part through pull requests on the infra or app repositories; Argo CD applies them.',
      legend: () => Object.values(TEAMS).map((t) => ({ color: t.color, text: t.name })),
      style: (c) => {
        const team = c.nsLabel ? NS_TEAM[c.nsLabel] : (c.kind === 'host' || c.kind === 'bar' ? 'plat' : null);
        return team ? { color: TEAMS[team].color, badge: null } : { dim: c.kind !== 'ext' && c.kind !== 'device' };
      }
    },
    network: {
      name: 'Networks', icon: '⇄',
      desc: 'The seven network layers. Focus one with the chips below; scenarios show how a packet crosses them.',
      legend: () => Object.entries(LAYERS).filter(([, L]) => L.focus !== false).map(([, L]) => ({ color: cssVar(L.color), text: L.name })),
      style: (c) => ({ color: colorOf(defaultLayers(c)[0] || 'host') })
    },
    exposure: {
      name: 'Exposure & security', icon: '⛨',
      desc: 'Public (internet, through APISIX), tailnet only (admins), or internal. 🔒 = behind default-deny network policies · 🔑 = secrets from Vault.',
      legend: () => [{ color: cssVar('--l-internet'), text: 'Public' }, { color: cssVar('--l-tailnet'), text: 'Tailnet only' }, { color: cssVar('--l-host'), text: 'Internal' }],
      style: (c) => {
        if (c.kind === 'ext' || c.kind === 'device' || c.kind === 'svc') return { dim: c.kind === 'svc' };
        const color = c.exposure === 'public' ? cssVar('--l-internet') : c.exposure === 'tailnet' ? cssVar('--l-tailnet') : cssVar('--l-host');
        const badge = [c.netpol ? '🔒' : '', c.vault ? '🔑' : ''].join('') || null;
        return { color, badge, dim: !c.exposure && !c.netpol && !c.vault };
      }
    },
    storage: {
      name: 'Storage & backups', icon: '⛁',
      desc: 'Pods with a volume (local-path: a folder on the node’s disk, which never follows the pod). Dashed arrows: the nightly backups to RustFS on the laptop.',
      legend: () => [{ color: '#2dd4bf', text: 'Has a volume' }, { color: '#f59e0b', text: 'Backup job / flow' }],
      style: (c) => {
        if (c.kind === 'job' && /bkp|backup/.test(c.label)) return { color: '#f59e0b', badge: c.label.includes('pg') ? '02:30' : c.label.includes('k3s') ? '02:45' : '03:00' };
        if (c.vol) return { color: '#2dd4bf', badge: c.vol };
        return { dim: c.kind !== 'ext' && c.kind !== 'device' };
      },
      overlay: (g) => {
        const color = '#f59e0b';
        // Each job → RustFS on the laptop (through the tunnel in reality: see the "Nightly backup" scenario)
        [['pgbackup', '02:30 Postgres'], ['vaultbackup', '03:00 Vault'], ['k3sbackup', '02:45 k3s']].forEach(([from, label], i) => {
          const a = C[from], b = C.rustfs;
          const lane = 558 + i * 6;
          const d = `M${a.x} ${a.y + 14} V${lane} H${b.x - 30 + i * 12} V${b.y + 14}`;
          el('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.8, 'stroke-dasharray': '6 5', opacity: 0.9 }, g);
          el('text', { x: a.x + 6, y: lane - 3, class: 'tag', fill: color }, g).textContent = label;
        });
      }
    }
  };

  // ------------------------------------------------------------------ scenarios
  const SCENARIOS = [
    {
      id: 'payment', name: 'Customer payment', color: '--l-internet',
      steps: [
        { from: 'user', to: 'cloudflare', layer: 'internet', tag: 'DNS', title: 'DNS lookup',
          text: 'The browser asks Cloudflare for app.karim-portfolio.xyz. The record, managed by Terraform, answers 85.215.234.70: the VPS.',
          stack: ['internet|UDP 53 · DNS query  A app.karim-portfolio.xyz', 'internet|answer  85.215.234.70'] },
        { from: 'user', to: 'eth0vps', layer: 'internet', tag: 'TCP 443', title: 'HTTPS to the VPS',
          text: 'TCP 443 to the VPS. The IONOS firewall and ufw let it through: only 22, 80, 443 and 41641/udp are open.',
          stack: ['internet|IP client → 85.215.234.70', 'internet|TCP → :443', 'internet|TLS (encrypted HTTP)'] },
        { from: 'eth0vps', to: 'svclb', layer: 'edge', tag: 'hostPort', title: 'ServiceLB takes the connection',
          text: 'k3s ServiceLB owns host ports 80/443 and forwards them to the APISIX LoadBalancer Service, keeping the client IP.',
          stack: ['edge|hostPort 443 → Service apisix-gateway'] },
        { from: 'svclb', to: 'apisix', via: ['svc-apisix'], layer: 'edge', tag: 'TLS', title: 'APISIX terminates TLS and routes',
          text: "APISIX decrypts TLS with the Let's Encrypt certificate, matches the HTTPRoute (host app…, path /api/payments) and sends it to Service epsi-pay-payment:3000. It opens the root span of the trace.",
          stack: ['pod|10.42.0.x (svclb) → 10.42.0.y (apisix)', 'edge|TLS terminated here', 'edge|HTTP POST /api/payments'] },
        { from: 'apisix', to: 'payment', via: ['svc-payment'], layer: 'service', tag: ':3000', title: 'Service → pod (kube-proxy)',
          text: 'kube-proxy rewrites the ClusterIP to a payment pod IP. The applications namespace is default-deny; allow-gateway-to-web lets APISIX in.',
          netpol: 'allow-gateway-to-web ✓  (from apisix pods)',
          stack: ['service|→ 10.43.a.b:3000  (ClusterIP)', 'pod|DNAT → 10.42.0.z:3000  (payment pod)', 'pod|HTTP POST /payments + passkey signature + B3 headers'] },
        { from: 'payment', to: 'postgres', via: ['svc-postgres'], layer: 'pod', tag: ':5432', title: 'Database transaction',
          text: 'payment verifies the passkey signature, then writes the transaction in Postgres.',
          netpol: 'allow-postgres-clients ✓  (from payment)',
          stack: ['service|postgres.applications.svc.cluster.local', 'pod|TCP :5432 · INSERT transaction'] },
        { from: 'payment', to: 'tempo', svc: 'svc-tempo', layer: 'pod', tag: 'OTLP', title: 'Spans to Tempo, on admin-node',
          text: 'The spans go to Tempo, which runs on admin-node: the packet leaves the VPS through Flannel (VXLAN) inside WireGuard and enters the friend’s server.',
          stack: ['service|tempo.admin:4318', 'host|VXLAN 100.107.194.25 → 100.71.130.76 (inside WireGuard)', 'pod|OTLP/HTTP spans'] },
        { from: 'apisix', to: 'user', via: ['svc-apisix', 'svclb', 'eth0vps'], layer: 'internet', tag: '201', title: 'Response',
          text: 'The answer goes back through APISIX, encrypted with TLS. Payment done.',
          stack: ['internet|TLS · HTTP 201 Created'] }
      ]
    },
    {
      id: 'admin', name: 'Admin opens Grafana', color: '--l-tailnet',
      steps: [
        { from: 'mac', to: 'tsproxies', via: ['bus@mac', 'bus@tsproxies'], layer: 'tailnet', tag: 'WireGuard', title: 'MagicDNS + WireGuard',
          text: 'grafana.taild095e0.ts.net resolves (MagicDNS) to the Grafana proxy, a pod on the VPS. WireGuard encrypts from the Mac straight into it.',
          stack: ['tailnet|UDP 41641 · WireGuard', 'tailnet|100.x (Mac) → 100.y (grafana proxy)', 'tailnet|TLS, Tailscale certificate'] },
        { from: 'tsproxies', to: 'grafana', svc: 'svc-grafana', layer: 'pod', tag: 'HTTP', title: 'Proxy → Grafana on admin-node',
          text: 'The proxy forwards to Service grafana:80. Grafana runs on admin-node, so the packet crosses from the VPS to the friend’s server through the overlay.',
          stack: ['service|grafana.admin:80', 'host|VXLAN inside WireGuard → 100.71.130.76', 'pod|HTTP GET /explore'] },
        { from: 'grafana', to: 'tempo', via: ['svc-tempo'], layer: 'service', tag: 'TraceQL', title: 'Queries stay on admin-node',
          text: 'Grafana asks Tempo (TraceQL), Prometheus (PromQL) and Loki (LogQL). All run on admin-node: these queries never leave it.',
          stack: ['service|tempo.admin:3200', 'service|prometheus-server.admin:80', 'service|loki-gateway.admin:80'] },
        { from: 'user', to: 'eth0vps', layer: 'internet', tag: '✗', blocked: true, title: 'From the internet: nothing',
          text: 'Without Tailscale the name does not resolve, and no public route or DNS record leads to the admin tools.',
          stack: ['internet|grafana.taild095e0.ts.net → NXDOMAIN', 'internet|grafana.karim-portfolio.xyz → no record'] }
      ]
    },
    {
      id: 'feature', name: 'Ship a feature', color: '--l-gitops',
      steps: [
        { from: 'devcontainer', to: 'github', via: ['bus@devcontainer'], layer: 'gitops', tag: 'PR', title: 'Code + migration in a PR (epsi_pay)',
          text: 'The feature is coded on a branch of epsi_pay. A schema change comes with its Prisma migration (npm run prisma:migrate). Pull request, review, merge to master.',
          stack: ['gitops|schema.prisma + prisma/migrations/<new>/migration.sql', 'gitops|merge → master'] },
        { from: 'github', to: 'ghcr', layer: 'gitops', tag: 'build', title: 'CI builds the images',
          text: 'GitHub Actions builds auth, payment, front and database, tagged <date>.<run>, and pushes them to GHCR.',
          stack: ['gitops|docker-publish · tag 20261116.N'] },
        { from: 'devcontainer', to: 'github', via: ['bus@devcontainer'], layer: 'gitops', tag: 'tags', title: 'Bump the tags (infra)',
          text: 'A pull request on infra changes the four image tags in kubernetes/applications/kustomization.yaml. CI validates, merge.',
          stack: ['gitops|images: auth, payment, front, database → 20261116.N'] },
        { from: 'reposerver', to: 'github', via: ['cni0vps', 'eth0vps'], layer: 'gitops', tag: 'pull', title: 'Argo CD sees the commit',
          text: 'The repo-server pulls main and renders the manifests; the controller finds epsi-pay OutOfSync.',
          stack: ['internet|HTTPS · git fetch main'] },
        { from: 'controller', to: 'migrate', layer: 'gitops', tag: 'PreSync', title: 'PreSync: the migrate Job',
          text: 'Before touching any pod, Argo CD runs the epsi-pay-migrate Job (database image of the same tag).',
          stack: ['gitops|hook PreSync · Job epsi-pay-migrate'] },
        { from: 'migrate', to: 'postgres', via: ['svc-postgres'], layer: 'pod', tag: 'migrate', title: 'Migrations applied',
          text: 'It waits for Postgres, applies the pending migrations (never deletes data), and checks the database matches schema.prisma. If it fails, the sync stops: the old version keeps running.',
          netpol: 'allow-postgres-clients ✓  (from epsi-pay-migrate)',
          stack: ['pod|prisma migrate deploy', 'pod|migrate diff → OK : aucun écart'] },
        { from: 'controller', to: 'auth', via: ['svc-apiserver'], layer: 'gitops', tag: 'rollout', title: 'New pods roll out',
          text: 'Argo CD applies the new Deployments; new pods start with the new images, old ones stop once the new ones are ready. Synced · Healthy.',
          stack: ['gitops|ReplicaSet new → Ready', 'gitops|Synced · Healthy'] }
      ]
    },
    {
      id: 'secrets', name: 'Secret from Vault', color: '--l-service',
      steps: [
        { from: 'eso', to: 'vault', via: ['svc-vault'], layer: 'service', tag: 'login', title: 'Kubernetes auth login',
          text: 'The External Secrets Operator presents its ServiceAccount token (a signed JWT) to Vault, role external-secrets. No static token anywhere.',
          stack: ['pod|POST /v1/auth/kubernetes/login'] },
        { from: 'vault', to: 'apiserver', via: ['svc-apiserver'], layer: 'service', tag: 'TokenReview', title: 'Vault checks the JWT',
          text: 'Vault asks the API server if the JWT is genuine, then returns a short-lived token limited to read-only on apps/*.',
          stack: ['gitops|TokenReview → system:serviceaccount:security:external-secrets'] },
        { from: 'eso', to: 'vault', via: ['svc-vault'], layer: 'service', tag: 'read', title: 'Read the secret',
          text: 'ESO reads the path named in the ExternalSecret (e.g. apps/postgres-epsi-pay). The ExternalSecret is in Git; the value never is.',
          stack: ['pod|GET /v1/apps/data/postgres-epsi-pay'] },
        { from: 'eso', to: 'apiserver', via: ['svc-apiserver'], layer: 'service', tag: 'Secret', title: 'Write the Kubernetes Secret',
          text: 'ESO writes the Secret; k3s encrypts it at rest (aescbc) before it reaches SQLite.',
          stack: ['host|encrypted at rest (aescbc)'] },
        { from: 'apiserver', to: 'payment', via: ['cni0vps'], layer: 'gitops', tag: 'env', title: 'The pod gets it',
          text: 'The kubelet injects the Secret as environment variables when the pod starts.',
          stack: ['pod|env DB_USER, DB_PASSWORD'] },
        { from: 'unsealer', to: 'vault', layer: 'pod', tag: 'unseal', title: 'Auto-unseal after a restart',
          text: 'Every 30 s vault-unsealer checks Vault; after a restart it submits 3 of the 5 key shares.',
          stack: ['pod|PUT /v1/sys/unseal ×3'] }
      ]
    },
    {
      id: 'backup', name: 'Nightly backup', color: '--l-pod',
      steps: [
        { from: 'pgbackup', to: 'postgres', via: ['svc-postgres'], layer: 'pod', tag: ':5432', title: '02:30 · pg_dumpall',
          text: 'The postgres-backup CronJob starts a pod on the VPS that dumps every database.',
          netpol: 'allow-postgres-clients ✓  (from postgres-backup)', stack: ['pod|pg_dumpall | gzip'] },
        { from: 'pgbackup', to: 'svc-rustfs', layer: 'service', tag: ':9000', title: 'To the RustFS Service',
          text: 'rclone uploads to rustfs.backup:9000 (S3). The ClusterIP is rewritten to the RustFS pod IP 10.42.1.x, on the laptop.',
          stack: ['service|→ 10.43.r.r:9000', 'pod|DNAT → 10.42.1.x:9000  (other node)'] },
        { from: 'svc-rustfs', to: 'flannelvps', via: ['cni0vps'], layer: 'pod', tag: 'VXLAN', title: 'Flannel wraps it in VXLAN',
          text: 'The route 10.42.1.0/24 → flannel.1: the packet is wrapped in VXLAN (UDP 8472) addressed to the laptop’s tailnet IP.',
          stack: ['host|outer 100.107.194.25 → 100.105.193.72', 'pod|UDP 8472 · VXLAN', 'pod|inner 10.42.0.b → 10.42.1.x', 'pod|TCP :9000 · S3 PUT'] },
        { from: 'flannelvps', to: 'ts0vps', layer: 'tailnet', tag: 'WireGuard', title: 'WireGuard encrypts it',
          text: 'tailscale0 encrypts the whole VXLAN packet and sends it as UDP to the laptop’s current address (NAT traversal).',
          stack: ['internet|85.215.234.70 → home public IP', 'tailnet|UDP 41641 · WireGuard', 'pod|└ VXLAN packet (unreadable)'] },
        { from: 'ts0vps', to: 'ts0lap', via: ['bus@ts0vps', 'bus@ts0lap'], layer: 'tailnet', tag: 'internet', title: 'Across the internet',
          text: 'Through the internet, the home router, Windows and WSL2 (or a DERP relay), still encrypted end to end.',
          stack: ['tailnet|UDP 41641 · WireGuard'] },
        { from: 'ts0lap', to: 'flannellap', layer: 'pod', tag: 'decap', title: 'Decrypt, decapsulate',
          text: 'tailscale0 decrypts; flannel.1 strips the VXLAN header; the inner packet goes to cni0.',
          stack: ['pod|10.42.0.b → 10.42.1.x · S3 PUT'] },
        { from: 'flannellap', to: 'rustfs', via: ['cni0lap'], layer: 'pod', tag: 'stored', title: 'Stored on the laptop',
          text: 'RustFS writes the dump on its 200 Gi volume, 90 days kept. k3s (02:45) and Vault (03:00) take the same path.',
          stack: ['pod|200 OK · object stored'] }
      ]
    },
    {
      id: 'observe', name: 'Metrics, logs, alert', color: '--l-service',
      steps: [
        { from: 'prometheus', to: 'nodeexp1', layer: 'pod', tag: 'scrape', title: 'Prometheus scrapes the VPS',
          text: 'From admin-node, Prometheus pulls the VPS metrics every minute: admin-node → tunnel → VPS.',
          stack: ['pod|GET :9100/metrics', 'host|VXLAN inside WireGuard'] },
        { from: 'prometheus', to: 'nodeexp2', layer: 'pod', tag: 'scrape', title: '…and the laptop',
          text: 'Same for the laptop: admin-node → tunnel → apps-node. Every node is scraped, wherever it is.',
          stack: ['pod|GET :9100/metrics'] },
        { from: 'promtail1', to: 'lokigw', svc: 'svc-lokigw', layer: 'pod', tag: 'push', title: 'Promtail ships logs to Loki',
          text: 'Promtail on each node pushes the container logs to the Loki gateway on admin-node.',
          stack: ['service|loki-gateway.admin:80', 'pod|POST /loki/api/v1/push'] },
        { from: 'prometheus', to: 'alertmanager', layer: 'pod', tag: 'alert', title: 'A rule fires',
          text: 'An expression (e.g. NodeNotReady, BackupTooOld) stays true for its "for" duration; Prometheus sends it to Alertmanager, next to it.',
          stack: ['pod|POST /api/v2/alerts'] },
        { from: 'alertmanager', to: 'discord', via: ['cni0adm', 'eth0adm'], layer: 'internet', tag: 'webhook', title: 'Notification on Discord',
          text: 'Alertmanager posts to the Discord webhook, going out through the friend’s network. Note: if admin-node is down, nobody is alerted. An external uptime check covers that.',
          stack: ['internet|HTTPS · discord webhook', 'internet|[FIRING:1] NodeNotReady'] }
      ]
    },
    {
      id: 'falco', name: 'Attack → AI', color: '--l-netpol',
      steps: [
        { from: 'vault', to: 'falco', layer: 'host', tag: 'syscall', title: 'Falco sees a system call',
          text: "Falco's eBPF probe sees an unexpected outbound connection in namespace security: a rule fires.",
          stack: ['host|kernel event · connect()'] },
        { from: 'falco', to: 'sidekick', layer: 'pod', tag: 'event', title: 'Event to falcosidekick', text: 'Falco hands the JSON event to falcosidekick.', stack: ['pod|JSON event'] },
        { from: 'sidekick', to: 'serviceia', via: ['svc-serviceia'], layer: 'service', tag: 'webhook', title: 'Webhook to service-ia', text: 'POST /remediate on service-ia.', stack: ['pod|POST /remediate'] },
        { from: 'serviceia', to: 'ollama', via: ['svc-ollama'], layer: 'service', tag: 'LLM', title: 'Ask the local LLM', text: 'Ollama classifies the event with a model running in the cluster.', stack: ['pod|POST /api/generate'] },
        { from: 'serviceia', to: 'apiserver', via: ['svc-apiserver'], layer: 'gitops', tag: 'remediate', title: 'Remediation', text: 'Delete the impacted pod through the API; its controller starts a clean one.', stack: ['gitops|DELETE pod'] }
      ]
    },
    {
      id: 'control', name: 'Control plane', color: '--l-tailnet',
      steps: [
        { from: 'kubelet3', to: 'apiserver', via: ['ts0adm', 'bus@ts0adm', 'bus@ts0vps', 'ts0vps'], layer: 'tailnet', tag: ':6443', title: 'admin-node talks to the API',
          text: 'The k3s agent on the friend’s server registers with 100.107.194.25:6443 over the tailnet. Port 6443 is closed on the internet.',
          stack: ['tailnet|WireGuard', 'host|TCP 6443 · mutual TLS'] },
        { from: 'kubelet2', to: 'apiserver', via: ['ts0lap', 'bus@ts0lap', 'bus@ts0vps', 'ts0vps'], layer: 'tailnet', tag: ':6443', title: 'So does the laptop',
          text: 'Same path for apps-node, from behind the home NAT.', stack: ['tailnet|WireGuard'] },
        { from: 'devcontainer', to: 'kubelet3', via: ['bus@devcontainer', 'bus@ts0adm', 'ts0adm'], layer: 'tailnet', tag: 'ansible', title: 'Ansible over the tailnet',
          text: 'Ansible reaches every node over the tailnet (SSH to 100.x). That is how admin-node joined: k3s.yml --limit admin-node.',
          stack: ['tailnet|SSH over WireGuard'] },
        { from: 'flanneladm', to: 'flanneladm', layer: 'pod', tag: 'watchdog', title: 'Flannel watchdog',
          text: 'A systemd timer on every node restarts k3s if flannel.1 disappears; FlannelTunnelMissing alerts on Discord.',
          stack: ['host|systemd timer flannel-watchdog'] }
      ]
    }
  ];

  // ------------------------------------------------------------------ helpers
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const colorOf = (layer) => cssVar((LAYERS[layer] || LAYERS.gitops).color);
  function el(tag, attrs, parent) {
    const n = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function defaultLayers(c) {
    if (c.layers) return c.layers;
    return { pod: ['pod'], job: ['pod'], svc: ['service'], host: ['host'], bar: ['pod', 'host'], ext: ['internet'], device: ['tailnet'] }[c.kind] || [];
  }
  const nodeOfFrame = (x) => (x >= 1274 ? 'lap' : x >= 900 ? 'adm' : 'vps');
  const NODE_NAME = { vps: 'master-node (VPS)', adm: 'admin-node (friend’s server)', lap: 'apps-node (laptop)' };
  const TUNNEL = { vps: ['cni0vps', 'flannelvps', 'ts0vps'], adm: ['cni0adm', 'flanneladm', 'ts0adm'], lap: ['cni0lap', 'flannellap', 'ts0lap'] };

  function layout() {
    NAMESPACES.forEach((ns) => {
      const key = ns.key || ns.id;
      const cap = Math.max(1, Math.floor((ns.w - 2 * PAD + GAP) / (CHIP_W + GAP)));
      ns.chips.forEach((id, i) => {
        const c = C[id]; const col = i % cap; const row = Math.floor(i / cap);
        c.w = c.w || CHIP_W; c.h = CHIP_H;
        c.x = ns.x + PAD + col * (CHIP_W + GAP) + c.w / 2;
        c.y = ns.y + TITLE + 6 + row * (CHIP_H + GAP) + CHIP_H / 2;
        c.nsKey = key; c.nsLabel = ns.id; c.node = nodeOfFrame(ns.x);
      });
    });
    const sorted = SERVICES.slice().sort((a, b) => C[a[0]].x - C[b[0]].x);
    const SW = 74, SG = 6;
    sorted.forEach(([target, label, ports], i) => {
      C['svc-' + target] = {
        kind: 'svc', label, x: 238 + SW / 2 + i * (SW + SG), y: 612, w: SW, h: 26, target,
        info: { kind: 'Service (ClusterIP, virtual)', where: 'every node (iptables)', addr: ports,
          text: 'Stable virtual IP and DNS name in front of ' + (C[target].label || target).replace(/^[⏱⇧] /, '') + '. kube-proxy DNATs it to a pod IP, on whichever node the pod runs.' }
      };
    });
  }

  function anchor(id, prev) {
    if (id.startsWith('bus@')) return { x: C[id.slice(4)].x, y: BUS_Y };
    const c = C[id];
    if (!c) throw new Error('unknown component ' + id);
    if (c.kind === 'bar') {
      const px = prev ? prev.x : c.x + c.w / 2;
      return { x: Math.min(Math.max(px, c.x + 14), c.x + c.w - 14), y: c.y + c.h / 2 };
    }
    return { x: c.x, y: c.y };
  }

  /** Hops of a step. Without `via`, pods on different nodes go through the real tunnel. */
  function hops(step) {
    if (step.via) return [step.from].concat(step.via, [step.to]);
    const a = C[step.from], b = C[step.to];
    const ids = [step.from];
    if (step.svc) ids.push(step.svc);
    if (a && b && a.node && b.node && a.node !== b.node && step.from !== step.to) {
      const [cA, fA, tA] = TUNNEL[a.node], [cB, fB, tB] = TUNNEL[b.node];
      ids.push(cA, fA, tA, 'bus@' + tA, 'bus@' + tB, tB, fB, cB);
    }
    ids.push(step.to);
    return ids;
  }

  // ------------------------------------------------------------------ render
  let svg, gAnim, gOverlay, chipEls = {}, nodeEls = {}, layerEls = [], state;

  function render() {
    svg.textContent = '';
    chipEls = {}; nodeEls = {}; layerEls = [];
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const defs = el('defs', null, svg);
    const f = el('filter', { id: 'glow', x: '-40%', y: '-40%', width: '180%', height: '180%' }, defs);
    el('feGaussianBlur', { stdDeviation: '3.2', result: 'b' }, f);
    const m = el('feMerge', null, f); el('feMergeNode', { in: 'b' }, m); el('feMergeNode', { in: 'SourceGraphic' }, m);
    const pat = el('pattern', { id: 'grid', width: '20', height: '20', patternUnits: 'userSpaceOnUse' }, defs);
    el('path', { d: 'M20 0H0V20', fill: 'none', stroke: cssVar('--line-soft'), 'stroke-width': '0.6' }, pat);
    el('rect', { x: 0, y: 0, width: W, height: H, fill: 'url(#grid)' }, svg);
    const tag = (n, layers) => { n.classList.add('layerable'); n.dataset.layers = layers.join(' '); layerEls.push(n); return n; };

    // Internet region
    const inet = tag(el('g', null, svg), ['internet']);
    el('rect', { x: 14, y: 40, width: 182, height: 790, rx: 16, fill: colorOf('internet'), 'fill-opacity': '0.06', stroke: colorOf('internet'), 'stroke-opacity': '0.45', 'stroke-dasharray': '6 5' }, inet);
    el('text', { x: 28, y: 66, class: 'band-label', fill: colorOf('internet') }, inet).textContent = 'INTERNET';
    el('text', { x: 28, y: 82, class: 'band-sub' }, inet).textContent = 'public network';
    el('line', { x1: 196, y1: 730, x2: 235, y2: 730, class: 'wire', stroke: colorOf('internet'), 'stroke-dasharray': '4 3' }, inet);

    // Nodes
    NODES.forEach((n) => {
      const g = el('g', { class: 'node-frame' }, svg);
      const r = el('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 18, class: 'node-box', fill: cssVar(n.fill), stroke: cssVar('--line') }, g);
      nodeEls[n.id] = r;
      el('text', { x: n.x + 14, y: n.y + 19, class: 'node-title' }, g).textContent = n.title;
      el('text', { x: n.x + 14, y: n.y + 32, class: 'node-sub node-sub-s' }, g).textContent = n.sub[0];
      el('text', { x: n.x + 14, y: n.y + 44, class: 'node-sub node-sub-s mono' }, g).textContent = n.sub[1];
      g.addEventListener('click', (e) => { if (e.target === r) showNodeInfo(n.id); });
    });

    // Node notes (admin-node, laptop)
    const notes = [
      [912, 314, 326, 240, ['Taint node-role/admin=true:NoSchedule:', 'only the admin tools land here.', '', 'Metrics, logs, traces, dashboards,', 'Headlamp, this site. Monitoring', 'lives here: if this node is down,', 'no alert is sent (see Operations).', '', 'Reached over the tailnet only;', 'its owner uses Teleport.']],
      [1286, 330, 248, 224, ['Taint location=home:NoSchedule:', 'only RustFS and the agents.', '', 'WSL2 kept alive by a Windows', 'scheduled task, behind home NAT.', '', 'Laptop off → the app keeps', 'running; backups wait.']]
    ];
    notes.forEach(([x, y, w, h, lines]) => {
      el('rect', { x, y, width: w, height: h, rx: 10, fill: 'none', stroke: cssVar('--line'), 'stroke-dasharray': '3 4' }, svg);
      const t = el('text', { x: x + 12, y: y + 22, class: 'node-sub' }, svg);
      lines.forEach((line, i) => { const s = el('tspan', { x: x + 12, dy: i ? 17 : 0 }, t); s.textContent = line; });
    });

    // Namespaces
    NAMESPACES.forEach((ns) => {
      const g = el('g', null, svg);
      el('rect', { x: ns.x, y: ns.y, width: ns.w, height: ns.h, rx: 10, class: 'ns-box' }, g);
      el('text', { x: ns.x + 10, y: ns.y + 16, class: 'ns-title' }, g).textContent = 'ns/' + ns.id;
      if (ns.shield) {
        const s = tag(el('g', null, g), ['netpol']);
        const w = 128, x = ns.x + ns.w - w - 8, y = ns.y + 5;
        el('rect', { x, y, width: w, height: 16, rx: 8, fill: colorOf('netpol'), 'fill-opacity': '0.14', stroke: colorOf('netpol'), 'stroke-opacity': '0.6' }, s);
        el('text', { x: x + w / 2, y: y + 11.5, 'text-anchor': 'middle', class: 'tag', fill: colorOf('netpol') }, s).textContent = '⛨ default-deny ingress';
      }
    });

    // Service band
    const sb = tag(el('g', null, svg), ['service']);
    el('rect', { x: 226, y: 572, width: 1320, height: 66, rx: 12, fill: colorOf('service'), 'fill-opacity': '0.07', stroke: colorOf('service'), 'stroke-opacity': '0.5', 'stroke-dasharray': '6 5' }, sb);
    el('text', { x: 240, y: 592, class: 'band-label', fill: colorOf('service') }, sb).textContent = 'SERVICE NETWORK';
    el('text', { x: 378, y: 592, class: 'band-sub' }, sb).textContent = 'ClusterIP 10.43.0.0/16 · virtual, on every node (kube-proxy iptables) · CoreDNS <svc>.<ns>.svc.cluster.local';

    // VXLAN overlay between the three flannel devices
    const vx = tag(el('g', null, svg), ['pod']);
    el('path', { d: 'M640 710 V700 H1478 V708 M1160 700 V708', class: 'wire', stroke: colorOf('pod'), 'stroke-dasharray': '6 4' }, vx);
    el('text', { x: 700, y: 696, class: 'tag', fill: colorOf('pod') }, vx).textContent = 'VXLAN overlay 10.42.0/24 ⇄ 10.42.2/24 ⇄ 10.42.1/24 (inside WireGuard)';

    // Tailnet band
    const tb = tag(el('g', null, svg), ['tailnet']);
    el('rect', { x: 14, y: 846, width: 1532, height: 140, rx: 16, fill: colorOf('tailnet'), 'fill-opacity': '0.08', stroke: colorOf('tailnet'), 'stroke-opacity': '0.55', 'stroke-dasharray': '6 5' }, tb);
    el('line', { x1: 40, y1: BUS_Y, x2: 1530, y2: BUS_Y, class: 'wire', stroke: colorOf('tailnet'), 'stroke-opacity': '0.7' }, tb);
    el('text', { x: 28, y: 974, class: 'band-label', fill: colorOf('tailnet') }, tb).textContent = 'TAILNET';
    el('text', { x: 98, y: 974, class: 'band-sub' }, tb).textContent = 'WireGuard mesh · 100.64.0.0/10 · MagicDNS *.taild095e0.ts.net · UDP 41641, DERP fallback';
    [['ts0vps'], ['ts0adm'], ['ts0lap'], ['tsproxies', true]].forEach(([id, dashed]) => {
      const c = C[id];
      el('line', { x1: c.x, y1: c.y + c.h / 2, x2: c.x, y2: BUS_Y, class: 'wire', stroke: colorOf('tailnet'), 'stroke-dasharray': dashed ? '3 4' : '', 'stroke-opacity': '0.8' }, tb);
    });
    ['mac', 'devcontainer', 'phone', 'derp'].forEach((id) => {
      const c = C[id];
      el('line', { x1: c.x, y1: BUS_Y, x2: c.x, y2: c.y - c.h / 2, class: 'wire', stroke: colorOf('tailnet'), 'stroke-opacity': '0.8' }, tb);
    });

    gOverlay = el('g', { 'pointer-events': 'none' }, svg);
    Object.keys(C).forEach((id) => drawChip(id));
    gAnim = el('g', { 'pointer-events': 'none' }, svg);
    applyView();
  }

  function drawChip(id) {
    const c = C[id];
    const g = el('g', { class: 'chip ' + c.kind, tabindex: '0', role: 'button', 'aria-label': (c.label || id).replace(/^[⏱⇧] /, '') }, svg);
    g.dataset.id = id;
    g.classList.add('layerable'); g.dataset.layers = defaultLayers(c).join(' '); layerEls.push(g);
    const x = c.kind === 'bar' ? c.x : c.x - c.w / 2;
    const y = c.kind === 'bar' ? c.y : c.y - c.h / 2;
    const rx = c.kind === 'device' ? c.h / 2 : 6;
    el('rect', { x, y, width: c.w, height: c.h, rx, class: 'chip-base' }, g);
    el('rect', { x, y, width: c.w, height: c.h, rx, class: 'chip-tint', 'stroke-dasharray': c.kind === 'job' ? '2 2' : c.kind === 'svc' ? '4 3' : '' }, g);
    const cx = c.kind === 'bar' ? c.x + c.w / 2 : c.x;
    const cy = c.kind === 'bar' ? c.y + c.h / 2 : c.y;
    if (c.sub) {
      el('text', { x: cx, y: cy - 2, 'text-anchor': 'middle' }, g).textContent = c.label;
      el('text', { x: cx, y: cy + 11, 'text-anchor': 'middle', class: 'mono chip-sub' }, g).textContent = c.sub;
    } else {
      const t = el('text', { x: cx, y: cy + 3.8, 'text-anchor': 'middle', class: c.kind === 'bar' || c.kind === 'svc' ? 'mono' : '' }, g);
      if (c.kind === 'svc') t.setAttribute('style', 'font-size:9px');
      if (c.kind === 'bar') t.setAttribute('class', 'mono chip-sub');
      t.textContent = c.label;
    }
    const badge = el('text', { x: x + c.w - 3, y: y - 3, 'text-anchor': 'end', class: 'chip-badge' }, g);
    badge.textContent = '';
    chipEls[id] = g;
    g.addEventListener('click', () => showInfo(id));
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showInfo(id); } });
  }

  // ------------------------------------------------------------------ views
  function applyView() {
    const view = VIEWS[state.view];
    gOverlay.textContent = '';
    Object.entries(chipEls).forEach(([id, g]) => {
      const c = C[id];
      const s = view.style(c) || {};
      const color = s.color || cssVar('--line');
      const tint = g.querySelector('.chip-tint');
      tint.setAttribute('stroke', color);
      tint.setAttribute('fill', s.color || 'transparent');
      tint.setAttribute('fill-opacity', s.color ? '0.14' : '0');
      g.querySelector('.chip-badge').textContent = s.badge || '';
      g.classList.toggle('view-dim', !!s.dim);
    });
    if (view.overlay) view.overlay(gOverlay);
    document.querySelector('.layer-bar').hidden = state.view !== 'network';
    if (state.view !== 'network') state.focus.clear();
    syncLayerChips(); applyFocus();
    const vd = document.querySelector('.view-desc'); vd.textContent = view.desc;
    buildLegend(view.legend());
  }

  function applyFocus() {
    const f = state.focus;
    layerEls.forEach((n) => {
      const ls = (n.dataset.layers || '').split(' ');
      n.classList.toggle('dim', f.size > 0 && !ls.some((l) => f.has(l)));
    });
  }

  // ------------------------------------------------------------------ panel
  const $ = (sel) => document.querySelector(sel);
  function setStack(items) {
    const box = $('.stack'); box.textContent = '';
    if (!items || !items.length) return;
    const t = document.createElement('div'); t.className = 'stack-title'; t.textContent = 'Packet, outer → inner';
    box.appendChild(t);
    items.forEach((s) => {
      const [layer, text] = s.includes('|') ? s.split(/\|(.*)/s) : ['host', s];
      const d = document.createElement('div'); d.className = 'hdr';
      d.style.setProperty('--hc', colorOf(layer)); d.textContent = text; box.appendChild(d);
    });
  }

  function fillInfo(kind, title, meta, text) {
    const card = $('.info-card'); card.hidden = false;
    $('.info-kind').textContent = kind; $('.info-title').textContent = title;
    const dl = $('.info-meta'); dl.textContent = '';
    Object.entries(meta).forEach(([k, v]) => {
      const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd);
    });
    $('.info-text').textContent = text || '';
    if (window.matchMedia('(max-width: 1180px)').matches) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function showInfo(id) {
    const c = C[id]; if (!c) return;
    Object.values(chipEls).forEach((g) => g.classList.remove('selected'));
    chipEls[id].classList.add('selected');
    const meta = {};
    if (c.nsLabel) meta.Namespace = c.nsLabel;
    meta.Runs = c.node ? NODE_NAME[c.node] : ((c.info && c.info.where) || '—');
    if (c.info && c.info.addr) meta.Address = c.info.addr;
    if (c.nsLabel && NS_TEAM[c.nsLabel]) meta.Team = TEAMS[NS_TEAM[c.nsLabel]].name;
    if (c.app) meta['Argo CD app'] = c.app;
    if (c.vol) meta.Volume = c.vol;
    const sec = [c.exposure ? (c.exposure === 'public' ? 'public' : c.exposure === 'tailnet' ? 'tailnet only' : 'internal') : null, c.netpol ? 'default-deny policies' : null, c.vault ? 'secrets from Vault' : null].filter(Boolean);
    if (sec.length) meta.Security = sec.join(' · ');
    meta.Layers = defaultLayers(c).map((l) => LAYERS[l].name).join(', ');
    fillInfo((c.info && c.info.kind) || c.kind, (c.label || id).replace(/^[⏱⇧] /, ''), meta, c.info && c.info.text);
  }

  function showNodeInfo(id) {
    const n = NODES.find((x) => x.id === id);
    const pods = Object.values(C).filter((c) => c.node === id && (c.kind === 'pod' || c.kind === 'job')).length;
    const extra = {
      vps: 'Control plane: API, scheduler, datastore. Runs the public edge, the apps, Postgres, Vault, Argo CD and the Tailscale proxies.',
      adm: 'Friend’s server, joined with Ansible over the tailnet. Runs the observability stack, Headlamp and this site.',
      lap: 'Old Windows laptop in WSL2. Runs RustFS, the target of every backup, off the VPS.'
    }[id];
    fillInfo('Node', n.title, { Machine: n.sub[0], Network: n.sub[1], 'Pods shown': String(pods) }, extra);
  }

  function showLayerInfo(key) {
    const L = LAYERS[key];
    Object.values(chipEls).forEach((g) => g.classList.remove('selected'));
    fillInfo('Network layer', L.name, L.meta || {}, L.desc);
  }

  // ------------------------------------------------------------------ player
  const scenario = () => SCENARIOS.find((s) => s.id === state.scenario);

  function renderStepList() {
    const list = $('.step-list'); list.textContent = '';
    const sc = scenario();
    list.style.setProperty('--sc', cssVar(sc.color));
    sc.steps.forEach((s, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button'); b.type = 'button';
      const n = document.createElement('span'); n.className = 'n'; n.textContent = String(i + 1).padStart(2, '0');
      const t = document.createElement('span'); t.textContent = s.title;
      b.append(n, t); b.addEventListener('click', () => { stop(); goTo(i, true); });
      li.appendChild(b); list.appendChild(li);
    });
  }

  function markList() {
    document.querySelectorAll('.step-list li').forEach((li, i) => {
      li.classList.toggle('current', i === state.step);
      li.classList.toggle('done', i < state.step);
    });
  }

  function describe(step, i) {
    const sc = scenario();
    $('.step-card').style.setProperty('--step-c', colorOf(step.layer));
    $('.step-num').textContent = 'Step ' + (i + 1) + ' / ' + sc.steps.length + ' · ' + (LAYERS[step.layer] ? LAYERS[step.layer].name : step.layer);
    $('.step-title').textContent = step.title;
    $('.step-text').textContent = step.text;
    const np = $('.netpol-tag');
    if (step.netpol) { np.hidden = false; np.textContent = '⛨ NetworkPolicy · ' + step.netpol; np.classList.add('ok'); } else np.hidden = true;
    setStack(step.stack);
    markList();
  }

  function clearAnim() {
    gAnim.textContent = '';
    Object.values(chipEls).forEach((g) => g.classList.remove('active'));
    Object.values(nodeEls).forEach((r) => r.classList.remove('node-active'));
  }

  /** Light up the nodes and pods a step touches */
  function activate(step) {
    const ids = hops(step).filter((id) => !id.startsWith('bus@'));
    ids.forEach((id) => {
      const c = C[id]; if (!c) return;
      if (chipEls[id] && (id === step.from || id === step.to || c.kind === 'svc')) chipEls[id].classList.add('active');
      if (c.node && nodeEls[c.node]) nodeEls[c.node].classList.add('node-active');
      if (c.kind === 'svc' && C[c.target] && C[c.target].node) nodeEls[C[c.target].node].classList.add('node-active');
    });
  }

  function goTo(i, animate) {
    const sc = scenario();
    if (i < 0 || i >= sc.steps.length) return;
    cancelAnimationFrame(state.raf); clearTimeout(state.timer);
    state.step = i;
    const step = sc.steps[i];
    describe(step, i);
    clearAnim();
    for (let k = 0; k < i; k++) drawTrail(sc.steps[k], 0.2);
    activate(step);
    if (animate) animateStep(step); else drawTrail(step, 1, true);
  }

  function points(step) {
    const pts = []; hops(step).forEach((id) => pts.push(anchor(id, pts[pts.length - 1])));
    return pts;
  }

  function drawTrail(step, opacity, withPacket) {
    const pts = points(step);
    const color = colorOf(step.layer);
    if (step.from === step.to) {
      el('circle', { cx: pts[0].x, cy: pts[0].y, r: 26, fill: 'none', stroke: color, 'stroke-width': 2.5, opacity }, gAnim);
      return;
    }
    const path = el('path', { d: 'M' + pts.map((p) => p.x + ' ' + p.y).join(' L'), class: 'trail', stroke: color, opacity }, gAnim);
    if (step.blocked) path.setAttribute('stroke-dasharray', '6 6');
    if (withPacket) {
      const len = path.getTotalLength();
      packetAt(path.getPointAtLength(step.blocked ? len * 0.62 : len), step, color, step.blocked);
    }
  }

  function packetAt(p, step, color, blocked) {
    const g = el('g', null, gAnim);
    if (blocked) {
      el('circle', { cx: p.x, cy: p.y, r: 13, fill: colorOf('netpol') }, g);
      el('text', { x: p.x, y: p.y + 5, 'text-anchor': 'middle', style: 'font:700 15px var(--sans);fill:#fff' }, g).textContent = '✕';
      return g;
    }
    el('circle', { cx: p.x, cy: p.y, r: 11, fill: color, opacity: 0.25 }, g);
    el('circle', { cx: p.x, cy: p.y, r: 6.5, fill: color, stroke: '#fff', 'stroke-width': 1.6 }, g);
    if (step.tag) {
      const w = 8 + step.tag.length * 6.4;
      el('rect', { x: p.x + 12, y: p.y - 22, width: w, height: 16, rx: 5, fill: cssVar('--surface'), stroke: color }, g);
      el('text', { x: p.x + 12 + w / 2, y: p.y - 10.5, 'text-anchor': 'middle', class: 'packet-label', fill: color }, g).textContent = step.tag;
    }
    return g;
  }

  /** Ring that expands from a pod when the packet reaches it */
  function pulse(id, color) {
    const p = anchor(id);
    const ring = el('circle', { cx: p.x, cy: p.y, r: 12, fill: 'none', stroke: color, 'stroke-width': 2.5 }, gAnim);
    const t0 = performance.now();
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / 700);
      ring.setAttribute('r', 12 + 30 * k); ring.setAttribute('opacity', String(1 - k));
      if (k < 1) requestAnimationFrame(tick); else ring.remove();
    };
    requestAnimationFrame(tick);
  }

  function animateStep(step) {
    const color = colorOf(step.layer);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (step.from === step.to) {
      const p = anchor(step.from);
      const ring = el('circle', { cx: p.x, cy: p.y, r: 10, fill: 'none', stroke: color, 'stroke-width': 3 }, gAnim);
      const t0 = performance.now(); const dur = (reduce ? 300 : 1400) / state.speed;
      const tick = (t) => {
        const k = Math.min(1, (t - t0) / dur);
        ring.setAttribute('r', 10 + 26 * k); ring.setAttribute('opacity', String(1 - 0.6 * k));
        if (k < 1) state.raf = requestAnimationFrame(tick); else finish();
      };
      state.raf = requestAnimationFrame(tick);
      return;
    }
    const pts = points(step);
    const path = el('path', { d: 'M' + pts.map((p) => p.x + ' ' + p.y).join(' L'), class: 'trail', stroke: color }, gAnim);
    const len = path.getTotalLength();
    const stopAt = step.blocked ? len * 0.62 : len;
    path.setAttribute('stroke-dasharray', len); path.setAttribute('stroke-dashoffset', len);
    const dur = (reduce ? 200 : Math.min(3600, Math.max(1000, len * 2.1))) / state.speed;
    let pkt = null; const t0 = performance.now();
    pulse(step.from, color);
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const at = stopAt * e;
      path.setAttribute('stroke-dashoffset', len - at);
      if (pkt) pkt.remove();
      pkt = packetAt(path.getPointAtLength(at), step, color, step.blocked && k === 1);
      if (k < 1) state.raf = requestAnimationFrame(tick);
      else { if (!step.blocked) pulse(step.to, color); finish(); }
    };
    state.raf = requestAnimationFrame(tick);
  }

  function finish() {
    if (!state.playing) return;
    const sc = scenario();
    if (state.step < sc.steps.length - 1) state.timer = setTimeout(() => goTo(state.step + 1, true), 1500 / state.speed);
    else { stop(); $('[data-act="play"]').textContent = '↻ Replay'; }
  }

  function play() {
    const sc = scenario();
    state.playing = true; $('[data-act="play"]').textContent = '❚❚ Pause';
    if (state.step < 0 || state.step >= sc.steps.length - 1) goTo(0, true); else goTo(state.step + 1, true);
  }
  function stop() {
    state.playing = false; clearTimeout(state.timer);
    const b = $('[data-act="play"]'); if (b) b.textContent = '▶ Play';
  }

  function selectScenario(id, autoplay) {
    stop(); state.scenario = id; state.step = -1;
    document.querySelectorAll('.scenario-bar button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.id === id)));
    renderStepList(); clearAnim();
    const sc = scenario();
    $('.step-card').style.setProperty('--step-c', cssVar(sc.color));
    $('.step-num').textContent = 'Scenario · ' + sc.steps.length + ' steps';
    $('.step-title').textContent = sc.name;
    $('.step-text').textContent = 'Press Play, or click a step. Space = play / pause, ← → = previous / next.';
    $('.netpol-tag').hidden = true; setStack([]);
    if (autoplay) play();
  }

  // ------------------------------------------------------------------ UI wiring
  function buildBars() {
    const vb = $('.view-bar');
    Object.entries(VIEWS).forEach(([key, v]) => {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.view = key;
      b.setAttribute('aria-pressed', String(key === state.view));
      const i = document.createElement('span'); i.className = 'vi'; i.textContent = v.icon;
      b.append(i, document.createTextNode(v.name));
      b.addEventListener('click', () => {
        state.view = key;
        vb.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.view === key)));
        applyView();
      });
      vb.appendChild(b);
    });

    const sb = $('.scenario-bar');
    SCENARIOS.forEach((s) => {
      const b = document.createElement('button'); b.type = 'button'; b.role = 'tab'; b.dataset.id = s.id;
      b.style.setProperty('--c', cssVar(s.color));
      const dot = document.createElement('span'); dot.className = 'dot';
      b.append(dot, document.createTextNode(s.name));
      b.addEventListener('click', () => selectScenario(s.id, true));
      sb.appendChild(b);
    });

    const lc = $('.layer-chips');
    const all = document.createElement('button'); all.type = 'button'; all.textContent = 'All'; all.classList.add('on');
    all.style.setProperty('--c', cssVar('--accent'));
    all.addEventListener('click', () => { state.focus.clear(); syncLayerChips(); applyFocus(); $('.info-card').hidden = true; });
    lc.appendChild(all);
    Object.entries(LAYERS).filter(([, L]) => L.focus !== false).forEach(([key, L]) => {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.layer = key;
      b.style.setProperty('--c', cssVar(L.color));
      const i = document.createElement('i'); b.append(i, document.createTextNode(L.name));
      b.addEventListener('click', () => {
        if (state.focus.has(key)) state.focus.delete(key); else { state.focus.add(key); showLayerInfo(key); }
        syncLayerChips(); applyFocus();
      });
      lc.appendChild(b);
    });
  }

  function buildLegend(entries) {
    const lg = $('.legend'); lg.textContent = '';
    entries.forEach(({ color, text }) => {
      const s = document.createElement('span');
      const icon = document.createElementNS(SVGNS, 'svg'); icon.setAttribute('width', '22'); icon.setAttribute('height', '14');
      el('rect', { x: 1, y: 1, width: 20, height: 12, rx: 4, fill: color, 'fill-opacity': 0.18, stroke: color, 'stroke-width': 1.5 }, icon);
      s.append(icon, document.createTextNode(text)); lg.appendChild(s);
    });
  }

  function syncLayerChips() {
    document.querySelectorAll('.layer-chips button').forEach((b) => {
      b.classList.toggle('on', b.dataset.layer ? state.focus.has(b.dataset.layer) : state.focus.size === 0);
    });
  }

  function wire() {
    document.querySelector('.player').addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      const act = btn.dataset.act; const sc = scenario();
      if (act === 'play') { if (state.playing) stop(); else play(); }
      if (act === 'next') { stop(); goTo(Math.min(state.step + 1, sc.steps.length - 1), true); }
      if (act === 'prev') { stop(); goTo(Math.max(state.step - 1, 0), true); }
      if (act === 'reset') selectScenario(state.scenario, false);
    });
    document.querySelector('.speed input').addEventListener('input', (e) => { state.speed = parseFloat(e.target.value); });
    let zoom = 1;
    document.querySelector('.zoom').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      zoom = Math.min(2.2, Math.max(1, zoom + 0.3 * parseInt(b.dataset.zoom, 10)));
      svg.style.width = (zoom * 100) + '%'; svg.style.minWidth = (900 * zoom) + 'px';
      document.querySelector('.zoom-val').textContent = Math.round(zoom * 100) + '%';
    });
    document.addEventListener('keydown', (e) => {
      if (document.getElementById('view-schema').hidden) return;
      if (e.target.closest('input, textarea, [contenteditable]')) return;
      const sc = scenario();
      if (e.code === 'Space' && !e.target.closest('button, [role="button"]')) { e.preventDefault(); if (state.playing) stop(); else play(); }
      if (e.key === 'ArrowRight') { stop(); goTo(Math.min(state.step + 1, sc.steps.length - 1), true); }
      if (e.key === 'ArrowLeft') { stop(); goTo(Math.max(state.step - 1, 0), true); }
    });
  }

  function init() {
    svg = document.getElementById('schema');
    state = { scenario: SCENARIOS[0].id, step: -1, playing: false, speed: 1, focus: new Set(), view: 'placement', raf: 0, timer: 0 };
    layout(); buildBars(); render(); wire();
    selectScenario(SCENARIOS[0].id, false);
  }

  function rerender() {
    if (!svg) return;
    const keep = { scenario: state.scenario, step: state.step };
    stop(); render();
    document.querySelectorAll('.scenario-bar button').forEach((b) => b.style.setProperty('--c', cssVar(SCENARIOS.find((s) => s.id === b.dataset.id).color)));
    document.querySelectorAll('.layer-chips button[data-layer]').forEach((b) => b.style.setProperty('--c', cssVar(LAYERS[b.dataset.layer].color)));
    state.scenario = keep.scenario;
    if (keep.step >= 0) goTo(keep.step, false);
  }

  window.Schema = { init, rerender };
})();
