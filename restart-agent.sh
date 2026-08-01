#!/bin/sh
# Restart the todo-agent node process, inheriting the env (API key/model/etc.)
# from the currently-running instance so we don't have to re-supply secrets.
set -e
OLDPID=$(pgrep -f "node dist/index.js" | head -1 || true)
if [ -n "$OLDPID" ] && [ -r "/proc/$OLDPID/environ" ]; then
  # Persist the live env to a file, one KEY=VALUE per line (NUL-delimited source).
  tr '\0' '\n' < "/proc/$OLDPID/environ" \
    | grep -E '^(PORT|LLM_PROVIDER|PI_CODING_AGENT_DIR|OPENROUTER_API_KEY|OPENROUTER_MODEL|ANTHROPIC_API_KEY|ANTHROPIC_MODEL|SPEC_VERBOSITY|USER_CONTEXT)=' \
    > /root/agent.env
fi
pkill -f "node dist/index.js" 2>/dev/null || true
sleep 1
cd /data/agent
# Load env safely (handles spaces in values) and launch detached.
set -a; . /root/agent.env; set +a
nohup node dist/index.js > /data/logs/agent.log 2>&1 &
sleep 2
echo "restarted pid=$(pgrep -f 'node dist/index.js' | head -1)"
echo "provider=$LLM_PROVIDER model=${OPENROUTER_MODEL:-$ANTHROPIC_MODEL}"
