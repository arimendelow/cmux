#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${1:?source directory required}"
DESTINATION="${2:?destination required}"
BUNDLE_ID="${3:?bundle identifier required}"

case "$BUNDLE_ID" in
  com.ourostack.workbench|com.ourostack.workbench.*) ;;
  *) rm -rf "$DESTINATION"; exit 0 ;;
esac

FILES=(
  OuroWorkbenchMCP
  catalog.ts
  cmux-chat
  server.ts
  session-persistence.ts
  theme.ts
  types.ts
  workbench-mcp.ts
)
DIRECTORIES=(adapters node_modules public src)

for path in "${FILES[@]}" "${DIRECTORIES[@]}"; do
  if [[ ! -e "$SOURCE_DIR/$path" ]]; then
    echo "error: missing Agent Chat runtime path: $SOURCE_DIR/$path" >&2
    exit 1
  fi
done

TEMP_DESTINATION="${DESTINATION}.tmp.$$"
rm -rf "$TEMP_DESTINATION"
trap 'rm -rf "$TEMP_DESTINATION"' EXIT
mkdir -p "$TEMP_DESTINATION"
for path in "${FILES[@]}"; do
  cp -p "$SOURCE_DIR/$path" "$TEMP_DESTINATION/$path"
done
for path in "${DIRECTORIES[@]}"; do
  rsync -a "$SOURCE_DIR/$path/" "$TEMP_DESTINATION/$path/"
done
chmod 0755 "$TEMP_DESTINATION/cmux-chat" "$TEMP_DESTINATION/OuroWorkbenchMCP"
rm -rf "$DESTINATION"
mkdir -p "$(dirname "$DESTINATION")"
mv "$TEMP_DESTINATION" "$DESTINATION"
trap - EXIT
