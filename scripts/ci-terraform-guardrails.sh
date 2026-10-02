#!/usr/bin/env bash
# The $0 guardrails must be present in the Terraform code. Run from infra/terraform.
# This reads the code; it never contacts Google Cloud. Comments are stripped first so a
# guardrail that only appears in a comment does not count.
set -euo pipefail
fail() { echo "terraform-guardrails: FAIL - $*" >&2; exit 1; }

code="$(sed -e 's/[[:space:]]*#.*$//' main.tf)"
vars="$(sed -e 's/[[:space:]]*#.*$//' variables.tf)"
count() { printf '%s\n' "$code" | grep -Ec -- "$1" || true; }
top_level_end='^[}]'
block() { printf '%s\n' "$1" | awk -v start="$2" -v stop="${3:-$top_level_end}" '$0 ~ start {f=1; print; next} f {print} f && $0 ~ stop {exit}'; }
default_of() { block "$vars" "^variable \"$1\"" | sed -n 's/^ *default *= *\(.*\)$/\1/p' | head -1; }

# Cloud Run: scale to zero, hard caps, request-based billing - on BOTH services.
[ "$(count '^ *min_instance_count *= *0$')" -eq 2 ] || fail "both Cloud Run services must have min_instance_count = 0"
[ "$(count '^ *min_instance_count *=')" -eq 2 ] || fail "unexpected number of min_instance_count settings"
[ "$(count '^ *max_instance_count *= *var\.api_max_instances$')" -eq 1 ] || fail "the API must be capped by var.api_max_instances"
[ "$(count '^ *max_instance_count *= *1$')" -eq 1 ] || fail "the AI service must be capped at exactly 1 instance"
[ "$(count '^ *max_instance_count *=')" -eq 2 ] || fail "unexpected number of max_instance_count settings"
[ "$(count '^ *cpu_idle *= *true$')" -eq 2 ] || fail "both services must use request-based billing (cpu_idle = true)"
[ "$(count '^ *cpu_idle *= *false$')" -eq 0 ] || fail "a service has always-allocated CPU"
[ "$(count 'ingress *= *"INGRESS_TRAFFIC_INTERNAL_ONLY"')" -eq 1 ] || fail "the AI service must be internal-only"
api_max="$(default_of api_max_instances)"
case "$api_max" in 1|2|3) ;; *) fail "api_max_instances default must be 1, 2 or 3 (found '$api_max')" ;; esac

# Flags that create things or are irreversible must be OFF unless the founder turns them on.
for flag in deploy_services lock_audit_anchor_retention enable_ci_deploy; do
  [ "$(default_of "$flag")" = "false" ] || fail "variable $flag must default to false"
done

# Budget alert, buckets, secrets.
[ "$(count '^resource "google_billing_budget"')" -eq 1 ] || fail "no budget alert"
buckets="$(count '^resource "google_storage_bucket" ')"
[ "$buckets" -eq 2 ] || fail "expected exactly 2 buckets, found $buckets"
[ "$(count '^ *public_access_prevention *= *"enforced"$')" -eq "$buckets" ] || fail "every bucket must enforce public access prevention"
[ "$(count '^ *uniform_bucket_level_access *= *true$')" -eq "$buckets" ] || fail "every bucket must use uniform bucket-level access"
[ "$(count '^ *retention_policy \{$')" -eq "$buckets" ] || fail "every bucket needs a retention policy"
[ "$(count '^ *location *= *var\.primary_region$')" -ge "$buckets" ] || fail "buckets must be in the primary (free-allowance) region"
[ "$(default_of primary_region)" = '"us-central1"' ] || fail "primary_region must default to us-central1 (free Cloud Storage allowance)"
secrets="$(block "$code" '^  secrets = [{]' '^  [}]' | grep -Ec '^ +[a-z-]+ += +"')"
[ "$secrets" -eq 6 ] || fail "expected exactly 6 secrets (the free allowance), found $secrets"
[ "$(count '^resource "google_cloud_scheduler_job" ')" -le 3 ] || fail "more than 3 scheduler jobs (only 3 are free)"

# Terraform must never hold a secret VALUE, and nothing always-on or billable-by-the-hour may be added.
if grep -Eq 'secret_data|google_secret_manager_secret_version' ./*.tf; then fail "Terraform must never hold a secret VALUE"; fi
# A secret-ish name assigned a literal with no spaces (descriptions have spaces; the six secret NAMES are allowed).
if printf '%s\n%s\n' "$code" "$vars" | grep -Ei '(password|pepper|token|keyring|secret|_key)[a-z_-]* *= *"[^" $]{12,}"' \
   | grep -Evq '= *"(database-url|database-url-admin|sc-pepper-keyring|credential-enc-keyring|hmac-index-key|internal-service-token)"'; then
  fail "something that looks like a secret value is written in the Terraform code"
fi
paid='google_sql_|google_redis_|google_compute_(instance|address|global_address|router|forwarding_rule|backend_service)|google_container_cluster|google_vpc_access_connector|google_logging_project_sink|google_alloydb_|google_memcache_|google_kms_'
if grep -Eq "resource \"($paid)" ./*.tf; then fail "a resource that costs money while idle was added"; fi

echo "terraform-guardrails: PASS (min 0 x2, max api=$api_max ai=1, request-based billing x2, budget alert, $secrets empty secrets, $buckets private buckets with retention, risky flags default to false)"
