variable "project_key" {
  description = "LaunchDarkly project key. npm run setup creates it when it does not exist yet."
  type        = string
  default     = "cgc-demo"
}

variable "environment_key" {
  description = "LaunchDarkly environment the demo runs in. A new trial account has \"test\" and \"production\"."
  type        = string
  default     = "test"
}

variable "create_project" {
  description = "Create a new LaunchDarkly project with the key project_key instead of using an existing one. Destroying then deletes the whole project."
  type        = bool
  default     = false
}
