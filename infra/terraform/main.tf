# LegacyAI - Phase 1 infrastructure skeleton for Google Cloud.
#
# COST GUARDRAILS built in here:
#   - Cloud Run: min instances 0 (nothing runs when idle), a hard max-instances cap,
#     CPU only allocated while a request is being handled.
#   - Artifact Registry: old images deleted automatically (0.5 GB free).
#   - Buckets: us-central1, Standard class, automatic deletion of old backups (5 GB free).
#   - Secrets: exactly 6 (the free allowance is 6 active versions).
#   - Scheduler: 2 jobs (3 are free per billing account).
#   - A budget alert. An alert is an email - it does NOT stop spending.

locals {
  services = [
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "cloudscheduler.googleapis.com",
    "billingbudgets.googleapis.com",
    "monitoring.googleapis.com",
  ]

  # Names only. Terraform never sees a secret VALUE: you add values by hand.
  secrets = {
    database-url           = "Connection string for the app role (legacyai_app). No superuser, no BYPASSRLS."
    database-url-admin     = "Connection string for migrations and backups. NOT mounted into the API."
    sc-pepper-keyring      = "JSON keyring: pepper for the 3-digit secret code."
    credential-enc-keyring = "JSON keyring: encrypts authenticator-app seeds."
    hmac-index-key         = "Key for one-way fingerprints of IPs and card numbers."
    internal-service-token = "Shared secret for service-to-service calls."
  }

  # The API may read these five. It must never see the admin connection string.
  api_secrets = ["database-url", "sc-pepper-keyring", "credential-enc-keyring", "hmac-index-key", "internal-service-token"]

  registry = "${var.primary_region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.containers.repository_id}"

  service_regions = var.deploy_services ? var.regions : {}
}

resource "google_project_service" "enabled" {
  for_each           = toset(local.services)
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# ------------------------------------------------------------------ container images

resource "google_artifact_registry_repository" "containers" {
  project       = var.project_id
  location      = var.primary_region
  repository_id = "legacyai"
  format        = "DOCKER"
  description   = "LegacyAI container images"

  # Keep the two newest versions of each image; delete the rest. Keeps storage under the 0.5 GB free allowance.
  cleanup_policy_dry_run = false

  cleanup_policies {
    id     = "keep-two-newest"
    action = "KEEP"
    most_recent_versions {
      keep_count = 2
    }
  }

  cleanup_policies {
    id     = "delete-everything-else"
    action = "DELETE"
    condition {
      older_than = "86400s"
    }
  }

  depends_on = [google_project_service.enabled]
}

# ------------------------------------------------------------------ service accounts (least privilege)

resource "google_service_account" "api" {
  project      = var.project_id
  account_id   = "legacyai-api"
  display_name = "LegacyAI API runtime"
}

resource "google_service_account" "ai" {
  project      = var.project_id
  account_id   = "legacyai-ai"
  display_name = "LegacyAI AI service runtime"
}

resource "google_service_account" "backup" {
  project      = var.project_id
  account_id   = "legacyai-backup"
  display_name = "LegacyAI backup job"
}

resource "google_service_account" "anchor" {
  project      = var.project_id
  account_id   = "legacyai-anchor"
  display_name = "LegacyAI audit-anchor job"
}

resource "google_service_account" "scheduler" {
  project      = var.project_id
  account_id   = "legacyai-scheduler"
  display_name = "LegacyAI scheduler (starts the two jobs)"
}

# ------------------------------------------------------------------ secrets (names only)

resource "google_secret_manager_secret" "secret" {
  for_each  = local.secrets
  project   = var.project_id
  secret_id = "legacyai-${each.key}"

  labels = {
    app = "legacyai"
  }

  annotations = {
    purpose = each.value
  }

  replication {
    auto {}
  }

  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_iam_member" "api_reads" {
  for_each  = toset(local.api_secrets)
  project   = var.project_id
  secret_id = google_secret_manager_secret.secret[each.value].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

resource "google_secret_manager_secret_iam_member" "backup_reads_admin_url" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.secret["database-url-admin"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.backup.email}"
}

# The anchor job connects exactly like the API (app role, row-level security on).
resource "google_secret_manager_secret_iam_member" "anchor_reads" {
  for_each  = toset(local.api_secrets)
  project   = var.project_id
  secret_id = google_secret_manager_secret.secret[each.value].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.anchor.email}"
}

# ------------------------------------------------------------------ buckets

resource "google_storage_bucket" "backups" {
  project                     = var.project_id
  name                        = "${var.project_id}-legacyai-backups"
  location                    = var.primary_region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  # A fresh backup cannot be deleted or overwritten by anyone for this long.
  retention_policy {
    retention_period = var.backup_retention_days * 86400
    is_locked        = false
  }

  # Old backups are removed automatically so storage stays inside the free allowance.
  lifecycle_rule {
    condition {
      age = var.backup_delete_after_days
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.enabled]
}

resource "google_storage_bucket" "audit_anchors" {
  project                     = var.project_id
  name                        = "${var.project_id}-legacyai-audit-anchors"
  location                    = var.primary_region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  # "Write-once-style": objects cannot be changed or deleted until the period ends.
  # It only becomes true write-once when is_locked is true - which is PERMANENT.
  retention_policy {
    retention_period = var.audit_anchor_retention_days * 86400
    is_locked        = var.lock_audit_anchor_retention
  }

  depends_on = [google_project_service.enabled]
}

# objectCreator = may add new objects; may NOT read, overwrite or delete existing ones.
resource "google_storage_bucket_iam_member" "backup_writes" {
  bucket = google_storage_bucket.backups.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.backup.email}"
}

resource "google_storage_bucket_iam_member" "anchor_writes" {
  bucket = google_storage_bucket.audit_anchors.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.anchor.email}"
}

# ------------------------------------------------------------------ Cloud Run services
# Created only when var.deploy_services = true.

resource "google_cloud_run_v2_service" "api" {
  for_each            = local.service_regions
  project             = var.project_id
  name                = "legacyai-api-${each.key}"
  location            = each.value
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = true

  template {
    service_account                  = google_service_account.api.email
    timeout                          = "30s"
    max_instance_request_concurrency = 40

    scaling {
      min_instance_count = 0
      max_instance_count = var.api_max_instances
    }

    containers {
      image = "${local.registry}/api:${var.api_image_tag}"

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true # request-based billing: CPU is only allocated while handling a request
        startup_cpu_boost = false
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "TRUST_PROXY"
        value = "true"
      }
      env {
        name  = "VALIDATE_RESPONSES"
        value = "false"
      }
      env {
        name  = "ALLOWED_ORIGINS"
        value = var.allowed_origins
      }
      env {
        name  = "WEBAUTHN_RP_ID"
        value = var.webauthn_rp_id
      }
      env {
        name  = "EXPORT_DIR"
        value = "/tmp/exports"
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["database-url"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "SC_PEPPER_KEYRING"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["sc-pepper-keyring"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "CREDENTIAL_ENC_KEYRING"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["credential-enc-keyring"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "HMAC_INDEX_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["hmac-index-key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "INTERNAL_SERVICE_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["internal-service-token"].secret_id
            version = "latest"
          }
        }
      }

      # Liveness never touches the database, so health checks cannot wake Neon and burn free compute.
      startup_probe {
        initial_delay_seconds = 0
        timeout_seconds       = 3
        period_seconds        = 5
        failure_threshold     = 6
        http_get {
          path = "/v1/health"
        }
      }
    }
  }

  depends_on = [google_secret_manager_secret_iam_member.api_reads]
}

# Browsers must be able to reach the API, so invocation is public. Every request is still
# authenticated and authorised by the API itself.
resource "google_cloud_run_v2_service_iam_member" "api_public" {
  for_each = google_cloud_run_v2_service.api
  project  = var.project_id
  location = each.value.location
  name     = each.value.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service" "ai" {
  for_each            = local.service_regions
  project             = var.project_id
  name                = "legacyai-ai-${each.key}"
  location            = each.value
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  deletion_protection = true

  template {
    service_account                  = google_service_account.ai.email
    timeout                          = "30s"
    max_instance_request_concurrency = 20

    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    containers {
      image = "${local.registry}/ai:${var.ai_image_tag}"

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = false
      }
    }
  }
}

# Only the API may call the AI service.
resource "google_cloud_run_v2_service_iam_member" "ai_invoked_by_api" {
  for_each = google_cloud_run_v2_service.ai
  project  = var.project_id
  location = each.value.location
  name     = each.value.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.api.email}"
}

# ------------------------------------------------------------------ scheduled jobs (backup, audit anchor)

resource "google_cloud_run_v2_job" "backup" {
  count               = var.deploy_services ? 1 : 0
  project             = var.project_id
  name                = "legacyai-backup"
  location            = var.primary_region
  deletion_protection = true

  template {
    task_count = 1
    template {
      service_account = google_service_account.backup.email
      timeout         = "600s"
      max_retries     = 1

      containers {
        image   = "${local.registry}/backup-tools:${var.tools_image_tag}"
        command = ["backup.sh"]

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        env {
          name  = "BACKUP_DEST"
          value = "gs://${google_storage_bucket.backups.name}/backups"
        }
        env {
          name  = "BACKUP_AGE_RECIPIENT"
          value = var.backup_age_recipient
        }
        env {
          name = "DATABASE_URL_BACKUP"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secret["database-url-admin"].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    precondition {
      condition     = var.backup_age_recipient != ""
      error_message = "Set backup_age_recipient (an age PUBLIC key) before deploying the backup job. See infra/README.md."
    }
  }
}

resource "google_cloud_run_v2_job" "anchor" {
  count               = var.deploy_services ? 1 : 0
  project             = var.project_id
  name                = "legacyai-audit-anchor"
  location            = var.primary_region
  deletion_protection = true

  template {
    task_count = 1
    template {
      service_account = google_service_account.anchor.email
      timeout         = "600s"
      max_retries     = 1

      containers {
        image   = "${local.registry}/api:${var.api_image_tag}"
        command = ["node"]
        args    = ["dist/cli/anchor-audit-head.js", "--gcs-bucket", google_storage_bucket.audit_anchors.name]

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        env {
          name  = "NODE_ENV"
          value = "production"
        }
        env {
          name  = "ALLOWED_ORIGINS"
          value = var.allowed_origins
        }
        env {
          name  = "WEBAUTHN_RP_ID"
          value = var.webauthn_rp_id
        }

        dynamic "env" {
          for_each = {
            DATABASE_URL           = "database-url"
            SC_PEPPER_KEYRING      = "sc-pepper-keyring"
            CREDENTIAL_ENC_KEYRING = "credential-enc-keyring"
            HMAC_INDEX_KEY         = "hmac-index-key"
            INTERNAL_SERVICE_TOKEN = "internal-service-token"
          }
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.secret[env.value].secret_id
                version = "latest"
              }
            }
          }
        }
      }
    }
  }
}

resource "google_project_iam_member" "scheduler_runs_jobs" {
  count   = var.deploy_services ? 1 : 0
  project = var.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.scheduler.email}"
}

resource "google_cloud_scheduler_job" "nightly_backup" {
  count       = var.deploy_services ? 1 : 0
  project     = var.project_id
  region      = var.primary_region
  name        = "legacyai-nightly-backup"
  description = "Runs the encrypted backup once a night. One short run: it wakes the database once."
  schedule    = "15 3 * * *"
  time_zone   = "Etc/UTC"

  retry_config {
    retry_count = 1
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.primary_region}/jobs/${google_cloud_run_v2_job.backup[0].name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }
}

resource "google_cloud_scheduler_job" "daily_anchor" {
  count       = var.deploy_services ? 1 : 0
  project     = var.project_id
  region      = var.primary_region
  name        = "legacyai-daily-audit-anchor"
  description = "Copies audit chain heads to the anchor bucket once a day."
  schedule    = "45 3 * * *"
  time_zone   = "Etc/UTC"

  retry_config {
    retry_count = 1
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.primary_region}/jobs/${google_cloud_run_v2_job.anchor[0].name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }
}

# ------------------------------------------------------------------ budget alert

resource "google_monitoring_notification_channel" "budget_email" {
  project      = var.project_id
  display_name = "LegacyAI budget alerts"
  type         = "email"

  labels = {
    email_address = var.alert_email
  }

  depends_on = [google_project_service.enabled]
}

# An alert is an EMAIL. It does not stop spending. The max-instances caps above do the limiting.
resource "google_billing_budget" "monthly" {
  billing_account = var.billing_account_id
  display_name    = "LegacyAI monthly budget"

  budget_filter {
    projects = ["projects/${var.project_id}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.monthly_budget_usd)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 0.9
  }
  threshold_rules {
    threshold_percent = 1.0
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }

  all_updates_rule {
    monitoring_notification_channels = [google_monitoring_notification_channel.budget_email.id]
    disable_default_iam_recipients   = false
  }

  depends_on = [google_project_service.enabled]
}

# ------------------------------------------------------------------ CI deploy identity (off by default)

resource "google_iam_workload_identity_pool" "github" {
  count                     = var.enable_ci_deploy ? 1 : 0
  project                   = var.project_id
  workload_identity_pool_id = "legacyai-github"
  display_name              = "GitHub Actions"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  count                              = var.enable_ci_deploy ? 1 : 0
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github[0].workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  # Only this repository, only its main branch.
  attribute_condition = "assertion.repository == \"${var.github_repository}\" && assertion.ref == \"refs/heads/main\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  lifecycle {
    precondition {
      condition     = can(regex("^[^/\\s]+/[^/\\s]+$", var.github_repository))
      error_message = "Set github_repository to owner/repo before enabling CI deploy."
    }
  }
}

resource "google_service_account" "ci_deployer" {
  count        = var.enable_ci_deploy ? 1 : 0
  project      = var.project_id
  account_id   = "legacyai-ci-deployer"
  display_name = "LegacyAI CI deployer"
}

resource "google_service_account_iam_member" "ci_deployer_from_github" {
  count              = var.enable_ci_deploy ? 1 : 0
  service_account_id = google_service_account.ci_deployer[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github[0].name}/attribute.repository/${var.github_repository}"
}

resource "google_artifact_registry_repository_iam_member" "ci_pushes_images" {
  count      = var.enable_ci_deploy ? 1 : 0
  project    = var.project_id
  location   = var.primary_region
  repository = google_artifact_registry_repository.containers.repository_id
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.ci_deployer[0].email}"
}
