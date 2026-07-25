#!/usr/bin/env bash
# Publish a release binary to DokuWiki's media store over SSH (scp).
#
# Why not the JSON-RPC media API? core.saveMedia carries the file base64-encoded
# inside a JSON body, and DokuWiki's PHP memory_limit is exhausted decoding
# anything sizeable (a 38MB bundle 500s with "Allowed memory size exhausted").
# Dropping the file straight into DokuWiki's media directory has no such ceiling —
# DokuWiki serves on-disk media directly via fetch.php?media=<ns>:<file>.
#
# Config (env; in CI, from GitHub secrets):
#   SMUDGY_WIKI_SSH         user@host of the wiki server, e.g. deploy@smudgy.org   [required]
#   SMUDGY_WIKI_MEDIA_DIR   absolute path to DokuWiki's data/media on the server,
#                           e.g. /var/www/smudgy.org/dokuwiki/data/media           [required]
#   SMUDGY_WIKI_SSH_PORT    ssh port (default 22)
#   SMUDGY_WIKI_SSH_KEYFILE private-key file to auth with (optional; else your
#                           ssh-agent / default keys / ssh config are used)
#   SMUDGY_WIKI_URL         if set, HEAD the public fetch.php URL afterwards to
#                           verify the upload is actually downloadable
#
# Usage: bin/dokuwiki-upload.sh <local-file> <media-id>
#   <media-id>  ':'-separated DokuWiki media id, e.g.
#               download:smudgy-v0.3.6-x86_64.flatpak
set -euo pipefail

file="${1:?usage: bin/dokuwiki-upload.sh <local-file> <media-id>}"
media="${2:?usage: bin/dokuwiki-upload.sh <local-file> <media-id>}"
[[ -f "$file" ]] || { echo "error: no such file: $file" >&2; exit 1; }
: "${SMUDGY_WIKI_SSH:?set SMUDGY_WIKI_SSH to user@host of the wiki server}"
: "${SMUDGY_WIKI_MEDIA_DIR:?set SMUDGY_WIKI_MEDIA_DIR to the DokuWiki data/media path}"
port="${SMUDGY_WIKI_SSH_PORT:-22}"

# DokuWiki stores media as files under data/media/<namespace path>/<file>, the
# id's ':' separators becoming '/'. Refuse anything that could escape the tree.
case "$media" in
    *..* | /* | *:) echo "error: invalid media id: $media" >&2; exit 1 ;;
esac
rel="${media//://}"                                  # download:foo.flatpak -> download/foo.flatpak
remote_dir="$SMUDGY_WIKI_MEDIA_DIR/$(dirname "$rel")"
remote_path="$SMUDGY_WIKI_MEDIA_DIR/$rel"

# ssh takes -p for the port, scp takes -P — hence two arrays. accept-new pins the
# host key on first connect (store a known_hosts secret for stricter checking).
opts=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new)
[[ -n "${SMUDGY_WIKI_SSH_KEYFILE:-}" ]] && opts+=(-i "$SMUDGY_WIKI_SSH_KEYFILE")

echo "==> uploading $(basename "$file") ($(du -h "$file" | cut -f1)) -> $SMUDGY_WIKI_SSH:$remote_path"
ssh "${opts[@]}" -p "$port" "$SMUDGY_WIKI_SSH" "mkdir -p -- '$remote_dir'"
scp "${opts[@]}" -P "$port" -- "$file" "$SMUDGY_WIKI_SSH:$remote_path"
# Make it web-readable and confirm it landed non-empty on the server.
ssh "${opts[@]}" -p "$port" "$SMUDGY_WIKI_SSH" "chmod 644 -- '$remote_path' && test -s '$remote_path'"
echo "==> placed on server: $remote_path"

# Optional end-to-end check: is it actually downloadable via the wiki?
if [[ -n "${SMUDGY_WIKI_URL:-}" ]]; then
    fetch="${SMUDGY_WIKI_URL%/}/lib/exe/fetch.php?media=$media"
    echo "==> verifying download: $fetch"
    if curl -fsSI "$fetch" >/dev/null 2>&1; then
        echo "==> verified downloadable: $media"
    else
        echo "warning: uploaded, but $fetch did not return OK — check the download namespace ACL (must be public-readable)" >&2
    fi
fi
echo "==> done: $media"
