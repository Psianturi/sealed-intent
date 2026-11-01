#!/usr/bin/env bash
# Proves that an agent running as its own OS user cannot reach the money path:
# no custody key in its environment, no access to the checker's files or process, no owner powers.
# Linux only, run as root. Creates two throwaway users and removes them afterwards.
#   sudo env "PATH=$PATH" bash scripts/isolation-check.sh
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "run as root"; exit 2; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$REPO/pnpm-workspace.yaml" ] && [ -f "$REPO/scripts/isolation-probe.mjs" ] || { echo "run this from the repository, not a copy: $REPO is not the repo root"; exit 2; }
[ -x "$REPO/node_modules/.bin/tsx" ] || { echo "run pnpm install first"; exit 2; }
NODE="$(command -v node)"
NODE_DIR="$(dirname "$NODE")"
WORK="$(mktemp -d /tmp/sein-iso.XXXXXX)"
SVC=sein-iso-svc
AGENT=sein-iso-agent
PORT=8799
SERVER_PID=""

cleanup() {
  pkill -u "$SVC" 2>/dev/null || true
  sleep 0.2
  userdel "$SVC" 2>/dev/null || true
  userdel "$AGENT" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC" 2>/dev/null || true
useradd --system --no-create-home --shell /usr/sbin/nologin "$AGENT" 2>/dev/null || true

# the code is readable by everyone; the state belongs to the checker alone
chmod 755 "$WORK"
mkdir -p "$WORK/code" "$WORK/state" "$WORK/agent"
tar -C "$REPO" --one-file-system --exclude=./.git --exclude=./.env --exclude=./.sealed --exclude=./out --exclude=./replays --exclude=./apps/web/dist -cf - . | tar -C "$WORK/code" -xf -
chmod -R a+rX "$WORK/code"
chown "$AGENT" "$WORK/agent"

AGENT_TOKEN="agent-$(openssl rand -hex 16)"
OWNER_TOKEN="owner-$(openssl rand -hex 16)"
(
  umask 077
  cat > "$WORK/state/.env" <<EOF
OUTLAYER_API_KEY=isolation-check-not-a-real-key
SEALED_POLICY_KEY=$(openssl rand -hex 32)
SEALED_OWNER_TOKEN=$OWNER_TOKEN
SEALED_AGENT_TOKENS=$AGENT_TOKEN=iso-agent
EOF
)
chown -R "$SVC" "$WORK/state"
chmod 700 "$WORK/state"

echo "starting the checker as $SVC"
(cd "$WORK/state" && exec runuser -u "$SVC" -- env -i PATH="$NODE_DIR:/usr/bin:/bin" HOME="$WORK/state" PORT="$PORT" "$WORK/code/node_modules/.bin/tsx" "$WORK/code/apps/server/src/rest.ts" > "$WORK/server.log" 2>&1) &
for _ in $(seq 1 60); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/health" && break
  sleep 0.5
done
curl -s -o /dev/null "http://127.0.0.1:$PORT/health" || { echo "the checker did not start"; cat "$WORK/server.log"; exit 1; }
SERVER_PID="$(pgrep -u "$SVC" -f "apps/server/src/rest.ts" | head -1)"
[ -n "$SERVER_PID" ] || { echo "no checker process found"; exit 1; }

echo "probing as $AGENT"
(cd "$WORK/agent" && runuser -u "$AGENT" -- env -i \
  PATH="$NODE_DIR:/usr/bin:/bin" HOME="$WORK/agent" \
  SEALED_REST_URL="http://127.0.0.1:$PORT" SEALED_AGENT_TOKEN="$AGENT_TOKEN" \
  ISO_STATE="$WORK/state" ISO_PID="$SERVER_PID" ISO_CODE="$WORK/code" \
  "$NODE" "$WORK/code/scripts/isolation-probe.mjs")

# positive control: the same requests work with the owner's token, which the agent never saw
status="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $OWNER_TOKEN" "http://127.0.0.1:$PORT/v1/pending")"
[ "$status" = 200 ] || { echo "FAIL  owner token should open /v1/pending, got $status"; exit 1; }
echo "PASS  the owner's token still works (control)"
if grep -q "$OWNER_TOKEN\|isolation-check-not-a-real-key" "$WORK/server.log"; then echo "FAIL  a secret reached the server log"; exit 1; fi
echo "PASS  no secret in the server log"
echo "isolation check passed"
