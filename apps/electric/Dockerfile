# The upstream ElectricSQL sync service, unmodified.
#
# A Dockerfile rather than an image reference because alchemy's ECS service
# builds a context and pushes to a private ECR repository — which also means the
# task pulls from ECR over the VPC's S3 gateway endpoint instead of dialing
# Docker Hub on every placement, and is not exposed to a Hub rate limit or an
# upstream tag being moved.
#
# PINNED, never `:latest`. `docker-compose.yml` tracks `:latest` locally on
# purpose (dev wants the newest), so an upgrade here is a deliberate read of the
# release notes: Electric's storage format has changed across minors, and a
# rollback after the new version has rewritten the shape cache means a full
# re-snapshot for every connected client.
FROM electricsql/electric:1.7.12
