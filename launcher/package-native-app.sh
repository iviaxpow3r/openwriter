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
# A config-only author bundle still needs an empty named profile directory so
# OpenWriter preserves that profile as active on its very first launch. This
# is deliberately distinct from copying a profile snapshot with manuscript
# files or Git state.
bootstrap_profile_name=${OPENWRITER_BOOTSTRAP_PROFILE_NAME:-}
github_oauth_client_id=${OPENWRITER_GITHUB_OAUTH_CLIENT_ID:-}
# These are intentionally optional: a local acceptance bundle can run beside
# a normal author install without sharing its service or on-disk profile. The
# production bundle leaves both unset and retains the standard locations.
bundle_root_dir=${OPENWRITER_BUNDLE_ROOT_DIR:-}
bundle_port=${OPENWRITER_BUNDLE_PORT:-}
# Optional path to a vetted, self-contained Git runtime (with bin/git,
# libexec/git-core, and share/git-core/templates). When supplied, it is copied
# into the app so OpenWriter can use Git without modifying the author's Mac.
git_runtime=${OPENWRITER_GIT_RUNTIME:-}
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

if [[ -n "$bundle_root_dir" && "$bundle_root_dir" != /* ]]; then
  print -u2 "OPENWRITER_BUNDLE_ROOT_DIR must be an absolute path."
  exit 1
fi

if [[ -n "$bundle_port" && ( ! "$bundle_port" =~ '^[0-9]+$' || "$bundle_port" -lt 1 || "$bundle_port" -gt 65535 ) ]]; then
  print -u2 "OPENWRITER_BUNDLE_PORT must be a port number between 1 and 65535."
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

if [[ -n "$bootstrap_profile" && ! -d "$bootstrap_profile" ]]; then
  print -u2 "OPENWRITER_BOOTSTRAP_PROFILE must name an existing directory."
  exit 1
fi

if [[ -n "$bootstrap_config" && ! -f "$bootstrap_config" ]]; then
  print -u2 "OPENWRITER_BOOTSTRAP_CONFIG must name an existing file."
  exit 1
fi

if [[ -n "$bootstrap_profile_name" && ( "$bootstrap_profile_name" == */* || "$bootstrap_profile_name" == "." || "$bootstrap_profile_name" == ".." ) ]]; then
  print -u2 "OPENWRITER_BOOTSTRAP_PROFILE_NAME must be a single safe profile name."
  exit 1
fi

if [[ -n "$git_runtime" && ( ! -x "$git_runtime/bin/git" || ! -d "$git_runtime/libexec/git-core" || ! -d "$git_runtime/share/git-core/templates" ) ]]; then
  print -u2 "OPENWRITER_GIT_RUNTIME must contain bin/git, libexec/git-core, and share/git-core/templates."
  exit 1
fi

# Build fresh client, server, and plugin artifacts before copying any files.
(cd "$package_dir" && npm run build && node scripts/prepublish.cjs)

resources="$app_path/Contents/Resources"
runtime="$resources/runtime"
app_runtime="$resources/openwriter"
mkdir -p "$app_path/Contents/MacOS" "$runtime" "$app_runtime"

cp "$script_dir/Info.plist" "$app_path/Contents/Info.plist"
cp "$script_dir/OpenWriter.icns" "$resources/OpenWriter.icns"
if [[ -n "$github_oauth_client_id" ]]; then
  /usr/libexec/PlistBuddy -c "Set :OpenWriterGitHubOAuthClientID $github_oauth_client_id" "$app_path/Contents/Info.plist"
fi
if [[ -n "$bundle_root_dir" ]]; then
  /usr/bin/plutil -replace OpenWriterRootDir -string "$bundle_root_dir" "$app_path/Contents/Info.plist"
fi
if [[ -n "$bundle_port" ]]; then
  /usr/bin/plutil -replace OpenWriterPort -integer "$bundle_port" "$app_path/Contents/Info.plist"
fi
clang -fobjc-arc -mmacosx-version-min="$macos_deployment_target" "${compiler_arch_args[@]}" -framework Cocoa -framework WebKit "$script_dir/OpenWriterApp.m" -o "$app_path/Contents/MacOS/OpenWriter"
clang -fobjc-arc -mmacosx-version-min="$macos_deployment_target" "${compiler_arch_args[@]}" -framework Foundation -framework Security "$script_dir/OpenWriterKeychain.m" -o "$resources/OpenWriterKeychain"

# The runtime is intentionally copied, not symlinked, so the bundle remains
# usable after it leaves this developer machine.
cp "$node_binary" "$runtime/node"
if [[ -n "$git_runtime" ]]; then
  # Preserve the complete runtime layout; Git resolves its helper programs
  # and templates relative to these sibling directories.
  ditto "$git_runtime" "$resources/git"
fi
cp -R "$package_dir/dist" "$app_runtime/dist"
cp "$package_dir/package.json" "$app_runtime/package.json"
# Copy the *contents* of the dependency tree. `cp -R source destination` can
# leave a partial tree when the destination is created during a package build;
# rsync's directory-content form is deterministic and dereferences the local
# workspace links before the two source-only packages are removed below.
mkdir -p "$app_runtime/node_modules"
rsync -a --copy-links "$repo_root/node_modules/" "$app_runtime/node_modules/"

# npm installs Sharp's native image runtime for the packager's architecture.
# When intentionally producing an Intel bundle from an Apple-silicon Mac, add
# both matching optional packages before signing: Sharp's binary module and
# its libvips runtime. Otherwise opt-in publishing tools load successfully
# only on the packager's architecture.
if [[ -n "$target_arch" && -f "$app_runtime/node_modules/sharp/package.json" ]]; then
  # Mach-O calls Intel `x86_64`, while Sharp's published optional packages
  # call the same architecture `x64`. Keep the launcher/compiler spelling
  # separate from npm's package spelling so cross-packaging an Intel app on
  # Apple silicon includes the actual native module instead of failing later
  # in the author's blank WebKit shell.
  sharp_arch="$target_arch"
  if [[ "$sharp_arch" == "x86_64" ]]; then
    sharp_arch="x64"
  fi
  for sharp_package in "@img/sharp-darwin-$sharp_arch" "@img/sharp-libvips-darwin-$sharp_arch"; do
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

# A signed bundle that lacks a server dependency only fails later, after the
# author has installed it. Catch that packaging error here, next to the copy.
while IFS= read -r runtime_dependency; do
  if [[ ! -f "$app_runtime/node_modules/$runtime_dependency/package.json" ]]; then
    print -u2 "Missing runtime dependency in app bundle: $runtime_dependency"
    exit 1
  fi
done < <("$node_binary" -e "for (const dependency of Object.keys(require(process.argv[1]).dependencies || {})) console.log(dependency)" "$package_dir/package.json")

if [[ -n "$bootstrap_profile" || -n "$bootstrap_config" || -n "$bootstrap_profile_name" ]]; then
  bootstrap="$resources/bootstrap"
  mkdir -p "$bootstrap"
  if [[ -n "$bootstrap_profile" || -n "$bootstrap_profile_name" ]]; then
    mkdir -p "$bootstrap/profiles"
    # The author repository is the portable source of truth. Never package
    # its Git metadata or machine-local recovery/review state. A profile
    # snapshot is only appropriate for an intentionally offline starter; the
    # normal author install uses a config-only bootstrap and connects to the
    # shared repository on first run.
    if [[ -n "$bootstrap_profile" ]]; then
      rsync -a \
        --exclude '.git/' \
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
    elif [[ -n "$bootstrap_profile_name" ]]; then
      mkdir -p "$bootstrap/profiles/$bootstrap_profile_name"
    fi
  fi
  if [[ -n "$bootstrap_config" ]]; then
    cp "$bootstrap_config" "$bootstrap/config.json"
  fi
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
if [[ -n "$bootstrap_profile" || -n "$bootstrap_config" || -n "$bootstrap_profile_name" ]]; then
  print "First-run bootstrap settings are included and will not replace existing local writing."
fi
