#!/usr/bin/env bash
# Human-run installation only; no package installation or implicit activation.
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ ! -x /usr/bin/node ]]; then
  printf '%s\n' 'Host Node.js 20+ is required at /usr/bin/node; ask the operator to install it.' >&2
  exit 1
fi
exec /usr/bin/node "$here/install.mjs" "$@"
