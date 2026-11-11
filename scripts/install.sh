#!/usr/bin/env bash
# Copy the two plugins of the entry (chat-tree, concept-links) into a Hermes home.
#
#   bash scripts/install.sh [hermes-home]     # default: $HOME/.hermes
#
# Layout written:
#   <home>/desktop-plugins/<id>/plugin.js      the Desktop bundle of each plugin
#   <home>/plugins/chat-tree/                  the Python half of chat-tree (manifest, register(ctx)
#                                              with the digest.write RPC method)
#   <home>/plugins/concept-links/              the Python half of concept-links (manifest, hook, proxy)
#   <home>/skills/concept-links/SKILL.md       the concept-links skill
#
# side-chat is not part of the entry, so this script does not install it.
# This script runs no hermes command. It prints the follow-up commands instead.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
default_home="${HOME}/.hermes"
home="${1:-$default_home}"

fail() {
  echo "install.sh: $*" >&2
  exit 1
}

need() {
  [ -f "$repo/$1" ] || fail "missing $1 (run npm run assemble and npm run assemble:chat-tree)"
}

# Copy to a temporary name, then rename, so a running Desktop never reads a half-written file.
put() {
  local src="$repo/$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest.tmp.$$"
  mv -f "$dest.tmp.$$" "$dest"
  echo "  $1 -> $dest"
}

for f in desktop/plugin.js chat-tree/desktop/plugin.js chat-tree/plugin.yaml chat-tree/__init__.py \
  plugin.yaml __init__.py lookup_sources.py dashboard/plugin_api.py skills/concept-links/SKILL.md; do
  need "$f"
done

mkdir -p "$home"
home="$(cd "$home" && pwd)"
echo "Installing into $home"

echo "concept-links"
put desktop/plugin.js "$home/desktop-plugins/concept-links/plugin.js"
put plugin.yaml "$home/plugins/concept-links/plugin.yaml"
put __init__.py "$home/plugins/concept-links/__init__.py"
put lookup_sources.py "$home/plugins/concept-links/lookup_sources.py"
put dashboard/plugin_api.py "$home/plugins/concept-links/dashboard/plugin_api.py"
put skills/concept-links/SKILL.md "$home/plugins/concept-links/skills/concept-links/SKILL.md"
put skills/concept-links/SKILL.md "$home/skills/concept-links/SKILL.md"
# Stale bytecode from an older copy must not run instead of the new source.
find "$home/plugins/concept-links" -type d -name __pycache__ -prune -exec rm -rf {} +

echo "chat-tree"
put chat-tree/desktop/plugin.js "$home/desktop-plugins/chat-tree/plugin.js"
put chat-tree/plugin.yaml "$home/plugins/chat-tree/plugin.yaml"
put chat-tree/__init__.py "$home/plugins/chat-tree/__init__.py"
find "$home/plugins/chat-tree" -type d -name __pycache__ -prune -exec rm -rf {} +

prefix=""
if [ "$home" != "$(cd "$default_home" 2>/dev/null && pwd || echo "$default_home")" ]; then
  prefix="HERMES_HOME=$home "
fi

cat <<EOF

Done. Nothing was enabled or restarted. Run these commands next:

  ${prefix}hermes plugins enable chat-tree
  ${prefix}hermes plugins disable concept-links
  ${prefix}hermes plugins enable concept-links
  ${prefix}hermes gateway restart -y --detach

Then quit and relaunch Hermes Desktop, so that it loads the two Desktop plugins.
EOF
