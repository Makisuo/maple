# The upstream ElectricSQL sync service, unmodified.
#
# A Dockerfile rather than an image reference because alchemy's ECS service
# builds a context and pushes to ECR — so the task pulls from there over the
# VPC's S3 gateway endpoint, not from Docker Hub on every placement.
#
# PINNED, never `:latest`. `docker-compose.yml` tracks `:latest` locally on
# purpose, but here an upgrade is a deliberate read of the release notes: the
# storage format has changed across minors, and rolling back after the new
# version has rewritten the shape cache re-snapshots every connected client.
FROM electricsql/electric:1.7.12
