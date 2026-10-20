resource "null_resource" "install_k3s" {
  triggers = {
    k3s_version = var.k3s_version
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    command     = "bash ${path.module}/scripts/install_k3s.sh"
    environment = {
      K3S_VERSION = var.k3s_version
    }
  }

  # Runs on `terraform destroy`: backs up Postgres and stops k3s, keeping all
  # cluster data on disk. The next `terraform apply` starts it again.
  provisioner "local-exec" {
    when        = destroy
    interpreter = ["/bin/bash", "-c"]
    command     = "bash ${path.module}/scripts/stop_k3s.sh"
  }
}

output "kubeconfig_path" {
  value       = "/etc/rancher/k3s/k3s.yaml"
  description = "Path to the k3s kubeconfig used by kubectl."
}

output "verify_commands" {
  value = [
    "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml",
    "kubectl get nodes",
    "kubectl get pods -A -l environment=${var.environment}",
    "kubectl get svc -A -l environment=${var.environment}"
  ]
  description = "Useful commands to verify the cluster."
}
