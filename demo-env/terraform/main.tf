# Grafana alerting configuration as code.
#
# Division of labour in this project:
#   ArgoCD   owns the workload   (demo-env/k8s)      → rollback story
#   Terraform owns the alerting   (this module)      → infra-as-code story
#
# That split is deliberate: two systems managing the same object would drift,
# and the agent needs one unambiguous place to propose each kind of change. When
# the fix is "this threshold is wrong" or "we need an alert for this", the agent
# edits HCL here, runs a plan through the Terraform MCP, and opens a PR with the
# plan output attached — behind the same approval gate as everything else.

terraform {
  required_version = ">= 1.6"
  required_providers {
    grafana = {
      source  = "grafana/grafana"
      version = "~> 3.18"
    }
  }
}

provider "grafana" {
  url  = var.grafana_url
  auth = var.grafana_token
}

resource "grafana_folder" "sre_oncall" {
  title = "SRE-Oncall"
}

# Where alerts go: the orchestrator on the host. Grafana runs inside the kind
# cluster, so this hop stays on the machine and needs no tunnel.
resource "grafana_contact_point" "sre_oncall" {
  name = "sre-oncall"

  webhook {
    url                       = var.orchestrator_webhook_url
    http_method               = "POST"
    authorization_scheme      = "Bearer"
    authorization_credentials = var.webhook_bearer
  }
}

resource "grafana_notification_policy" "root" {
  contact_point = grafana_contact_point.sre_oncall.name
  group_by      = ["alertname", "namespace", "pod"]

  # Fast enough for a live demo; the orchestrator does its own flap handling,
  # deduplication and rate limiting, so Grafana does not need to be clever here.
  group_wait      = "10s"
  group_interval  = "30s"
  repeat_interval = "4h"
}
