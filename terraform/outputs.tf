# Read by `npm run setup`, which writes them into .env.

output "client_side_id" {
  description = "Client-side ID of the environment (browser SDK)."
  value       = data.launchdarkly_environment.demo.client_side_id
  sensitive   = true
}

output "sdk_key" {
  description = "Server-side SDK key of the environment (chat backend, traffic simulator)."
  value       = data.launchdarkly_environment.demo.api_key
  sensitive   = true
}

output "trigger_url" {
  description = "URL of the flag trigger that turns premium-video-tutorials off."
  value       = launchdarkly_flag_trigger.kill_switch.trigger_url
  sensitive   = true
}

output "new_relic_trigger_url" {
  description = "A second, separate trigger that also turns premium-video-tutorials off. Paste this into a New Relic Workflow's webhook destination; it never touches the app or the kill-switch button above."
  value       = launchdarkly_flag_trigger.new_relic_alert.trigger_url
  sensitive   = true
}

output "ai_config_key" {
  value = launchdarkly_ai_config.chatbot.key
}
