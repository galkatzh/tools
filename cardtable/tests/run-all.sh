#!/bin/bash
# Runs the ES-module parse check, then every suite: the t-*.js suites and the
# Node-only *.test.mjs ones in parallel (each suite has its own relay and
# server ports), then the SERIAL ones (benchmarks, and suites with a timing
# budget) one at a time, still under the lock: their timings need a machine
# nothing else is loading. Logs go to out/<suite>.log, overwritten by the next
# run (the lock keeps runs from sharing them).
#   $1                   optional suite-name filter: ./run-all.sh holdem
#   APP_ROOT             repo checkout to serve (default: this one)
#   JOBS                 suites at once (default: 2 per CPU; each drives a Chromium)
#   SERIAL               the suites run alone, after the others, comma-separated
#                        names (default: t-p1-bench,core-p1-bench,core-p2-bench,core-p4-bench,t-p1-flood,t-p1-assets,t-p3-go,t-p4-bench,t-p4-box-bench,t-p4-resume-bench,t-p4-hexfront,t-p4-hex-bench,t-p4-select,t-p4-gflood,core-p5.test)
#   CARDTABLE_TEST_LOCK  lock file (default /tmp/cardtable-tests.lock)
cd "$(dirname "$0")" || exit 2
mkdir -p out
# One full run at a time machine-wide (every worktree shares the lock):
# concurrent runs would starve each other into flaky timeouts. Others queue here.
exec 9>"${CARDTABLE_TEST_LOCK:-/tmp/cardtable-tests.lock}"
flock 9
echo "[run-all] APP_ROOT=${APP_ROOT:-$(cd ../.. && pwd)}"
node --experimental-vm-modules parse.js || exit 1
shopt -s nullglob
IFS=, read -ra names <<< "${SERIAL-t-p1-bench,core-p1-bench,core-p2-bench,core-p4-bench,t-p1-flood,t-p1-assets,t-p3-go,t-p4-bench,t-p4-box-bench,t-p4-resume-bench,t-p4-hexfront,t-p4-hex-bench,t-p4-select,t-p4-gflood,core-p5.test}"
serial=() missing=()
for n in "${names[@]}"; do
  [[ $n == *"$1"* ]] || continue
  if [ -e "$n.js" ]; then serial+=("$n.js"); elif [ -e "$n.mjs" ]; then serial+=("$n.mjs"); else missing+=("$n"); fi
done
suites=()
for t in t-*"$1"*.js *"$1"*.test.mjs; do
  [[ " ${serial[*]} " == *" $t "* ]] || suites+=("$t")
done
[ $((${#suites[@]} + ${#serial[@]} + ${#missing[@]})) -gt 0 ] || { echo "no suite matches '$1'"; exit 2; }
max=${JOBS:-$(($(nproc) * 2))}
for t in "${suites[@]}"; do
  while [ "$(jobs -rp | wc -l)" -ge "$max" ]; do wait -n; done
  n=${t%.*}
  (timeout 600 node "$t" > "out/$n.log" 2>&1; echo $? > "out/$n.rc") &
done
wait
for t in "${serial[@]}"; do
  n=${t%.*}
  timeout 600 node "$t" > "out/$n.log" 2>&1
  echo $? > "out/$n.rc"
done
fail=0
for n in "${missing[@]}"; do
  fail=1
  echo "FAIL  $n: SERIAL lists it, but there is no $n.js or $n.mjs"
done
for t in "${suites[@]}" "${serial[@]}"; do
  n=${t%.*}
  rc=$(cat "out/$n.rc")
  if [ "$rc" = 0 ]; then echo "PASS  $n"; continue; fi
  fail=1
  echo "FAIL(rc=$rc)  $n"
  grep -E "✗|PAGEERROR|CRASH" "out/$n.log" | head -15 | sed 's/^/      /'
  echo "      log: $PWD/out/$n.log"
done
exit $fail
