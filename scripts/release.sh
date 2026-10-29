#!/bin/bash
# Release workwith: typecheck, build, tag the next v* and push main and the tag. Agent hosts on
# the stable channel move to it with `agentctl fleet-apply` (agents-toolkit), one at a time,
# each with a health check and rollback.
#
#   scripts/release.sh            next minor (v0.3.0 after v0.2.4)
#   scripts/release.sh patch      next patch (v0.2.5)
#   scripts/release.sh v1.0.0     exactly that tag
set -euo pipefail
cd "$(dirname "$0")/.."
die() { echo "release: $*" >&2; exit 1; }

[ -z "$(git status --porcelain)" ] || die "uncommitted changes; commit or stash them first"
[ "$(git branch --show-current)" = main ] || die "on $(git branch --show-current), not main"
git fetch -q --tags origin
git merge-base --is-ancestor origin/main HEAD || die "origin/main has commits this branch doesn't; pull first"

last=$(git tag -l 'v*' --sort=-v:refname | head -1)
last=${last:-v0.0.0}
[ "$(git rev-list -n1 "$last" 2>/dev/null)" != "$(git rev-parse HEAD)" ] || die "HEAD is already $last"
IFS=. read -r maj min pat <<< "${last#v}"
case "${1:-minor}" in
  patch) next="v$maj.$min.$((pat + 1))" ;;
  minor) next="v$maj.$((min + 1)).0" ;;
  major) next="v$((maj + 1)).0.0" ;;
  v[0-9]*.[0-9]*.[0-9]*) next=$1 ;;
  *) die "usage: scripts/release.sh [patch|minor|major|vX.Y.Z]" ;;
esac
! git rev-parse -q --verify "refs/tags/$next" >/dev/null || die "$next already exists"

npm ci --no-audit --no-fund --loglevel=error
npm run typecheck
npm run build

notes=$(git log --no-merges --format='- %s' "$last..HEAD" 2>/dev/null | cut -c1-160 | head -80 || true)
git tag -a "$next" -m "$next" -m "${notes:-(first release)}"
git push -q origin main "$next"
echo "released $next ($(git rev-parse --short HEAD)). Hosts: agentctl fleet-status, then agentctl fleet-apply"
