# webui (browser client + SigV4 proxy to the AgentCore Runtime) on Lambda Web Functions.
# The server listens on AWS_LAMBDA_HTTP_ENDPOINT; its AWS SDK uses the execution role to sign requests to ACR.

locals {
  webui_function_name = "${local.project_name}-webui"
  webui_dir           = abspath("${path.module}/../webui")
}

# --- Code bucket: Web Functions load code from a versioned S3 bucket ---

resource "aws_s3_bucket" "webui_code" {
  bucket        = "${local.webui_function_name}-${local.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_versioning" "webui_code" {
  bucket = aws_s3_bucket.webui_code.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_policy" "webui_code" {
  bucket = aws_s3_bucket.webui_code.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = ["s3:GetObject", "s3:GetObjectVersion"]
      Resource  = "${aws_s3_bucket.webui_code.arn}/*"
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.account_id }
        # Requests come from the revision, so the source ARN is under the function.
        ArnLike = { "aws:SourceArn" = "arn:aws:lambda:${local.region}:${local.account_id}:web-function/${local.webui_function_name}/*" }
      }
    }]
  })
}

# Includes webui/node_modules: run `npm ci --omit=dev` in ./webui first.
data "archive_file" "webui" {
  type        = "zip"
  source_dir  = local.webui_dir
  output_path = "${path.module}/.build/webui.zip"
}

resource "aws_s3_object" "webui_code" {
  bucket      = aws_s3_bucket.webui_code.id
  key         = "${local.webui_function_name}/function.zip"
  source      = data.archive_file.webui.output_path
  source_hash = data.archive_file.webui.output_base64sha256

  depends_on = [aws_s3_bucket_versioning.webui_code]
}

# --- Execution role ---

resource "aws_iam_role" "webui" {
  name = local.webui_function_name

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "webui_logs" {
  role       = aws_iam_role.webui.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# The proxy invokes only the doom runtime (the runtime ARN, and its endpoints such as DEFAULT).
resource "aws_iam_role_policy" "webui_invoke_runtime" {
  name = "invoke-doom-runtime"
  role = aws_iam_role.webui.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = "bedrock-agentcore:InvokeAgentRuntime"
      Resource = [
        aws_bedrockagentcore_agent_runtime.doom.agent_runtime_arn,
        "${aws_bedrockagentcore_agent_runtime.doom.agent_runtime_arn}/*",
      ]
    }]
  })
}

# A just-created role is rejected by CreateWebFunctionRevision for a few seconds ("cannot be assumed by
# lambda.amazonaws.com ... If the role was just created, retry in a few seconds"), and awscc / Cloud Control
# doesn't retry it, so wait for IAM to propagate. Only runs when the role is (re)created.
resource "terraform_data" "webui_role_propagation" {
  triggers_replace = [aws_iam_role.webui.arn]

  provisioner "local-exec" {
    command = "sleep 15"
  }

  depends_on = [aws_iam_role_policy_attachment.webui_logs, aws_iam_role_policy.webui_invoke_runtime]
}

# --- Web Function ---

resource "awscc_lambda_web_function" "webui" {
  function_name = local.webui_function_name
}

# Revisions are immutable: a code or config change replaces this resource.
resource "awscc_lambda_web_function_revision" "webui" {
  function_name = awscc_lambda_web_function.webui.function_name

  build_config = {
    code_config = {
      s3_object = {
        bucket     = aws_s3_bucket.webui_code.id
        key        = aws_s3_object.webui_code.key
        version_id = aws_s3_object.webui_code.version_id
      }
    }
    runtime_config = {
      runtime = "nodejs24.x"
    }
  }

  service_config = {
    execution_role_arn = aws_iam_role.webui.arn
    # The SSE frame stream is one long request; the timeout bounds the whole stream (max 900 s). The client
    # reconnects when it ends (ACR already ends streams at ~100 MB, i.e. after ~2.5 min).
    timeout_seconds = 900
    # Lowest cap that still works (1 is valid but breaks the app): with max_environments = 2 the endpoint takes at
    # most 8 requests in flight, and excess requests get HTTP 429 (not queued). One player needs the long-lived
    # SSE stream + one input POST at a time + occasional sound/music downloads + ~6 parallel static fetches on
    # page load. Limits how many streams (data transfer) anyone with the URL can hold open.
    max_concurrency_per_environment = 4
    environment_variables = {
      AWS_LAMBDA_NODEJS_ENTRYPOINT = "server.js"
      AGENT_RUNTIME_ARN            = aws_bedrockagentcore_agent_runtime.doom.agent_runtime_arn
    }
  }

  # Keep the old revision serving until the endpoint has moved to the new one.
  lifecycle {
    create_before_destroy = true
  }

  depends_on = [
    aws_s3_bucket_policy.webui_code,
    terraform_data.webui_role_propagation,
  ]
}

# Public endpoint (ApplicationManaged = no AWS-layer auth), and the webui has no login of its own: anyone with
# the URL can play and drive the runtime. Throttled and capped to limit abuse and cost.
resource "awscc_lambda_web_function_endpoint" "webui" {
  function_name = awscc_lambda_web_function.webui.function_name
  endpoint_name = "default"
  endpoint_type = "HomeRegion"
  auth_type     = "ApplicationManaged"

  revision_weights = [{
    revision_id = awscc_lambda_web_function_revision.webui.revision_id
    weight      = 100
  }]

  throttle_config = {
    rate_limit = 100
  }

  scaling_config = {
    max_environments = 2
  }
}

output "webui_url" {
  description = "Public URL of the web UI"
  value       = "https://${awscc_lambda_web_function_endpoint.webui.domain_name}"
}
