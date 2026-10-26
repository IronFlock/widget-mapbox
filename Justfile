# The recipes the CI gate runs and the release, the same in every widget
# repository (IronFlock/widget-*) but for RELEASE_NAME.

# The package name without its scope; the tags are bare versions (1.0.10).
RELEASE_NAME := "widget-mapbox"
VERSION_FILE := "package.json"
# Every file _write-version changes; the release commit holds exactly these.
VERSION_FILES := "package.json package-lock.json"

# Generated files are committed (`npm run types`, and `catalog` where it
# exists): regenerating them must change nothing, also next to uncommitted
# work.
#
# Lint as CI runs it: the generated files are current
lint:
    #!/usr/bin/env bash
    set -euo pipefail
    before=$(git diff | git hash-object --stdin)
    for gen in types catalog; do
        if [ -n "$(jq -r --arg g "$gen" '.scripts[$g] // empty' package.json)" ]; then
            npm run --silent "$gen"
        fi
    done
    if [ "$(git diff | git hash-object --stdin)" != "$before" ]; then
        echo "generated files were stale (now regenerated): commit them" >&2
        git diff --stat >&2
        exit 1
    fi

# Build the widget bundle (dist/)
build:
    npm run build

# ------------------------------------------------------------------ release --
# Pull requests into main, from IronFlock/workflows (scripts/pr.sh at v1); see
# its README, "Pull requests from a laptop":
#   just merge [TITLE]      a no-release pull request from this feature branch
#   just release-patch      a release pull request (-minor, -major): the bump
#                           from main's version on top of this branch (or on a
#                           new branch release/<x> from an up-to-date main)
# Both merge automatically once ci and security are green. The merge of a
# release pull request runs .github/workflows/build-publish.yml: npm publish,
# then the tag <version> (release GitHub App), then the GitHub release.

# Writes the version; called by pr.sh with the next version.
_write-version version:
    npm version "{{version}}" --no-git-tag-version --allow-same-version

[positional-arguments]
_pr *args:
    #!/usr/bin/env bash
    set -euo pipefail
    script=$(mktemp)
    trap 'rm -f "$script"' EXIT
    gh api -H 'Accept: application/vnd.github.raw' \
        'repos/IronFlock/workflows/contents/scripts/pr.sh?ref=v1' > "$script"
    bash "$script" "$@"

[positional-arguments]
merge TITLE="":
    just _pr merge {{VERSION_FILE}} "$1"

release-patch:
    TAG_PREFIX= just _pr release patch {{RELEASE_NAME}} {{VERSION_FILE}} build-publish.yml {{VERSION_FILES}}

release-minor:
    TAG_PREFIX= just _pr release minor {{RELEASE_NAME}} {{VERSION_FILE}} build-publish.yml {{VERSION_FILES}}

release-major:
    TAG_PREFIX= just _pr release major {{RELEASE_NAME}} {{VERSION_FILE}} build-publish.yml {{VERSION_FILES}}
