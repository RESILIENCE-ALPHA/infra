locals {
  zone_id = "2a4877573f462d75fe023142692ed85f" # karim-portfolio.xyz
  domain  = "karim-portfolio.xyz"
  vps_ip  = "85.215.234.70" # IONOS VPS, k3s control plane, APISIX on ports 80/443

  # A records to the VPS. proxied = false: APISIX terminates TLS with Let's Encrypt certificates
  # (cert-manager, HTTP-01 challenge through the Gateway).
  a_records = {
    "app"      = { proxied = false }
    "auth"     = { proxied = false }
    "payment"  = { proxied = false }
    "pgadmin"  = { proxied = false }
    "argocd"   = { proxied = false }
    "grafana"  = { proxied = false }
    "headlamp" = { proxied = false }
    "jaeger"   = { proxied = false }
    "vault-ui" = { proxied = false }
    "docs"     = { proxied = false } # old docs site (kube-docs), to be rebuilt
    # Proxied through Cloudflare (orange cloud). Kept as they were; to review in a later PR.
    "@"         = { proxied = true }
    "api"       = { proxied = true }
    "portainer" = { proxied = true }
  }

  # Namecheap email forwarding (registrar-servers.com).
  mx_records = {
    "eforward1" = 10
    "eforward2" = 10
    "eforward3" = 10
    "eforward4" = 15
    "eforward5" = 20
  }

  txt_records = {
    "spf"              = "\"v=spf1 include:spf.efwd.registrar-servers.com ~all\""
    "hcp-verification" = "\"hcp-domain-verification=41611363e9b7cd5a26461cba87cc6a8601fdea6018ce1f020d06b670362086f6\""
  }
}

resource "cloudflare_dns_record" "a" {
  for_each = local.a_records

  zone_id = local.zone_id
  name    = each.key == "@" ? local.domain : "${each.key}.${local.domain}"
  type    = "A"
  content = local.vps_ip
  proxied = each.value.proxied
  ttl     = 1 # automatic
}

resource "cloudflare_dns_record" "mx" {
  for_each = local.mx_records

  zone_id  = local.zone_id
  name     = local.domain
  type     = "MX"
  content  = "${each.key}.registrar-servers.com"
  priority = each.value
  ttl      = 1
}

resource "cloudflare_dns_record" "txt" {
  for_each = local.txt_records

  zone_id = local.zone_id
  name    = local.domain
  type    = "TXT"
  content = each.value
  ttl     = 1
}
