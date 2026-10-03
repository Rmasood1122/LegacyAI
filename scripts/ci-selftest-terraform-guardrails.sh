#!/usr/bin/env bash
# "Seen it fire" for the Terraform guardrail check: break each guardrail on a COPY of the
# code and make sure the check rejects it. Run from infra/terraform.
set -euo pipefail
check="$(cd "$(dirname "$0")" && pwd)/ci-terraform-guardrails.sh"
src="$(pwd)"
fired=0

try() { # $1 = description, $2 = file, $3 = sed expression that removes a guardrail
  d="$(mktemp -d)"
  cp "$src"/*.tf "$d"/
  sed -i "$3" "$d/$2"
  if cmp -s "$src/$2" "$d/$2"; then rm -rf "$d"; echo "guardrails-selftest: FAIL - the break for '$1' changed nothing" >&2; exit 1; fi
  if (cd "$d" && bash "$check" >/dev/null 2>&1); then rm -rf "$d"; echo "guardrails-selftest: FAIL - not detected: $1" >&2; exit 1; fi
  rm -rf "$d"
  fired=$((fired + 1))
  echo "guardrails-selftest: fired - $1"
}

try "a service that never scales to zero"       main.tf      '0,/min_instance_count = 0/s//min_instance_count = 1/'
try "AI service cap raised to 10"                main.tf      's/max_instance_count = 1$/max_instance_count = 10/'
try "always-allocated CPU"                       main.tf      '0,/cpu_idle          = true/s//cpu_idle          = false/'
try "a bucket that allows public access"         main.tf      '0,/public_access_prevention    = "enforced"/s//public_access_prevention    = "inherited"/'
try "AI service opened to everyone"            main.tf      '/^resource "google_cloud_run_v2_service_iam_member" "ai_invoked_by_api"/,/^}/s/member   = "serviceAccount:${google_service_account.api.email}"/member   = "allUsers"/'
try "another account allowed to call the AI"     main.tf      '$a resource "google_cloud_run_v2_service_iam_member" "ai_extra" {\n  member = "serviceAccount:someone@example.iam.gserviceaccount.com"\n}'
try "AI service memory raised to 4Gi"            main.tf      's/memory = "1Gi"/memory = "4Gi"/'
try "a real AI provider by default"              variables.tf '/^variable "ai_provider"/,/^}/s/default     = "fake"/default     = "anthropic"/'
try "a sixth secret"                             main.tf      's/^    api-keyrings       = /    extra-secret       = "one too many"\n    api-keyrings       = /'
try "budget alert removed"                       main.tf      's/^resource "google_billing_budget" "monthly"/resource "google_billing_budget_removed" "monthly"/'
try "services deployed by default"               variables.tf '/^variable "deploy_services"/,/^}/s/default     = false/default     = true/'
try "audit bucket locked by default"             variables.tf '/^variable "lock_audit_anchor_retention"/,/^}/s/default     = false/default     = true/'
try "API cap default raised to 20"               variables.tf '/^variable "api_max_instances"/,/^}/s/default     = 2/default     = 20/'
try "a secret value written into the code"       main.tf      's/^locals {/locals {\n  db_password = "hunter2-super-secret"/'
try "an always-on database added"                main.tf      '$a resource "google_sql_database_instance" "db" {}'

echo "guardrails-selftest: PASS ($fired deliberate breaks, all detected)"
