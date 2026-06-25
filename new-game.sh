#!/usr/bin/env bash
# new-game.sh — scaffold a new game from this Pat_Engine baseline.
#
# Usage:
#   ./new-game.sh <name>           # creates ../<name>  (sibling of the engine)
#   ./new-game.sh <path/to/dir>    # creates the given path
#   ./new-game.sh <name> [--no-install] [--no-git] [--force]
#
# Copies engine/ editors/ server/ data/ game/ + docs into the target, excluding
# .git, node_modules, and data/.backups. Renames the package, runs `git init` +
# an initial commit, and `npm install` (the only dep is `ws`). Skip either with
# --no-git / --no-install. Refuses a non-empty target unless --force.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DO_INSTALL=1
DO_GIT=1
FORCE=0
TARGET_ARG=""

for arg in "$@"; do
  case "$arg" in
    --no-install) DO_INSTALL=0 ;;
    --no-git)     DO_GIT=0 ;;
    --force)      FORCE=1 ;;
    -h|--help)    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)           echo "Unknown option: $arg" >&2; exit 1 ;;
    *)            if [ -z "$TARGET_ARG" ]; then TARGET_ARG="$arg"; else echo "Unexpected argument: $arg" >&2; exit 1; fi ;;
  esac
done

if [ -z "$TARGET_ARG" ]; then
  echo "Usage: $0 <name|path> [--no-install] [--no-git] [--force]" >&2
  exit 1
fi

# A bare name (no path separators) lands next to the engine; a path is used as-is.
case "$TARGET_ARG" in
  */*|*\\*) DEST_RAW="$TARGET_ARG" ;;
  *)        DEST_RAW="$SRC/../$TARGET_ARG" ;;
esac

mkdir -p "$(dirname "$DEST_RAW")"
DEST_PARENT="$(cd "$(dirname "$DEST_RAW")" && pwd)"
NAME="$(basename "$DEST_RAW")"
DEST="$DEST_PARENT/$NAME"

if [ "$DEST" = "$SRC" ]; then
  echo "Target is the engine itself. Choose a different name/path." >&2
  exit 1
fi

# npm-safe package name from the folder name.
PKG_NAME="$(printf '%s' "$NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g; s/^[._-]*//')"
[ -z "$PKG_NAME" ] && PKG_NAME="my-game"

if [ -e "$DEST" ] && [ "$FORCE" -ne 1 ] && [ -n "$(ls -A "$DEST" 2>/dev/null || true)" ]; then
  echo "Target exists and is not empty: $DEST  (use --force to copy into it)" >&2
  exit 1
fi

echo "Scaffolding new game:"
echo "  from : $SRC"
echo "  to   : $DEST"
echo "  name : $PKG_NAME"

mkdir -p "$DEST"

# Copy the baseline, excluding VCS / deps / editor backups (portable: tar pipe).
tar -cf - \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./data/.backups' \
  -C "$SRC" . | tar -xf - -C "$DEST"

# Rename the package (portable sed via temp file).
PKG="$DEST/package.json"
if [ -f "$PKG" ]; then
  sed -E "s/\"name\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"name\": \"$PKG_NAME\"/" "$PKG" > "$PKG.tmp"
  mv "$PKG.tmp" "$PKG"
fi

# Fresh git history.
if [ "$DO_GIT" -eq 1 ] && command -v git >/dev/null 2>&1; then
  git -C "$DEST" init -q -b main 2>/dev/null || git -C "$DEST" init -q
  git -C "$DEST" add -A 2>/dev/null
  git -C "$DEST" commit -q -m "Initial commit: $PKG_NAME (scaffolded from Pat_Engine)" 2>/dev/null \
    && echo "  git  : initialized (branch main, initial commit)" \
    || echo "  git  : initialized (no commit — set git user.name/email, then commit)"
fi

# Install deps.
if [ "$DO_INSTALL" -eq 1 ] && command -v npm >/dev/null 2>&1; then
  echo "Installing dependencies (npm install)..."
  ( cd "$DEST" && npm install --silent ) || echo "npm install failed — run it manually in $DEST" >&2
fi

echo ""
echo "Done. Next:"
echo "  cd \"$DEST\""
[ "$DO_INSTALL" -eq 1 ] || echo "  npm install"
echo "  npm start        # http://localhost:6970  (editor: /editor)"
echo ""
echo "Make it yours: replace data/*.json and game/* — see AGENTS.md section 8."
