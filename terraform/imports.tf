# One-time adoption of the records that already exist in Cloudflare (created by hand).
# The first plan must show "20 to import, 0 to add, 0 to change, 0 to destroy".
# Delete this file in a follow-up PR once the import is applied (import blocks are one-shot).
locals {
  record_ids = {
    a = {
      "app"       = "fb6971141f3e52f38f0c43ce1c401186"
      "auth"      = "e5eb5b25617656711c1f60b8876014b0"
      "payment"   = "a1f0f5a247bcc16090aaeaf915611077"
      "pgadmin"   = "03730e97790803c299dfda58cff4dd65"
      "argocd"    = "60249f55d8f2a785edadaaf4a468303b"
      "grafana"   = "fdf62905bbf6881dc194a76ff88d43fb"
      "headlamp"  = "c328cfb21978e4db046188c54218e5b2"
      "jaeger"    = "34042aa177de50a9b82a2c89a13a34cc"
      "vault-ui"  = "48860332ad51d339499675f43b4630bd"
      "docs"      = "d5a50d8987fe76aad57d94f8aab38809"
      "@"         = "6f47fa0410bf2e4d30cd9a8571ca7ad8"
      "api"       = "065b3cb992d34930fea8d2598651b78d"
      "portainer" = "474623c050c1983bdc5045a8e78bfc33"
    }
    mx = {
      "eforward1" = "7a8efb73c9946517ff366ccc40143384"
      "eforward2" = "73c839f1bb1968f146358d15d4878af1"
      "eforward3" = "a1a2a1e27187da50b90255f3d72a69c7"
      "eforward4" = "829ba6c41c94b3e9c51bdc596e905056"
      "eforward5" = "90aaff63896e6a01289a5ce80cc21ab5"
    }
    txt = {
      "spf"              = "fb3d031b3bc3216ffdb0401198a049a1"
      "hcp-verification" = "08e5fb5b8e10ab9ef0a41d387a017774"
    }
  }
}

import {
  for_each = local.record_ids.a
  to       = cloudflare_dns_record.a[each.key]
  id       = "${local.zone_id}/${each.value}"
}

import {
  for_each = local.record_ids.mx
  to       = cloudflare_dns_record.mx[each.key]
  id       = "${local.zone_id}/${each.value}"
}

import {
  for_each = local.record_ids.txt
  to       = cloudflare_dns_record.txt[each.key]
  id       = "${local.zone_id}/${each.value}"
}
