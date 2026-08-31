#!/bin/sh
set -eu
mc alias set local "$S3_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb -p "local/${CELLD_S3_BUCKET:-maple-celld}" || true
mc anonymous set none "local/${CELLD_S3_BUCKET:-maple-celld}" || true
echo "minio-init: bucket ${CELLD_S3_BUCKET:-maple-celld} ready"
