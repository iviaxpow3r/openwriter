#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
app_path=${1:-"$HOME/Applications/OpenWriter.app"}
binary_path="$app_path/Contents/MacOS/OpenWriter"

clang -fobjc-arc -framework Cocoa -framework WebKit "$script_dir/OpenWriterApp.m" -o "$binary_path"
codesign --force --deep --sign - "$app_path"
codesign --verify --deep --strict "$app_path"
