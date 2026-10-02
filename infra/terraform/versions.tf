# PLAN-ONLY. Nothing in this folder has ever been applied by Claude.
# The founder runs `terraform plan` / `terraform apply` by hand (see infra/README.md).

terraform {
  required_version = ">= 1.16.0, < 2.0.0"

  required_providers {
    google = {
      source = "hashicorp/google"
      # 7.46.1 verified 2026-10-02. Provider 8.0 was released 2026-08-26 (under 60 days old),
      # so the previous major line is pinned. See docs/DEPENDENCIES.md.
      version = "~> 7.46"
    }
  }

  # State is kept in a local file by default (git-ignored). It holds resource names, not
  # secret values: secrets are created empty and filled in by hand.
  # When more than one person (or CI) applies, switch to a remote backend:
  #
  # backend "gcs" {
  #   bucket = "REPLACE-with-a-state-bucket-you-created-by-hand"
  #   prefix = "legacyai/phase1"
  # }
}

provider "google" {
  project               = var.project_id
  region                = var.primary_region
  billing_project       = var.project_id
  user_project_override = true
}
