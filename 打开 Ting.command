#!/bin/zsh
cd "${0:A:h}"
if [[ -d '听 · Ting.app' ]]; then
  open '听 · Ting.app'
elif [[ -d 'src-tauri/target/release/bundle/macos/听 · Ting.app' ]]; then
  open 'src-tauri/target/release/bundle/macos/听 · Ting.app'
else
  print '请先在此目录运行 npm install 和 npm run tauri build。'
  read '?按回车退出'
fi
