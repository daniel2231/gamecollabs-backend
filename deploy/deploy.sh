#!/usr/bin/env bash
# api·mcp를 CI가 올린 이미지로 갱신한다(홈서버, deploy 디렉터리 기준).
#
#   ./deploy.sh          main의 최신 이미지(latest)
#   ./deploy.sh <sha>    그 커밋의 이미지로 (되돌리기). 이후 다시 ./deploy.sh 하면 latest로 돌아온다
#
# 받은 이미지로 다시 띄우고, API가 준비되면 인덱스를 맞춘 뒤 상태를 보여준다.
set -euo pipefail
cd "$(dirname "$0")"

if [[ $# -gt 0 ]]; then
  export API_IMAGE="ghcr.io/daniel2231/gamecollabs-api:$1"
  export MCP_IMAGE="ghcr.io/daniel2231/gamecollabs-mcp:$1"
fi

echo "==> 이미지 받기 (${1:-latest})"
docker compose pull api mcp

echo "==> api·mcp 다시 띄우기"
docker compose up -d api mcp

echo "==> API 준비 기다리기"
ready=false
for _ in $(seq 1 30); do
  if docker compose exec -T api node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    ready=true
    break
  fi
  sleep 2
done
if [[ $ready != true ]]; then
  echo "API가 60초 안에 준비되지 않았습니다. 최근 로그:" >&2
  docker compose logs --tail=50 api >&2
  exit 1
fi

echo "==> 인덱스 맞추기"
docker compose exec -T api node dist/cli/index.js sync-indexes

echo "==> 상태"
docker compose ps api mcp
docker image prune -f >/dev/null
echo "배포 완료"
