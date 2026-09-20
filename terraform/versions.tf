terraform {
  required_version = ">= 1.5"

  required_providers {
    launchdarkly = {
      source  = "launchdarkly/launchdarkly"
      version = "~> 3.0"
    }
  }
}

# Authentication: export LAUNCHDARKLY_ACCESS_TOKEN (npm run setup does this from LD_API_TOKEN).
provider "launchdarkly" {}
