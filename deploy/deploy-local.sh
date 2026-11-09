#!/usr/bin/env bash
set -euo pipefail

ROOT=/opt/bank-lab
SOURCE="${GITHUB_WORKSPACE:?Missing GITHUB_WORKSPACE}"
SHA="${GITHUB_SHA:?Missing GITHUB_SHA}"
RELEASE="$ROOT/releases/frontend-$SHA"

exec 9>"$ROOT/deploy.lock"
flock -w 3600 9

# The backend must be bootstrapped first.
docker network inspect bank-lab >/dev/null

mkdir -p "$RELEASE"
git -C "$SOURCE" archive "$SHA" | tar -x -C "$RELEASE"

cd "$RELEASE"

docker build \
  --secret id=app_env,src="$ROOT/secrets/frontend.env" \
  -f Dockerfile.local \
  -t "bank-web:$SHA" \
  .

cat > compose.frontend.yml <<'YAML'
services:
  frontend:
    image: bank-web:${RELEASE_SHA}
    restart: unless-stopped
    env_file:
      - /opt/bank-lab/secrets/frontend.env
    ports:
      - "${LAB_HOST}:3000:3000"
    networks:
      - bank

networks:
  bank:
    external: true
    name: bank-lab
YAML

export RELEASE_SHA="$SHA"

# Only read the non-secret host value needed for port binding.
export LAB_HOST
LAB_HOST="$(sed -n 's/^LAB_HOST=//p' \
  "$ROOT/secrets/backend.env")"

test -n "$LAB_HOST"

docker compose \
  --project-name bank-frontend \
  -f compose.frontend.yml \
  up -d --wait --wait-timeout 180

# NextAuth's provider endpoint should respond once the app starts.
curl --fail --silent --show-error \
  --retry 30 --retry-all-errors --retry-delay 5 \
  --max-time 10 \
  "http://$LAB_HOST:3000/api/auth/providers" \
  >/dev/null

printf '%s\n' "$SHA" > "$ROOT/frontend-current"
echo "Frontend deployment completed."
