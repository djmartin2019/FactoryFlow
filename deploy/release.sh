#!/usr/bin/env bash
# Build FactoryFlow and stage an immutable release. Idempotent; never touches the live site
# until you pass --switch.
#
#   Local machine:   ./deploy/release.sh                 -> builds + validates + writes ./release/<id>.tar.gz
#   On the VPS:      ./deploy/release.sh --install <tar> [--switch]
#
# Env: APP_ROOT (default /var/www/factoryflow), KEEP (releases to retain, default 3)
set -euo pipefail

APP_ROOT="${APP_ROOT:-/var/www/factoryflow}"
KEEP="${KEEP:-3}"
# Only these data files are fetched by the browser; the rest of data/ is dev/test material.
REQUIRED_DATA=(initial_state.json events.json)
KEEP_DATA=(initial_state.json events.json manifest.json)

build() {
  command -v node >/dev/null || { echo "node not found" >&2; exit 1; }
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || { echo "Node 22+ required" >&2; exit 1; }
  [ -z "$(git status --porcelain)" ] || { echo "Working tree is dirty; commit first so the release is reproducible." >&2; exit 1; }

  npm ci
  npm run typecheck
  npm run typecheck:app
  npm test
  npm run validate:data
  npm run build

  # Prune data the browser never requests, keeping real files only.
  for f in dist/data/*; do
    name="$(basename "$f")"
    keep=0; for k in "${KEEP_DATA[@]}"; do [ "$k" = "$name" ] && keep=1; done
    [ "$keep" = 1 ] || rm -f "$f"
  done
  for f in "${REQUIRED_DATA[@]}"; do [ -s "dist/data/$f" ] || { echo "missing dist/data/$f" >&2; exit 1; }; done
  [ -s dist/index.html ] || { echo "dist/index.html missing" >&2; exit 1; }

  id="$(date -u +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"
  mkdir -p release
  tar -czf "release/$id.tar.gz" -C dist .
  echo "Built release/$id.tar.gz"
}

install_release() {
  tarball="$1"; switch="${2:-}"
  [ -f "$tarball" ] || { echo "no such file: $tarball" >&2; exit 1; }
  id="$(basename "$tarball" .tar.gz)"
  dest="$APP_ROOT/releases/$id"
  [ ! -e "$dest" ] || { echo "$dest already exists; releases are immutable" >&2; exit 1; }
  mkdir -p "$dest"
  tar -xzf "$tarball" -C "$dest"
  for f in index.html data/initial_state.json data/events.json; do
    [ -s "$dest/$f" ] || { echo "release is missing $f" >&2; rm -rf "$dest"; exit 1; }
  done
  find "$dest" -type d -exec chmod 755 {} +
  find "$dest" -type f -exec chmod 644 {} +
  echo "Staged $dest"

  if [ "$switch" = "--switch" ]; then
    ln -sfn "$dest" "$APP_ROOT/current.new"
    mv -Tf "$APP_ROOT/current.new" "$APP_ROOT/current"   # atomic
    echo "current -> $dest"
    # prune old releases, keeping the newest $KEEP (never the live one)
    ls -1dt "$APP_ROOT"/releases/*/ | tail -n +"$((KEEP + 1))" | while read -r old; do
      [ "$(readlink -f "$APP_ROOT/current")" = "$(readlink -f "$old")" ] || rm -rf "$old"
    done
  else
    echo "Not switched. Verify, then re-run with --switch (or: ln -sfn $dest $APP_ROOT/current)."
  fi
}

case "${1:-}" in
  --install) install_release "${2:?tarball path required}" "${3:-}" ;;
  "") build ;;
  *) echo "usage: $0 | $0 --install <tarball> [--switch]" >&2; exit 2 ;;
esac
