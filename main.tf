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

# Namespaces + Postgres. Re-runs when the playbook, the Postgres template or the
# environment name changes. Needs ansible/inventory.ini (see inventory.ini.example).
resource "null_resource" "deploy_apps" {
  depends_on = [null_resource.install_k3s]

  triggers = {
    playbook    = filesha1("${path.module}/ansible/deploy-apps.yml")
    postgres    = filesha1("${path.module}/kubernetes/applications/postgres.yaml")
    environment = var.environment
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    working_dir = path.module
    command     = "ansible-playbook -i ansible/inventory.ini ansible/deploy-apps.yml -e env_name=${var.environment}"
  }
}

# Helm releases, Ollama, EPSI Pay, certificates, routes. The script is idempotent
# (helm upgrade --install / kubectl apply); it re-runs when it or any manifest changes.
resource "null_resource" "deploy_infra" {
  depends_on = [null_resource.deploy_apps]

  triggers = {
    script = filesha1("${path.module}/scripts/deploy_infra.sh")
    manifests = sha1(join("", [
      for f in sort(fileset(path.module, "kubernetes/**")) : filesha1("${path.module}/${f}")
    ]))
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    working_dir = path.module
    command     = "bash scripts/deploy_infra.sh"
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
