#!/bin/bash
set -eu

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
sed "s|/data/options.json|$scratch/options.json|g" "$(dirname "$0")/../run.sh" > "$scratch/run.sh"
cat > "$scratch/node" <<'EOF'
#!/bin/bash
set -eu
[ "$*" = "dist/index.js" ]
[ "$CF_API_TOKEN" = "$EXPECTED_TOKEN" ]
[ "$NPM_PASSWORD" = "$EXPECTED_PASSWORD" ]
[ "$CHECK_INTERVAL" = "10000" ]
[ "$AUTO_CREATE_ROOT_RECORDS" = "false" ]
touch "$STARTED"
EOF
chmod +x "$scratch/node"
export PATH="$scratch:$PATH" STARTED="$scratch/started"
export CF_API_TOKEN="docker-token" NPM_PASSWORD='docker password $with "quotes"'
export CHECK_INTERVAL=10000 AUTO_CREATE_ROOT_RECORDS=false
export EXPECTED_TOKEN="$CF_API_TOKEN" EXPECTED_PASSWORD="$NPM_PASSWORD"
bash "$scratch/run.sh"
[ -f "$STARTED" ]
rm "$STARTED"

cat > "$scratch/options.json" <<'EOF'
{"CF_API_TOKEN":"ha-token","CF_EMAIL":"cf@example.test","NPM_API_URL":"http://npm:81","NPM_EMAIL":"npm@example.test","NPM_PASSWORD":"ha password $with \"quotes\"","CHECK_INTERVAL":10000,"LOG_LEVEL":"info","AUTO_CREATE_ROOT_RECORDS":false}
EOF
export EXPECTED_TOKEN=ha-token EXPECTED_PASSWORD='ha password $with "quotes"'
bash "$scratch/run.sh"
[ -f "$STARTED" ]
rm "$STARTED"

printf '{invalid' > "$scratch/options.json"
if bash "$scratch/run.sh" 2>/dev/null; then
  echo 'Malformed options must stop startup' >&2
  exit 1
fi
[ ! -f "$STARTED" ]
echo 'Startup tests passed'
