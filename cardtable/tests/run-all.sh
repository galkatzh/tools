#!/bin/bash
# Runs the ES-module parse check, then every t-*.js suite in parallel (each
# suite has its own relay and server ports). Logs go to out/.
#   $1                   optional suite-name filter: ./run-all.sh holdem
#   APP_ROOT             repo checkout to serve (default: this one)
#   JOBS                 suites at once (default: 2 per CPU; each drives a Chromium)
#   CARDTABLE_TEST_LOCK  lock file (default /tmp/cardtable-tests.lock)
cd "$(dirname "$0")" || exit 2
mkdir -p out
# One full run at a time machine-wide (every worktree shares the lock):
# concurrent runs would starve each other into flaky timeouts. Others queue here.
exec 9>"${CARDTABLE_TEST_LOCK:-/tmp/cardtable-tests.lock}"
flock 9
echo "[run-all] APP_ROOT=${APP_ROOT:-$(cd ../.. && pwd)}"
node --experimental-vm-modules parse.js || exit 1
suites=(t-*"$1"*.js)
[ -e "${suites[0]}" ] || { echo "no suite matches '$1'"; exit 2; }
max=${JOBS:-$(($(nproc) * 2))}
for t in "${suites[@]}"; do
  while [ "$(jobs -rp | wc -l)" -ge "$max" ]; do wait -n; done
  n=${t%.js}
  (timeout 600 node "$t" > "out/$n.$$.log" 2>&1; echo $? > "out/$n.$$.rc") &
done
wait
fail=0
for t in "${suites[@]}"; do
  n=${t%.js}
  rc=$(cat "out/$n.$$.rc")
  if [ "$rc" = 0 ]; then echo "PASS  $n"; continue; fi
  fail=1
  echo "FAIL(rc=$rc)  $n"
  grep -E "✗|PAGEERROR|CRASH" "out/$n.$$.log" | head -15 | sed 's/^/      /'
  echo "      log: $PWD/out/$n.$$.log"
done
rm -f out/*.$$.rc
exit $fail
