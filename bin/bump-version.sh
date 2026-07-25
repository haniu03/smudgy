#!/usr/bin/env bash
# Bump the smudgy version everywhere it lives.
#
# Usage: bin/bump-version.sh <new-version>
#
# <new-version> is a full semver string: MAJOR.MINOR.PATCH with an optional
# `-prerelease` and/or `+build` suffix (e.g. 0.3.2, 0.4.0-beta, 0.4.0-rc.1+ci).
#
# The suffix picks one of three build channels (mirrors core's `build_channel`),
# all derived at compile time from the version — this script does not edit
# settings.rs:
#   - clean X.Y.Z              -> release: prod API, smudgy/ data, bare title.
#   - prerelease starting `rc` -> release candidate: behaves like a release
#       (prod API, smudgy/ data) but raises no upgrade notifications and is
#       tagged "RELEASE CANDIDATE <version>" so a tester knows which one they run
#       (e.g. 0.3.2-rc1, 0.4.0-rc19-the-final-final).
#   - any other suffix         -> dev/pre-release: dev API, smudgy-dev/ data,
#       "DEV BUILD" title (e.g. 0.4.0-beta).
# So bumping the version is all that's needed to retarget a build at a channel.
#
# Updates (in the smudgy repo):
#   - every smudgy_* crate's Cargo.toml        (lock-step [package] versions:
#       ui core cloud script map_widget theme widgets inspector bench)
#   - assets/installer.iss                     (MyAppVersion)
#   - CHANGELOG.md                             (stamps "## [<version>] - Unreleased" with today's date)
#   - Cargo.lock                               (refreshed via cargo metadata)
#
# Updates (in the sibling smudgy-web repo, if present):
#   - terraform/smudgy-web.tf                  (newest_client_version, the soft "upgrade available" nudge)
#     Override the repo location with SMUDGY_WEB_DIR; skipped with a warning if not found.
#
# The script edits files only; review and commit the result yourself (note the
# smudgy-web change is a *separate* repo and needs its own commit).

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ $# -ne 1 ]]; then
    echo "Usage: $0 <new-version>" >&2
    exit 1
fi

NEW_VERSION="$1"

# Full semver: X.Y.Z with optional -prerelease and/or +build. POSIX ERE (no
# non-capturing groups), so groups 1/2 capture the prerelease/build suffixes.
SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
if ! [[ "$NEW_VERSION" =~ $SEMVER_RE ]]; then
    echo "error: '$NEW_VERSION' is not a valid semver version (X.Y.Z, optional -prerelease / +build)" >&2
    exit 1
fi
PRERELEASE="${BASH_REMATCH[1]}"   # includes leading '-', empty if none
BUILD="${BASH_REMATCH[2]}"        # includes leading '+', empty if none

# Pick the build channel from the suffix (mirrors core's `build_channel`). A
# prerelease whose first identifier is `rc` is a release candidate (prod-like);
# the `rc` must end at the first '-', '.', '+', or digit so words like "release"
# / "rcedar" don't read as a candidate. Any other suffix is dev; a clean X.Y.Z
# is a prod release.
PRE_ID="${PRERELEASE#-}"          # prerelease without the leading '-', empty if none
if [[ "$PRE_ID" =~ ^[Rr][Cc]($|[-.+0-9]) ]]; then
    API_BASE_URL="https://api.smudgy.org"
    CHANNEL="release-candidate"
elif [[ -n "$PRERELEASE" || -n "$BUILD" ]]; then
    API_BASE_URL="https://api.dev.smudgy.org"
    CHANNEL="dev / pre-release"
else
    API_BASE_URL="https://api.smudgy.org"
    CHANNEL="prod / release"
fi

# Escape a string's regex-special dots for safe use as a sed/grep BRE pattern.
# (In BRE, '+' and '-' are literal — and GNU sed treats '\+' as a quantifier —
# so dots are the only semver character that needs escaping.)
escape_re() { printf '%s' "$1" | sed 's/\./\\./g'; }

CURRENT_VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' ui/Cargo.toml | head -1)

if [[ -z "$CURRENT_VERSION" ]]; then
    echo "error: could not read current version from ui/Cargo.toml" >&2
    exit 1
fi

if [[ "$NEW_VERSION" == "$CURRENT_VERSION" ]]; then
    echo "error: version is already $CURRENT_VERSION" >&2
    exit 1
fi

NEW_RE=$(escape_re "$NEW_VERSION")

echo "Bumping $CURRENT_VERSION -> $NEW_VERSION"
echo "  channel: $CHANNEL (build will default to $API_BASE_URL)"

# Crate package versions, kept in lock-step: every smudgy_* crate carries the same
# version (ui's is the source of truth the client sends as X-Smudgy-Client-Version).
# The set has historically drifted — widgets, inspector, and bench lagged behind — so
# replace each manifest's FIRST `version = "..."` line (the [package] version, which
# precedes any dependency requirement) regardless of its current value, rather than
# anchoring on ui's old version (which would silently skip a lagging crate).
#
# Use awk, not `sed -i '0,/re/s//.../'`: the `0,/re/` first-match address is a GNU sed
# extension. It works under Git Bash on Windows but on macOS/BSD sed it silently matches
# nothing — no error, exit 0, no edit — so every crate stayed unbumped. awk's first-match
# flag is portable across both. Write to a temp file then mv (rather than piping through
# `&&`) so an awk failure trips `set -e` instead of being swallowed by the AND-list.
for manifest in ui/Cargo.toml core/Cargo.toml cloud/Cargo.toml script/Cargo.toml \
                map_widget/Cargo.toml theme/Cargo.toml widgets/Cargo.toml \
                inspector/Cargo.toml bench/Cargo.toml; do
    awk -v ver="$NEW_VERSION" '
        !bumped && /^version = ".*"/ { sub(/".*"/, "\"" ver "\""); bumped = 1 }
        { print }
    ' "$manifest" > "$manifest.tmp"
    mv "$manifest.tmp" "$manifest"
    echo "  $manifest"
done

# Inno Setup installer
sed -i.bak "s/^#define MyAppVersion \".*\"/#define MyAppVersion \"$NEW_VERSION\"/" assets/installer.iss
rm assets/installer.iss.bak
echo "  assets/installer.iss"

# CHANGELOG.md: stamp the unreleased section for this version, if present.
TODAY=$(date +%Y-%m-%d)
if grep -q "^## \[$NEW_RE\] - Unreleased" CHANGELOG.md; then
    sed -i.bak "s/^## \[$NEW_RE\] - Unreleased/## [$NEW_VERSION] - $TODAY/" CHANGELOG.md
    rm CHANGELOG.md.bak
    echo "  CHANGELOG.md (stamped $TODAY)"
else
    echo "  warning: CHANGELOG.md has no '## [$NEW_VERSION] - Unreleased' section; update it manually" >&2
fi

# Refresh Cargo.lock without building anything.
cargo metadata --format-version 1 > /dev/null
echo "  Cargo.lock"

# smudgy-web (separate repo): bump newest_client_version, the soft "upgrade
# available" nudge ceiling — but ONLY for a clean release. Advertising a
# dev/pre-release or release-candidate version as "newest" would nudge every
# prod client toward a pre-release, and a release candidate must raise no
# upgrade nags at all, so those channels skip the bump. min_client_version is
# always left alone (the hard 426 gate is rolled out by hand, prod-coordinated).
SMUDGY_WEB_DIR="${SMUDGY_WEB_DIR:-../smudgy-web}"
TF_FILE="$SMUDGY_WEB_DIR/terraform/smudgy-web.tf"
if [[ "$CHANNEL" != "prod / release" ]]; then
    echo "  (skipping smudgy-web newest_client_version bump for a $CHANNEL build)"
elif [[ -f "$TF_FILE" ]]; then
    sed -i.bak "s|^\( *newest_client_version *= *\"\)[^\"]*\(\"\)|\1$NEW_VERSION\2|" "$TF_FILE"
    rm "$TF_FILE.bak"
    echo "  $TF_FILE (newest_client_version -> $NEW_VERSION; review the nearby comment)"
else
    echo "  warning: $TF_FILE not found; skipped newest_client_version bump" >&2
    echo "           (set SMUDGY_WEB_DIR if the smudgy-web repo lives elsewhere)" >&2
fi

echo
echo "Done. Review with: git diff"
echo "Then commit the smudgy repo:   git commit -am \"chore: bump version to $NEW_VERSION\""
if [[ "$CHANNEL" == "prod / release" && -f "$TF_FILE" ]]; then
    echo "And commit smudgy-web separately (different repo):"
    echo "  (cd \"$SMUDGY_WEB_DIR\" && git commit -am \"chore: newest_client_version -> $NEW_VERSION\")"
fi
