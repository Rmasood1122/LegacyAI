# Copy to terraform.tfvars (git-ignored) and fill in. NOTHING here is a secret.
project_id         = "my-legacyai-project"
billing_account_id = "000000-AAAAAA-BBBBBB"
alert_email        = "you@example.com"

# Where this copy lives: "us" (default, free storage allowance) or "eu" (Belgium; NOT free). A second region is a
# second copy in its own project with its own state (infra/README.md, Part F). Never change this on a copy that holds data.
home_region = "us"

# Step 1 (first apply): leave false. Creates registry, empty secrets, buckets, accounts, budget.
# Step 2: push the images and add secret values by hand (infra/README.md).
# Step 3: set to true and apply again to create the Cloud Run services and jobs.
deploy_services = false

# allowed_origins      = "https://app.yourdomain.com"
# webauthn_rp_id       = "app.yourdomain.com"
# backup_age_recipient = "age1..."        # PUBLIC key only

# IRREVERSIBLE if set to true. Leave false during the pilot.
lock_audit_anchor_retention = false
