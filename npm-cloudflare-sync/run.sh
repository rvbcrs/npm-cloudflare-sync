#!/bin/bash
set -e

# Home Assistant supplies options.json; standalone Docker uses its environment.
if [ -f /data/options.json ]; then
  for name in CF_API_TOKEN CF_EMAIL NPM_API_URL NPM_EMAIL NPM_PASSWORD CHECK_INTERVAL LOG_LEVEL AUTO_CREATE_ROOT_RECORDS; do
    value=$(jq --raw-output --arg name "$name" '.[$name]' /data/options.json)
    export "$name=$value"
  done
fi

# Start the application
exec node dist/index.js
