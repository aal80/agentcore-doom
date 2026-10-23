# ECR repository for the doom agent image, plus a local docker build + push whenever doom/ changes.

locals {
  doom_dir = abspath("${path.module}/../doom")

  # Content hash of everything that goes into the image; a change rebuilds and pushes under a new tag.
  doom_src_hash = sha1(join("", [
    for f in sort(fileset(local.doom_dir, "**")) : filesha1("${local.doom_dir}/${f}")
  ]))

  ecr_registry = "${local.account_id}.dkr.ecr.${local.region}.amazonaws.com"
  image_tag    = substr(local.doom_src_hash, 0, 12)
  image_uri    = "${aws_ecr_repository.doom.repository_url}:${local.image_tag}"
}

resource "aws_ecr_repository" "doom" {
  name = local.project_name
  # Tags are content hashes of doom/, so a tag never needs to point at a different image.
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

# Builds the ARM64 image (required by AgentCore Runtime) and pushes it. Re-runs only when doom/ content changes.
# Skips the build if the tag is already in ECR: tags are immutable, and a rebuild of the same content gets a new
# digest (build attestations), so pushing it again would fail.
resource "terraform_data" "doom_image" {
  triggers_replace = [local.image_uri]

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-euo", "pipefail", "-c"]
    command     = <<-EOT
      if aws ecr describe-images --region ${local.region} --repository-name ${aws_ecr_repository.doom.name} \
          --image-ids imageTag=${local.image_tag} >/dev/null 2>&1; then
        echo "${local.image_uri} already in ECR, skipping build"
        exit 0
      fi
      aws ecr get-login-password --region ${local.region} \
        | docker login --username AWS --password-stdin ${local.ecr_registry}
      docker build --platform linux/arm64 -t ${local.image_uri} ${local.doom_dir}
      docker push ${local.image_uri}
    EOT
  }
}

output "image_uri" {
  description = "Doom agent image in ECR (tag = content hash of doom/)"
  value       = local.image_uri
  depends_on  = [terraform_data.doom_image]
}
