#!/bin/zsh
set -euo pipefail

# Assemble a self-contained macOS app for an author-facing pilot. The bundle
# carries the compiled OpenWriter server/client, bundled plugins, Node runtime,
# and production dependencies. The target Mac therefore does not need npm,
# NVM, or a developer checkout to open the writing app.

script_dir=${0:A:h}
repo_root=${script_dir:h}
package_dir="$repo_root/packages/openwriter"
app_path=${1:-"$repo_root/dist/OpenWriter.app"}
node_binary=${OPENWRITER_NODE_BINARY:-"$(command -v node)"}
bootstrap_profile=${OPENWRITER_BOOTSTRAP_PROFILE:-}
bootstrap_config=${OPENWRITER_BOOTSTRAP_CONFIG:-}

if [[ ! -x "$node_binary" ]]; then
  print -u2 "A runnable Node binary is required to package OpenWriter."
  exit 1
fi

if [[ -e "$app_path" ]]; then
  print -u2 "Refusing to replace an existing app bundle: $app_path"
  print -u2 "Choose a new destination or remove that specific bundle first."
  exit 1
fi

if [[ ! -d "$repo_root/node_modules" ]]; then
  print -u2 "Dependencies are missing. Run npm ci from the repository root first."
  exit 1
fi

if [[ -n "$bootstrap_profile" || -n "$bootstrap_config" ]]; then
  if [[ ! -d "$bootstrap_profile" || ! -f "$bootstrap_config" ]]; then
    print -u2 "Set both OPENWRITER_BOOTSTRAP_PROFILE and OPENWRITER_BOOTSTRAP_CONFIG, or neither."
    exit 1
  fi
fi

# Build fresh client, server, and plugin artifacts before copying any files.
(cd "$package_dir" && npm run build && node scripts/prepublish.cjs)

resources="$app_path/Contents/Resources"
runtime="$resources/runtime"
app_runtime="$resources/openwriter"
mkdir -p "$app_path/Contents/MacOS" "$runtime" "$app_runtime"

cp "$script_dir/Info.plist" "$app_path/Contents/Info.plist"
clang -fobjc-arc -framework Cocoa -framework WebKit "$script_dir/OpenWriterApp.m" -o "$app_path/Contents/MacOS/OpenWriter"

# The runtime is intentionally copied, not symlinked, so the bundle remains
# usable after it leaves this developer machine.
cp "$node_binary" "$runtime/node"
cp -R "$package_dir/dist" "$app_runtime/dist"
cp "$package_dir/package.json" "$app_runtime/package.json"
cp -R "$repo_root/node_modules" "$app_runtime/node_modules"

# The monorepo exposes its own workspace plugins through symlinks in the
# development node_modules directory. Bundled plugins already live in
# dist/plugins/, so omit those dangling source-tree links from the release.
rm -rf "$app_runtime/node_modules/@openwriter" "$app_runtime/node_modules/openwriter"

if [[ -n "$bootstrap_profile" ]]; then
  bootstrap="$resources/bootstrap"
  mkdir -p "$bootstrap/profiles"
  cp -R "$bootstrap_profile" "$bootstrap/profiles/${bootstrap_profile:t}"
  cp "$bootstrap_config" "$bootstrap/config.json"
fi

codesign --force --deep --sign - "$app_path"
codesign --verify --deep --strict "$app_path"
print "Packaged OpenWriter at: $app_path"
print "The first launch uses: ~/Library/Application Support/OpenWriter"
if [[ -n "$bootstrap_profile" ]]; then
  print "A first-run author profile is included and will not replace existing local writing."
fi
