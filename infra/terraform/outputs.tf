output "artifact_registry" {
  description = "Push images here: <this>/api:<tag>, <this>/ai:<tag>, <this>/backup-tools:<tag>"
  value       = local.registry
}

output "secret_names" {
  description = "Secrets to fill in by hand (Terraform creates them empty)."
  value       = [for s in google_secret_manager_secret.secret : s.secret_id]
}

output "backups_bucket" {
  value = google_storage_bucket.backups.name
}

output "audit_anchors_bucket" {
  value = google_storage_bucket.audit_anchors.name
}

output "api_urls" {
  description = "Empty until deploy_services = true."
  value       = { for k, s in google_cloud_run_v2_service.api : k => s.uri }
}

output "max_instances" {
  description = "The caps that bound the worst-case bill."
  value       = { api = var.api_max_instances, ai = 1 }
}
