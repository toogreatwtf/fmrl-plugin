#!/usr/bin/env bash
# Prints release notes for fmrl-mcp <version> as Markdown: the pull requests
# merged to main that touched packages/mcp since the previous published
# version, up to <commit>.
#
#   .github/scripts/release-notes.sh <version> <commit>
#
# The previous version is the highest one on npm below <version> whose
# gitHead (the commit npm recorded for the publish) is an ancestor of
# <commit>. Going by npm rather than by git tags means the notes come out
# right even while older releases have no tag. Needs full git history
# (fetch-depth: 0), curl and jq.
set -euo pipefail

version="${1:?usage: release-notes.sh <version> <commit>}"
head="${2:?usage: release-notes.sh <version> <commit>}"

packument="$(curl -fsS https://registry.npmjs.org/fmrl-mcp)"

prev=""
prev_sha=""
while read -r v; do
  [ -n "$v" ] || continue
  [ "$v" != "$version" ] || continue
  # Only versions below this one.
  lowest="$(printf '%s\n%s\n' "$v" "$version" | sort -V | head -n1)"
  [ "$lowest" = "$v" ] || continue
  sha="$(jq -r --arg v "$v" '.versions[$v].gitHead // empty' <<<"$packument")"
  if [ -n "$sha" ] && git merge-base --is-ancestor "$sha" "$head" 2>/dev/null; then
    prev="$v"
    prev_sha="$sha"
    break
  fi
done < <(jq -r '.versions | keys[]' <<<"$packument" | sort -rV)

if [ -n "$prev_sha" ]; then
  range="${prev_sha}..${head}"
else
  range="$head"
fi

lines=()
while read -r sha; do
  [ -n "$sha" ] || continue
  subject="$(git log -1 --format=%s "$sha")"
  # A merge commit's subject is "Merge pull request #N from owner/branch";
  # the PR's title is the first line of its body.
  if [[ "$subject" =~ ^Merge\ pull\ request\ \#([0-9]+) ]]; then
    title="$(git log -1 --format=%b "$sha" | sed -n '/./{p;q;}')"
    subject="${title:-$subject} (#${BASH_REMATCH[1]})"
  fi
  lines+=("- ${subject}")
done < <(git log --first-parent --format=%H "$range" -- packages/mcp)

echo "## fmrl-mcp ${version}"
echo
if [ -n "$prev" ]; then
  echo "Changes since ${prev}:"
else
  echo "Changes:"
fi
echo
if [ "${#lines[@]}" -eq 0 ]; then
  echo "- No changes under packages/mcp."
else
  printf '%s\n' "${lines[@]}"
fi
echo
echo "npm: https://www.npmjs.com/package/fmrl-mcp/v/${version}"
