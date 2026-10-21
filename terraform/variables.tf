variable "project_key" {
  description = "LaunchDarkly project key. Defaults to the cgc-demo project this repo creates; a new trial account instead has one called \"default\"."
  type        = string
  default     = "cgc-demo"
}

variable "new_relic_trigger_integration" {
  description = "Trigger type for the New Relic auto-remediation trigger. \"generic-trigger\" works with every provider version. Set TF_VAR_new_relic_trigger_integration=new-relic-apm-v2 (LaunchDarkly's current \"New Relic\" type) once the launchdarkly provider accepts it; \"new-relic-apm\" is the deprecated type."
  type        = string
  default     = "generic-trigger"
}

variable "environment_key" {
  description = "LaunchDarkly environment the demo runs in. A new trial account has \"test\" and \"production\"."
  type        = string
  default     = "test"
}

variable "slack_webhook_url" {
  description = "Optional Slack incoming-webhook URL. When set, every flag change is posted to that Slack channel."
  type        = string
  default     = ""
  sensitive   = true
}

variable "create_project" {
  description = "Create a new LaunchDarkly project with the key project_key instead of using an existing one. Destroying then deletes the whole project."
  type        = bool
  default     = false
}
