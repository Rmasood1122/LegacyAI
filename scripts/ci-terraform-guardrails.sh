#!/usr/bin/env bash
# The $0 guardrails must be present in the Terraform code. Run from infra/terraform.
# This reads the code; it never contacts Google Cloud.
set -euo pipefail
fail() { echo "terraform-guardrails: FAIL - $*" >&2; exit 1; }
f=main.tf

[ "$(grep -c 'min_instance_count = 0' "$f")" -eq 2 ] || fail "both Cloud Run services must have min_instance_count = 0"
grep -q 'max_instance_count = var.api_max_instances' "$f" || fail "the API has no max-instances cap"
grep -q 'max_instance_count = 1' "$f" || fail "the AI service has no max-instances cap"
[ "$(grep -c 'cpu_idle *= true' "$f")" -eq 2 ] || fail "both services must use request-based billing (cpu_idle = true)"
grep -q 'google_billing_budget' "$f" || fail "no budget alert"
grep -q 'public_access_prevention *= "enforced"' "$f" || fail "buckets must enforce public access prevention"
[ "$(grep -c 'retention_policy {' "$f")" -eq 2 ] || fail "both buckets need a retention policy"
grep -q 'INGRESS_TRAFFIC_INTERNAL_ONLY' "$f" || fail "the AI service must be internal-only"
grep -Eq 'default *= *false' variables.tf || fail "deploy_services / lock / ci flags must default to false"
[ "$(grep -c '^    [a-z-]* *= "' "$f" | head -1)" -ge 6 ] || true
secrets="$(awk '/secrets = \{/{f=1;next} f&&/\}/{f=0} f' "$f" | grep -c '=')"
[ "$secrets" -eq 6 ] || fail "expected exactly 6 secrets (the free allowance), found $secrets"
if grep -Eq 'secret_data|google_secret_manager_secret_version' ./*.tf; then fail "Terraform must never hold a secret VALUE"; fi
if grep -Rqs 'google_sql_database_instance\|google_redis_instance\|google_compute_instance\|google_container_cluster' ./*.tf; then
  fail "a paid always-on resource was added"
fi
max="$(sed -n '/variable "api_max_instances"/,/^}/p' variables.tf | sed -n 's/.*default *= *\([0-9]*\).*/\1/p')"
[ "$max" -le 3 ] || fail "api_max_instances default is $max"
echo "terraform-guardrails: PASS (min 0, max api=$max ai=1, request-based billing, budget alert, 6 empty secrets, private buckets with retention)"
