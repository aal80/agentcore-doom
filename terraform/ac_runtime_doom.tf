# AgentCore Runtime running the doom agent image, plus its execution role.

locals {
  # Runtime names must match [a-zA-Z][a-zA-Z0-9_]{0,47}: no hyphens.
  runtime_name = replace(local.project_name, "-", "_")
}

resource "aws_iam_role" "doom_runtime" {
  name        = "AgentCoreDoomRuntimeRole"
  description = "Execution role for the agentcore-doom AgentCore Runtime"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "bedrock-agentcore.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "doom_runtime" {
  name = "AgentCoreDoomRuntime"
  role = aws_iam_role.doom_runtime.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ECRImagePull"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
        Resource = "*"
      },
      {
        Sid    = "ContainerLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:log-group:*"
      },
    ]
  })
}

resource "aws_bedrockagentcore_agent_runtime" "doom" {
  agent_runtime_name = local.runtime_name
  role_arn           = aws_iam_role.doom_runtime.arn

  # V2 restores each session from a snapshot taken after the agent is healthy (fast, consistent cold starts).
  platform_version = "V2"

  agent_runtime_artifact {
    container_configuration {
      container_uri = local.image_uri
    }
  }

  network_configuration {
    network_mode = "PUBLIC"
  }

  protocol_configuration {
    server_protocol = "HTTP"
  }

  # A game resets 2 min after the last stream closes, and after 5 min at most.
  lifecycle_configuration {
    idle_runtime_session_timeout = 120
    max_lifetime                 = 300
  }

  # The image must be in ECR, and the role able to read it, before the runtime pulls it. IAM propagation delays
  # ("Role validation failed", "Access denied while validating ECR URI") are retried by the provider on create.
  depends_on = [terraform_data.doom_image, aws_iam_role_policy.doom_runtime]
}

# The webui reads the runtime ARN from here (make webui-run-acr).
resource "local_file" "doom_runtime_arn" {
  filename        = "${path.module}/../tmp/doom_runtime_arn.txt"
  content         = "${aws_bedrockagentcore_agent_runtime.doom.agent_runtime_arn}\n"
  file_permission = "0644"
}

output "runtime_arn" {
  description = "AgentCore Runtime ARN for the doom agent"
  value       = aws_bedrockagentcore_agent_runtime.doom.agent_runtime_arn
}
