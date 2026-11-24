#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js가 설치되어 있지 않습니다."
  echo "  https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요."
  read -n 1 -s -r -p "  아무 키나 누르면 닫힙니다"
  exit 1
fi
export TOD_SUPERVISED=1
while true; do
  caffeinate -i node server.js
  echo ""
  echo "  서버가 멈췄습니다. 3초 뒤 다시 시작합니다. (이 창을 닫으면 완전히 꺼집니다)"
  sleep 3
done
