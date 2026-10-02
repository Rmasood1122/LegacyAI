variable "project_id" {
  description = "Google Cloud project id (you create the project by hand)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a valid Google Cloud project id."
  }
}

variable "billing_account_id" {
  description = "Billing account id, like 000000-AAAAAA-BBBBBB. Used only for the budget alert."
  type        = string

  validation {
    condition     = can(regex("^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$", var.billing_account_id))
    error_message = "billing_account_id must look like 000000-AAAAAA-BBBBBB."
  }
}

variable "alert_email" {
  description = "Where budget alerts are sent."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email must be an email address."
  }
}

variable "primary_region" {
  description = "Region for shared resources. us-central1 is one of the three regions with the Cloud Storage free allowance."
  type        = string
  default     = "us-central1"
}

variable "regions" {
  description = <<-EOT
    Regions to deploy the services into, keyed by a short name. Today: US only.
    To add Europe later, add  eu = "europe-west1"  - a parallel stack is created.
    NOTE: only us-central1, us-east1 and us-west1 have the Cloud Storage free allowance.
    An EU region is NOT free.
  EOT
  type        = map(string)
  default     = { us = "us-central1" }

  validation {
    condition     = length(var.regions) >= 1 && contains(keys(var.regions), "us")
    error_message = "regions must contain at least the key \"us\"."
  }
}

variable "deploy_services" {
  description = <<-EOT
    false (default): create only the registry, secrets, buckets, service accounts and budget.
    true: also create the Cloud Run services and jobs. Switch this on only AFTER the container
    images are pushed and every secret has a value - Cloud Run cannot start without them.
  EOT
  type        = bool
  default     = false
}

variable "api_image_tag" {
  description = "Tag of the API image in Artifact Registry."
  type        = string
  default     = "latest"
}

variable "ai_image_tag" {
  description = "Tag of the AI service image in Artifact Registry."
  type        = string
  default     = "latest"
}

variable "tools_image_tag" {
  description = "Tag of the backup tools image in Artifact Registry."
  type        = string
  default     = "latest"
}

variable "api_max_instances" {
  description = "Hard cap on API instances. This cap is what bounds the worst-case bill."
  type        = number
  default     = 2

  validation {
    condition     = var.api_max_instances >= 1 && var.api_max_instances <= 3 && floor(var.api_max_instances) == var.api_max_instances
    error_message = "api_max_instances must be 1, 2 or 3. Raising it further is a spending decision: change this validation deliberately."
  }
}

variable "allowed_origins" {
  description = "Exact https origins of the web app that may call the API (comma-separated). No wildcards."
  type        = string
  default     = "https://app.example.invalid"
}

variable "webauthn_rp_id" {
  description = "Passkey relying-party id: the web app's host name, without scheme or port."
  type        = string
  default     = "app.example.invalid"
}

variable "backup_age_recipient" {
  description = "age PUBLIC key (age1...) that backups are encrypted to. The private key stays offline with the founder."
  type        = string
  default     = ""

  validation {
    condition     = var.backup_age_recipient == "" || can(regex("^age1[0-9a-z]{50,70}$", var.backup_age_recipient))
    error_message = "backup_age_recipient must be an age PUBLIC key (starts with age1). Never put a private key here."
  }
}

variable "monthly_budget_usd" {
  description = "Budget for the alert. Alerts are emails only: they do NOT stop spending."
  type        = number
  default     = 1
}

variable "backup_retention_days" {
  description = "Backups cannot be deleted or overwritten for this many days."
  type        = number
  default     = 7
}

variable "backup_delete_after_days" {
  description = "Backups are deleted automatically after this many days (keeps storage inside the 5 GB free allowance)."
  type        = number
  default     = 30
}

variable "audit_anchor_retention_days" {
  description = "Audit anchors cannot be deleted or overwritten for this many days."
  type        = number
  default     = 400
}

variable "lock_audit_anchor_retention" {
  description = <<-EOT
    DANGER - IRREVERSIBLE. true locks the audit-anchor bucket's retention policy permanently:
    nobody, including you and Google support, can ever shorten or remove it.
    Leave false during the pilot (see docs/phase1/08-open-decisions.md, decision 6).
  EOT
  type        = bool
  default     = false
}

variable "enable_ci_deploy" {
  description = "Create the Workload Identity Federation pool that lets a GitHub Actions deploy workflow log in. Off until you want CI deployments."
  type        = bool
  default     = false
}

variable "github_repository" {
  description = "owner/repo allowed to deploy, e.g. my-org/legacyai. Only used when enable_ci_deploy is true."
  type        = string
  default     = ""
}
