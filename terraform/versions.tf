# DNS of karim-portfolio.xyz (Cloudflare), state in HCP Terraform.
# The VPS itself is a classic IONOS VPS (no Terraform provider): it is configured by Ansible.
terraform {
  required_version = ">= 1.7.0"

  cloud {
    organization = "resilience-alpha"

    workspaces {
      name = "infra-dns"
    }
  }

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.19"
    }
  }
}

# Authenticates with the CLOUDFLARE_API_TOKEN environment variable, set as a sensitive
# environment variable in the HCP Terraform workspace (never in Git).
# Token scope: zone karim-portfolio.xyz only, DNS Edit + DNS Read + Zone Read.
provider "cloudflare" {}
