#!/bin/sh
# The fake reads /fixtures once at startup; a changed or added fixture file
# needs this restart. Fails loud when a fixture is invalid: the container
# exits at boot and never turns healthy.
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
"$DIR/compose.sh" restart embeddings

for _ in $(seq 1 30); do
  state=$("$DIR/compose.sh" ps --format '{{.Health}}' embeddings 2>/dev/null || echo "gone")
  if [ "$state" = "healthy" ]; then
    echo "fixtures reloaded"
    exit 0
  fi
  sleep 1
done

echo "embeddings (fake-model-server) did not turn healthy; its logs:" >&2
"$DIR/compose.sh" logs --no-color --tail 40 embeddings >&2
exit 1
