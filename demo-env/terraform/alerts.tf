# Alert rules for the demo service.
#
# Deliberately faster than the kube-prometheus-stack built-ins (which use 10-15
# minute `for:` durations): each of these fires within a couple of minutes, so a
# full inject → alert → heal → resolve cycle fits inside a demo. The built-ins
# stay enabled underneath as background coverage.
#
# Every rule maps 1:1 to a runbook in skills/sre-runbooks/runbooks/, named in the
# `runbook` annotation. Keep that mapping intact when adding a rule — it is how
# the agent chooses which runbook to follow.

locals {
  # The datasource the kube-prometheus-stack chart provisions.
  prometheus_uid = var.prometheus_datasource_uid

  # Threshold conditions are boilerplate; this keeps each rule to its query.
  threshold_model = { for name, bound in {
    error_rate = 0.05 # 5% of requests
    latency    = 0.5  # 500ms at p99
    oom        = 0    # any OOMKill at all
    restarts   = 3    # restarts in 10 minutes
    replicas   = 0    # any missing ready replica
    } : name => jsonencode({
      refId      = "threshold"
      type       = "threshold"
      expression = "query"
      conditions = [{ evaluator = { type = "gt", params = [bound] } }]
  }) }
}

resource "grafana_rule_group" "demo_service" {
  name             = "demo-service"
  folder_uid       = grafana_folder.sre_oncall.uid
  interval_seconds = 30

  rule {
    name      = "HighErrorRate"
    condition = "threshold"
    for       = "1m"
    labels    = { severity = "critical", service = "demo-service" }
    annotations = {
      summary = "5xx ratio for demo-service is above 5%"
      runbook = "high-error-rate"
    }

    data {
      ref_id         = "query"
      datasource_uid = local.prometheus_uid
      relative_time_range {
        from = 300
        to   = 0
      }
      model = jsonencode({
        refId   = "query"
        instant = true
        expr    = <<-PROMQL
          sum(rate(http_requests_total{service="demo-service", status=~"5.."}[2m]))
            /
          clamp_min(sum(rate(http_requests_total{service="demo-service"}[2m])), 0.001)
        PROMQL
      })
    }
    data {
      ref_id         = "threshold"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 300
        to   = 0
      }
      model = local.threshold_model["error_rate"]
    }
  }

  rule {
    name      = "HighLatencyP99"
    condition = "threshold"
    for       = "2m"
    labels    = { severity = "warning", service = "demo-service" }
    annotations = {
      summary = "p99 latency for demo-service is above 500ms"
      runbook = "connection-pool-exhaustion"
    }

    data {
      ref_id         = "query"
      datasource_uid = local.prometheus_uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        refId   = "query"
        instant = true
        expr    = <<-PROMQL
          histogram_quantile(0.99,
            sum by (le) (rate(http_request_duration_seconds_bucket{service="demo-service"}[5m])))
        PROMQL
      })
    }
    data {
      ref_id         = "threshold"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 600
        to   = 0
      }
      model = local.threshold_model["latency"]
    }
  }

  rule {
    name = "OOMKilled"
    # No `for:` — one OOM kill is already the incident.
    condition = "threshold"
    for       = "0s"
    labels    = { severity = "critical", service = "demo-service" }
    annotations = {
      summary = "A demo-service container was killed for exceeding its memory limit"
      runbook = "pod-crashloop-oom"
    }

    data {
      ref_id         = "query"
      datasource_uid = local.prometheus_uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        refId   = "query"
        instant = true
        expr    = "max(kube_pod_container_status_last_terminated_reason{namespace=\"${var.demo_namespace}\", reason=\"OOMKilled\"})"
      })
    }
    data {
      ref_id         = "threshold"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 600
        to   = 0
      }
      model = local.threshold_model["oom"]
    }
  }

  rule {
    name      = "ContainerRestartsSpiking"
    condition = "threshold"
    for       = "1m"
    labels    = { severity = "warning", service = "demo-service" }
    annotations = {
      summary = "demo-service containers are restarting repeatedly"
      runbook = "pod-crashloop-oom"
    }

    data {
      ref_id         = "query"
      datasource_uid = local.prometheus_uid
      relative_time_range {
        from = 900
        to   = 0
      }
      model = jsonencode({
        refId   = "query"
        instant = true
        expr    = "max(increase(kube_pod_container_status_restarts_total{namespace=\"${var.demo_namespace}\"}[10m]))"
      })
    }
    data {
      ref_id         = "threshold"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 900
        to   = 0
      }
      model = local.threshold_model["restarts"]
    }
  }

  rule {
    name      = "ReplicasUnavailable"
    condition = "threshold"
    for       = "2m"
    labels    = { severity = "critical", service = "demo-service" }
    annotations = {
      summary = "demo-service has fewer ready replicas than desired"
      runbook = "event-only-failures"
    }

    data {
      ref_id         = "query"
      datasource_uid = local.prometheus_uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        refId   = "query"
        instant = true
        expr    = <<-PROMQL
          kube_deployment_spec_replicas{namespace="${var.demo_namespace}", deployment="demo-service"}
            - kube_deployment_status_replicas_ready{namespace="${var.demo_namespace}", deployment="demo-service"}
        PROMQL
      })
    }
    data {
      ref_id         = "threshold"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 600
        to   = 0
      }
      model = local.threshold_model["replicas"]
    }
  }
}
