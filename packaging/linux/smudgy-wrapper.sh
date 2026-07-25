#!/bin/sh
# smudgy Flatpak launch wrapper (installed as /app/bin/smudgy; the real binary is
# /app/bin/smudgy.bin).
#
# On the host, smudgy stores its data (profiles, maps, scripts, logs) under
# <Documents>/smudgy, resolved via dirs::document_dir(). Inside the Flatpak
# sandbox that resolution is unreliable (no ~/.config/user-dirs.dirs), so we pass
# the app's --data-dir flag explicitly and point it at the host's
# ~/Documents/smudgy — the same location the Windows and macOS builds use. The
# manifest exposes exactly that subdirectory with
# --filesystem=xdg-documents/smudgy:create.
#
# Flatpak exports XDG_DOCUMENTS_DIR into the sandbox for a granted xdg-documents
# dir; the fallback keeps the wrapper working if it is ever unset.
set -eu

docs="${XDG_DOCUMENTS_DIR:-$HOME/Documents}"
exec /app/bin/smudgy.bin --data-dir="${docs}/smudgy" "$@"
