#!/bin/bash
set -e

# Read from the options.json file and export as environment variables
export CF_API_TOKEN=$(jq --raw-output '.CF_API_TOKEN' /data/options.json)
export CF_EMAIL=$(jq --raw-output '.CF_EMAIL' /data/options.json)
export NPM_API_URL=$(jq --raw-output '.NPM_API_URL' /data/options.json)
export NPM_EMAIL=$(jq --raw-output '.NPM_EMAIL' /data/options.json)
export NPM_PASSWORD=$(jq --raw-output '.NPM_PASSWORD' /data/options.json)
export CHECK_INTERVAL=$(jq --raw-output '.CHECK_INTERVAL' /data/options.json)
export LOG_LEVEL=$(jq --raw-output '.LOG_LEVEL' /data/options.json)
export AUTO_CREATE_ROOT_RECORDS=$(jq --raw-output '.AUTO_CREATE_ROOT_RECORDS' /data/options.json)

# Start the application
node dist/index.js
