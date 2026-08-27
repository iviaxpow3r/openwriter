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
github_oauth_client_id=${OPENWRITER_GITHUB_OAUTH_CLIENT_ID:-}
target_arch=${OPENWRITER_TARGET_ARCH:-}
compiler_arch_args=()
# The bundled Node 22 runtime requires macOS 11 or later. Match that floor for
# the small native launcher instead of inheriting the packager's host SDK
# version, which would make an Intel bundle unusable on an older Mac.
macos_deployment_target=${OPENWRITER_MACOSX_DEPLOYMENT_TARGET:-11.0}

if [[ ! -x "$node_binary" ]]; then
  print -u2 "A runnable Node binary is required to package OpenWriter."
  exit 1
fi

if [[ -n "$github_oauth_client_id" && ! "$github_oauth_client_id" =~ '^[A-Za-z0-9_]+$' ]]; then
  print -u2 "OPENWRITER_GITHUB_OAUTH_CLIENT_ID contains unsupported characters."
  exit 1
fi

if [[ -n "$target_arch" ]]; then
  if [[ "$target_arch" != "arm64" && "$target_arch" != "x86_64" ]]; then
    print -u2 "OPENWRITER_TARGET_ARCH must be arm64 or x86_64."
    exit 1
  fi
  node_archs=$(/usr/bin/lipo -archs "$node_binary" 2>/dev/null || true)
  if [[ " $node_archs " != *" $target_arch "* ]]; then
    print -u2 "The selected Node runtime does not contain the requested $target_arch architecture."
    print -u2 "Set OPENWRITER_NODE_BINARY to a matching or universal Node binary."
    exit 1
  fi
  compiler_arch_args=(-arch "$target_arch")
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
if [[ -n "$github_oauth_client_id" ]]; then
  /usr/libexec/PlistBuddy -c "Set :OpenWriterGitHubOAuthClientID $github_oauth_client_id" "$app_path/Contents/Info.plist"
fi
clang -fobjc-arc -mmacosx-version-min="$macos_deployment_target" "${compiler_arch_args[@]}" -framework Cocoa -framework WebKit "$script_dir/OpenWriterApp.m" -o "$app_path/Contents/MacOS/OpenWriter"

# The runtime is intentionally copied, not symlinked, so the bundle remains
# usable after it leaves this developer machine.
cp "$node_binary" "$runtime/node"
cp -R "$package_dir/dist" "$app_runtime/dist"
cp "$package_dir/package.json" "$app_runtime/package.json"
cp -R "$repo_root/node_modules" "$app_runtime/node_modules"

# npm installs Sharp's native image runtime for the packager's architecture.
# When intentionally producing an Intel bundle from an Apple-silicon Mac, add
# both matching optional packages before signing: Sharp's binary module and
# its libvips runtime. Otherwise opt-in publishing tools load successfully
# only on the packager's architecture.
if [[ -n "$target_arch" && -f "$app_runtime/node_modules/sharp/package.json" ]]; then
  for sharp_package in "@img/sharp-darwin-$target_arch" "@img/sharp-libvips-darwin-$target_arch"; do
    sharp_target="$app_runtime/node_modules/$sharp_package"
    if [[ -d "$sharp_target" ]]; then
      continue
    fi
    sharp_version=$("$node_binary" -p "require('$app_runtime/node_modules/sharp/package.json').optionalDependencies['$sharp_package'] || ''")
    if [[ -z "$sharp_version" ]]; then
      print -u2 "Could not determine the required optional package for $sharp_package."
      exit 1
    fi
    native_package_dir=$(mktemp -d "${TMPDIR:-/tmp}/openwriter-native-package.XXXXXX")
    (
      cd "$native_package_dir"
      npm pack --silent "$sharp_package@$sharp_version"
    )
    native_package_archive=$(find "$native_package_dir" -maxdepth 1 -type f -name '*.tgz' -print -quit)
    if [[ -z "$native_package_archive" ]]; then
      print -u2 "Could not download the optional $sharp_package runtime."
      exit 1
    fi
    mkdir -p "$sharp_target"
    tar -xzf "$native_package_archive" -C "$sharp_target" --strip-components=1
    rm -rf "$native_package_dir"
  done
fi

# The monorepo exposes its own workspace plugins through symlinks in the
# development node_modules directory. Bundled plugins already live in
# dist/plugins/, so omit those dangling source-tree links from the release.
rm -rf "$app_runtime/node_modules/@openwriter" "$app_runtime/node_modules/openwriter"

if [[ -n "$bootstrap_profile" ]]; then
  bootstrap="$resources/bootstrap"
  mkdir -p "$bootstrap/profiles"
  # The author repository is the portable source of truth. OpenWriter's
  # recovery/version and review sidecars are machine-local safety data: they
  # are intentionally ignored by the profile Git repository and must not make
  # the first-run bundle larger or carry stale local UI/review state to a new
  # device.
  rsync -a \
    --exclude '.versions/' \
    --exclude '_blame/' \
    --exclude '_history/' \
    --exclude '_commits/' \
    --exclude '_marks/' \
    --exclude '_pending/' \
    --exclude 'activity.log' \
    --exclude 'config.json' \
    --exclude '.DS_Store' \
    "$bootstrap_profile/" "$bootstrap/profiles/${bootstrap_profile:t}/"
  cp "$bootstrap_config" "$bootstrap/config.json"
fi

codesign --force --deep --sign - "$app_path"
codesign --verify --deep --strict "$app_path"
print "Packaged OpenWriter at: $app_path"
print "The first launch uses: ~/Library/Application Support/OpenWriter"
if [[ -n "$target_arch" ]]; then
  print "Bundle architecture: $target_arch"
fi
if [[ -n "$github_oauth_client_id" ]]; then
  print "GitHub device sign-in is enabled for this bundle."
else
  print "GitHub device sign-in is not configured for this bundle."
fi
if [[ -n "$bootstrap_profile" ]]; then
  print "A first-run author profile is included and will not replace existing local writing."
fi
