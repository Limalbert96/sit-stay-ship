# Everything the demo needs in LaunchDarkly, as code: flags and their targeting, metrics, the
# flag trigger (kill switch), the AI Config with its models and variations, and an optional
# Slack subscription.
#
# What Terraform does not manage, because the provider has no resource for it:
#   - experiments, and the AI Config's default rule. `npm run setup` creates those through
#     the LaunchDarkly API right after `terraform apply` (see scripts/setup.mjs).

# ---------------------------------------------------------------------------------------
# Project. Normally you use the project your account already has ("default"). With
# create_project = true (npm run setup -- --create-project) a brand-new project is created
# instead, and `terraform destroy` deletes it again with everything in it. That is the easy
# way to try the whole setup from scratch, as a new user would see it.
# ---------------------------------------------------------------------------------------

resource "launchdarkly_project" "demo" {
  count = var.create_project ? 1 : 0

  key  = var.project_key
  name = "CGC Prep (${var.project_key})"
  tags = ["cgc-prep"]

  environments = {
    (var.environment_key) = {
      key   = var.environment_key
      name  = title(var.environment_key)
      color = "3DD68C"
    }
    production = {
      key   = "production"
      name  = "Production"
      color = "417505"
    }
  }

  default_client_side_availability = {
    using_environment_id = true
    using_mobile_key     = false
  }
}

locals {
  # Referencing the created project (when there is one) makes everything below wait for it.
  project_key = var.create_project ? launchdarkly_project.demo[0].key : var.project_key
}

data "launchdarkly_environment" "demo" {
  project_key = local.project_key
  key         = var.environment_key

  # The project key is known at plan time even when the project does not exist yet, so without
  # this Terraform would look the environment up too early. Waiting for the project defers the
  # lookup until after it has been created.
  depends_on = [launchdarkly_project.demo]
}

# ---------------------------------------------------------------------------------------
# Flag: premium-video-tutorials (release and remediate, targeting, experiment)
# ---------------------------------------------------------------------------------------

resource "launchdarkly_feature_flag" "premium_video_tutorials" {
  project_key    = local.project_key
  key            = "premium-video-tutorials"
  name           = "Premium Video Tutorials"
  description    = "Gates the Premium Video Tutorials card on the CGC Prep landing page. Release and instant rollback by toggling the flag, plus a flag trigger as the kill switch. Targeting: individual target alex-vip and a rule for the premium and beta tiers. Experiment: does showing the videos raise clicks on Start Training (metric clicked-start-training)?"
  variation_type = "boolean"
  temporary      = true
  tags           = ["cgc-prep", "release", "targeting", "experiment", "kill-switch"]

  variations = [{ value = "true" }, { value = "false" }]

  defaults = {
    on_variation  = 0
    off_variation = 1
  }

  # The browser SDK needs the flag to be available to the client-side ID.
  client_side_availability = {
    using_environment_id = true
    using_mobile_key     = false
  }
}

resource "launchdarkly_feature_flag_environment" "premium_video_tutorials" {
  flag_id = launchdarkly_feature_flag.premium_video_tutorials.id
  env_key = var.environment_key

  on            = true
  off_variation = 1

  # Individual targeting: a free-tier user who still gets the feature, by key.
  targets = [{
    values    = ["alex-vip"]
    variation = 0
  }]

  # Rule-based targeting on the context attribute `tier`.
  rules = [{
    description = "Paying and beta tiers"
    clauses = [{
      attribute = "tier"
      op        = "in"
      values    = ["premium", "beta"]
      negate    = false
    }]
    variation = 0
    }, {
    # Experiment audience: trial users are split 50/50 between seeing the videos and not. The
    # experiment (created by npm run setup) runs on this rule. Keeping the experiment on its own
    # rule means everyone else is not affected: Sam keeps getting the dark default.
    description = "Trial users (experiment audience)"
    clauses = [{
      attribute = "tier"
      op        = "in"
      values    = ["trial"]
      negate    = false
    }]
    rollout_weights = [50000, 50000]
    context_kind    = "user"
  }]

  # Dark default: everyone else gets `false`.
  fallthrough = {
    variation = 1
  }

  # LaunchDarkly advises not to let Terraform overwrite the rules of a flag that an experiment
  # runs on: an experiment adds allocation settings to its rule, and a later apply would reset them.
  lifecycle {
    ignore_changes = [rules, fallthrough]
  }
}

# ---------------------------------------------------------------------------------------
# Flag: exam-progress-tracker (optional gradual-rollout scenario)
# ---------------------------------------------------------------------------------------

resource "launchdarkly_feature_flag" "exam_progress_tracker" {
  project_key    = local.project_key
  key            = "exam-progress-tracker"
  name           = "Exam Progress Tracker"
  description    = "Optional second scenario. Gates the Exam Progress Tracker card (checklist of CGC test items). Dark launched to the beta tier with a rule, then released gradually with a percentage rollout on the default rule."
  variation_type = "boolean"
  temporary      = true
  tags           = ["cgc-prep", "optional", "gradual-rollout"]

  variations = [{ value = "true" }, { value = "false" }]

  defaults = {
    on_variation  = 0
    off_variation = 1
  }

  client_side_availability = {
    using_environment_id = true
    using_mobile_key     = false
  }
}

resource "launchdarkly_feature_flag_environment" "exam_progress_tracker" {
  flag_id = launchdarkly_feature_flag.exam_progress_tracker.id
  env_key = var.environment_key

  on            = true
  off_variation = 1

  rules = [{
    description = "Beta testers"
    clauses = [{
      attribute = "tier"
      op        = "in"
      values    = ["beta"]
      negate    = false
    }]
    variation = 0
  }]

  # Gradual rollout demo: change this to rollout_weights = [25000, 75000], then 50/50, then 100/0.
  fallthrough = {
    variation = 1
  }
}

# ---------------------------------------------------------------------------------------
# Kill switch: a flag trigger that turns premium-video-tutorials off (remediation)
# ---------------------------------------------------------------------------------------

# Needs a plan with flag triggers (a free trial includes them).
resource "launchdarkly_flag_trigger" "kill_switch" {
  project_key     = local.project_key
  env_key         = var.environment_key
  flag_key        = launchdarkly_feature_flag.premium_video_tutorials.key
  integration_key = "generic-trigger"
  enabled         = true

  instructions = {
    kind = "turnFlagOff"
  }

  depends_on = [launchdarkly_feature_flag_environment.premium_video_tutorials]
}

# ---------------------------------------------------------------------------------------
# Experiment metrics
# ---------------------------------------------------------------------------------------

resource "launchdarkly_metric" "clicked_start_training" {
  project_key = local.project_key
  key         = "clicked-start-training"
  name        = "clicked-start-training"
  description = "Tracks conversion rate when users click the Start Training button."
  kind        = "custom"
  event_key   = "clicked-start-training"
  is_numeric  = false
  tags        = ["cgc-prep"]
}

resource "launchdarkly_metric" "ai_response_helpful" {
  project_key = local.project_key
  key         = "ai-response-helpful"
  name        = "ai-response-helpful"
  description = "A user rated a chatbot reply as helpful (the Yes button)."
  kind        = "custom"
  event_key   = "ai-response-helpful"
  is_numeric  = false
  tags        = ["cgc-prep"]
}

# ---------------------------------------------------------------------------------------
# AI Config: canine-coach-chatbot, on two free local models served by Ollama
# ---------------------------------------------------------------------------------------

# LaunchDarkly's model catalog lists cloud models, so the local ones are registered here.
# The model_id is exactly the name Ollama knows (ollama pull llama3.2:1b).
resource "launchdarkly_model_config" "llama_1b" {
  project_key    = local.project_key
  key            = "llama3-2-1b-ollama"
  name           = "Llama 3.2 1B (Ollama)"
  model_id       = "llama3.2:1b"
  model_provider = "ollama"
  tags           = ["cgc-prep"]
}

resource "launchdarkly_model_config" "llama_3b" {
  project_key    = local.project_key
  key            = "llama3-2-3b-ollama"
  name           = "Llama 3.2 3B (Ollama)"
  model_id       = "llama3.2:3b"
  model_provider = "ollama"
  tags           = ["cgc-prep"]
}

resource "launchdarkly_ai_config" "chatbot" {
  project_key = local.project_key
  key         = "canine-coach-chatbot"
  name        = "Canine Coach Chatbot"
  description = "Chatbot that coaches dog owners through the 10 AKC Canine Good Citizen test items. Two variations compare a concise prompt on a small model with a detailed prompt on a larger one; the experiment measures how often users rate the reply helpful (ai-response-helpful)."
  mode        = "completion"
  tags        = ["cgc-prep", "ai-config", "experiment"]
}

resource "launchdarkly_ai_config_variation" "concise" {
  project_key      = local.project_key
  config_key       = launchdarkly_ai_config.chatbot.key
  key              = "concise"
  name             = "Concise"
  model_config_key = launchdarkly_model_config.llama_1b.key

  messages = [{
    role    = "system"
    content = "You are a concise Canine Good Citizen coach. Answer in one or two sentences."
  }]
}

resource "launchdarkly_ai_config_variation" "detailed" {
  project_key      = local.project_key
  config_key       = launchdarkly_ai_config.chatbot.key
  key              = "detailed"
  name             = "Detailed"
  model_config_key = launchdarkly_model_config.llama_3b.key

  messages = [{
    role    = "system"
    content = "You are an expert canine behaviorist specializing in the AKC Canine Good Citizen test. Explain the reasoning behind each test item and give step by step training advice."
  }]
}

# ---------------------------------------------------------------------------------------
# Optional Slack notifications for every flag change
# ---------------------------------------------------------------------------------------

resource "launchdarkly_audit_log_subscription" "slack" {
  count = var.slack_webhook_url == "" ? 0 : 1

  integration_key = "slack"
  name            = "CGC Prep: flag changes in Slack"
  on              = true
  tags            = ["cgc-prep"]

  config = {
    url = var.slack_webhook_url
  }

  statements = [{
    effect    = "allow"
    actions   = ["*"]
    resources = ["proj/${local.project_key}:env/*:flag/*"]
  }]
}
