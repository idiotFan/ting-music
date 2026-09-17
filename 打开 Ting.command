#!/bin/zsh
cd "${0:A:h}"
ting_version=$(/usr/bin/plutil -extract version raw -o - package.json 2>/dev/null)
ting_release_app="Release/v${ting_version}/macOS-AppleSilicon/听 · Ting.app"
if [[ -n "$ting_version" && -d "$ting_release_app" ]]; then
  open "$ting_release_app"
elif [[ -d 'src-tauri/target/release/bundle/macos/听 · Ting.app' ]]; then
  open 'src-tauri/target/release/bundle/macos/听 · Ting.app'
else
  print '请先运行 npm ci、npm run prepare:desktop 和 npm run tauri build。'
  read '?按回车退出'
fi
