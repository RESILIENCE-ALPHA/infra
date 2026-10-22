variable "environment" {
  description = "Target environment name (used as the `environment` label)."
  type        = string
  default     = "prod"
}

variable "k3s_version" {
  description = "Optional pinned k3s version (example: v1.31.6+k3s1). Leave empty for latest stable."
  type        = string
  default     = ""
}
