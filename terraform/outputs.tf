output "a_records" {
  description = "A records managed here (name -> proxied through Cloudflare)."
  value       = { for k, r in cloudflare_dns_record.a : r.name => r.proxied }
}
