#!/usr/bin/env bash
set -euo pipefail

repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$repo"
if [[ -n "$(git status --porcelain=v1)" ]]; then
  printf '%s\n' 'Build refused: commit and review the source first.' >&2
  exit 1
fi
revision="$(git rev-parse HEAD)"
image="${1:-localhost/pw-deploy:${revision:0:12}}"
if [[ ! "$image" =~ ^[a-z0-9][a-z0-9./:_-]{1,220}$ ]]; then
  printf '%s\n' 'Build refused: invalid image tag.' >&2
  exit 1
fi
if [[ $# -gt 1 ]]; then
  printf '%s\n' 'Usage: bash deploy/container/build.sh [image:tag]' >&2
  exit 1
fi

git archive --format=tar "$revision" \
  app/deployment app/atomic-file.js app/lifecycle-lock.js app/VERSION deploy/container |
  podman build --format=docker --pull=missing --file deploy/container/Containerfile \
    --build-arg "PW_DEPLOY_REVISION=$revision" --tag "$image" -

podman image inspect --format '{{.Id}}' "$image"
