#!/usr/bin/env bash
# Actions minutes this month, per repository and workflow, across your repos.
#
#   ops/actions-usage.sh            # all your private, non-archived repos
#   ops/actions-usage.sh repo1 ...  # only these repos (owner taken from gh)
#
# Only private repositories count against the plan's included minutes;
# public ones on standard runners are free. GitHub bills each job rounded up
# to the whole minute, so a 20-second job is a minute. The figures here are
# that estimate from run start and end times (most workflows here are one
# job); github.com/settings/billing/usage is the exact number.
#
# Needs: gh (logged in), jq. Reads only.
set -euo pipefail

owner=$(gh api user --jq .login)
since=$(date -u +%Y-%m-01)

if [ "$#" -gt 0 ]; then
  repos=("$@")
else
  mapfile -t repos < <(gh repo list "$owner" --visibility private --no-archived \
    --limit 200 --json name --jq '.[].name')
fi

{
  for repo in "${repos[@]}"; do
    gh api --paginate "repos/$owner/$repo/actions/runs?created=>=$since&per_page=100" \
      --jq '.workflow_runs[] | select(.run_started_at != null)
            | [.name, .run_started_at, .updated_at] | @tsv' 2>/dev/null |
      while IFS=$'\t' read -r name start end; do
        s=$(( $(date -u -d "$end" +%s) - $(date -u -d "$start" +%s) ))
        printf '%s\t%s\t%d\n' "$repo" "$name" $(( s <= 0 ? 1 : (s + 59) / 60 ))
      done
  done
} | awk -F'\t' '
  { runs[$1 FS $2]++; mins[$1 FS $2] += $3; total += $3 }
  END {
    printf "%-22s %-24s %6s %8s\n", "repo", "workflow", "runs", "~minutes"
    for (k in mins) { split(k, p, FS); printf "%-22s %-24s %6d %8d\n", p[1], p[2], runs[k], mins[k] | "sort -k4 -nr" }
    close("sort -k4 -nr")
    printf "\ntotal ~%d minutes since the 1st (plan includes 2,000)\n", total
  }'
