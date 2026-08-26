variable "grafana_url" {
  description = "Base URL of the Grafana in the kind cluster."
  type        = string
  default     = "http://localhost:3000"
}

variable "grafana_token" {
  description = "Grafana service-account token with alerting write access."
  type        = string
  sensitive   = true
}

variable "webhook_bearer" {
  description = "Bearer the orchestrator requires on POST /webhook/grafana."
  type        = string
  sensitive   = true
}

variable "orchestrator_webhook_url" {
  description = "Where Grafana posts alerts. From inside the cluster the host is host.docker.internal."
  type        = string
  default     = "http://host.docker.internal:8080/webhook/grafana"
}

variable "demo_namespace" {
  description = "Namespace the demo service runs in."
  type        = string
  default     = "demo"
}

variable "prometheus_datasource_uid" {
  description = "UID of the Prometheus datasource the monitoring stack provisioned. Find it with: curl -s -H \"Authorization: Bearer $GRAFANA_TOKEN\" $GRAFANA_URL/api/datasources | jq -r '.[] | select(.type==\"prometheus\") | .uid'"
  type        = string
  default     = "prometheus"
}
