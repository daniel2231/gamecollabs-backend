# gamecollabs-backend

콜라보 트래커 독립 서비스의 백엔드입니다. PRD(「콜라보 트래커 독립 서비스 PRD」)의 Express API, MCP 수집 서버, 공유 Zod 스키마, 홈서버 배포 설정을 담고 있습니다. Next.js 프론트엔드는 별도 저장소(`daniel2231/gamecollabs-frontend`, Vercel 배포)에 있습니다.

```text
packages/schema   공유 Zod 스키마: API 입력, 관리자 폼, 수집 후보, 쿼리
apps/api          Express 5 API + Mongoose 9 + 주기 작업 + CLI (이관, 토큰, 시드)
apps/mcp          ChatGPT용 MCP 서버 (Streamable HTTP, OAuth 2.1 + GitHub 로그인)
deploy/           Docker Compose (api, mcp, mongo rs0, cloudflared, backup), env 예시
prompts/          ChatGPT 예약 작업 / OpenAI 대체 수집 프롬프트
```

스택: Node.js 24 LTS, TypeScript 7, Express 5.2, Mongoose 9.11 (MongoDB 8, 단일 노드 레플리카 셋), Zod 4.6, `@modelcontextprotocol/sdk` 1.32, node-cron 4.6, pino 10, Vitest 5, pnpm workspaces.

## 빠른 시작

```bash
# MongoDB 8 단일 노드 레플리카 셋 (트랜잭션에 필요)
docker run -d --name mongo -p 27017:27017 mongo:8 --replSet rs0 --bind_ip_all
docker exec mongo mongosh --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:27017'}]})"

pnpm install
pnpm build

cp .env.example .env   # 값 확인 (MONGODB_URI, SERVICE_TOKENS, ADMIN_JWT_SECRET)

pnpm --filter @gamecollabs/api cli sync-indexes
pnpm --filter @gamecollabs/api cli seed-taxonomy
pnpm --filter @gamecollabs/api cli create-user --github daniel2231 --role admin
pnpm --filter @gamecollabs/api cli create-token --name mcp --role ingest   # MCP의 INTERNAL_API_KEY
pnpm dev:api

pnpm test        # 통합 테스트는 위 레플리카 셋을 사용 (TEST_MONGODB_URI로 변경 가능)
```

## 인증과 권한

모든 `/v1/*` 요청에 `Authorization: Bearer <token>`이 필요합니다. 인증 없이 열린 경로는 `/healthz`, `/readyz`뿐입니다.

| 호출자 | 토큰 | 권한 |
| --- | --- | --- |
| Next.js 서버 | `SERVICE_TOKENS` (서비스 토큰) | 공개 조회, 제보 중계 |
| 관리자 (admin) | Next.js가 GitHub 로그인 후 발급한 HS256 JWT (`sub` = GitHub 로그인, `iss`/`aud` 검증). `users`에 등록된 계정만 통과 | 전체 |
| 편집자 (editor) | 같은 JWT | 초안 작성·수정, 검수 요청, 엔티티 편집 (발행·병합·분류 추가는 불가) |
| 에이전트 (agent) | `gct_…` API 토큰 (DB에는 sha256만 저장) | draft 생성, draft 상태인 항목만 수정 |
| 수집 (ingest) | `gct_…` API 토큰 | `/v1/ingest/*`만 사용 |

## API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/v1/collabs` | 목록. `q`, `category`, `partner_category`, `region`, `platform`, `collab_type`, `phase`, `from`, `to`, `property`, `company`, `locale`, `sort`(`start_desc`, `start_asc`, `recent`=발행일순), `cursor`, `limit`(≤100) |
| GET | `/v1/collabs/:slug` | 상세 + 관련 콜라보. 오프라인 콜라보는 `venues: [{ name, address, url }]` (이름은 요청 언어, 주소는 공식 표기 그대로) |
| GET | `/v1/properties?featured=true` | 홈 'IP로 찾아보기': `featuredOrder`가 있는 작품을 순서대로(같으면 요청 언어 이름순). 발행 콜라보 기준 `collabCount`, `counterpartCount`(함께한 다른 작품 수), `ongoingCount`, 대표 `image`, `latestCover`(커버 있는 발행 콜라보 중 시작일이 가장 최근). 콜라보가 없는 작품도 포함 |
| GET | `/v1/properties/:slug`, `/v1/companies/:slug` | 엔티티 + 타임라인, 파트너 목록. 이전 slug로도 조회되며 응답의 `slug`가 정식 주소 |
| GET | `/v1/taxonomies` | 분류 트리와 ko/en 라벨 |
| GET | `/v1/stats` | 전체 건수, 진행 상태별 건수(`byPhase`), 월별 건수, 분류별 분포 |
| GET | `/v1/sitemap` | 발행된 콜라보 slug·updatedAt과 그 콜라보에 나오는 작품·회사 slug·updatedAt (작품·회사는 자기 수정 시각과 발행된 콜라보 중 가장 최근 수정 시각 중 늦은 쪽) |
| POST | `/v1/submissions` | 제보 (honeypot, IP당 시간당 10건, `TURNSTILE_SECRET` 설정 시 Turnstile 검증) |
| GET/POST | `/v1/admin/collabs` | 내부 목록(`meta.counts` 상태별 건수, 검수 중 항목의 `duplicateCount`) / 초안 생성 (항상 `draft`, 중복 후보 반환) |
| GET/PATCH | `/v1/admin/collabs/:id` | 조회 / 수정 (`If-Match: <rev>` 필수, 불일치 시 412) |
| POST | `/v1/admin/collabs/:id/transition` | `submit`, `publish`(관리자만), `archive`, `reject`(사유 필수), `reopen` |
| GET | `/v1/admin/collabs/:id/revisions`, `…/duplicates` | 변경 이력, 중복 후보 |
| POST | `/v1/admin/collabs/:id/cover/mirror` | 커버 이미지를 R2로 복사 |
| GET/POST/PATCH | `/v1/admin/properties`, `/v1/admin/companies` | 자동완성(`?q=`, 없으면 전체 목록), 생성, 수정 (이름 변경은 같은 트랜잭션에서 스냅샷 갱신). 작품은 홈 노출용 `featuredOrder`(1~999, `null`이면 노출 안 함)와 `image`(콜라보 `cover`와 같은 형태, `storageKey`나 `originalUrl` 필수)를 함께 주고받음. 본문에서 생략하면 기존 값 유지, `null`이면 해제 |
| POST | `/v1/admin/{properties,companies}/:id/merge` | `{ from }`을 `:id`로 병합 (관리자만). 작품의 `featuredOrder`·`image`는 대상 값을 유지하고, 대상에 없을 때만 원본 값을 옮김 |
| POST | `/v1/admin/media` | 커버 업로드 (multipart `file`, JPEG·PNG·WebP를 바이트로 확인, 5MB·4천만 픽셀 이하). 방향 보정 후 EXIF·GPS를 지우고 긴 변 1600px WebP로 다시 인코딩해 `covers/<sha256>.webp`에 저장. 응답 `201 { storageKey, url, width, height }` → 콜라보 `PATCH cover.storageKey` 또는 작품 `PATCH image.storageKey`로 연결 |
| GET | `/v1/admin/match?name=` | 기존 엔티티와 중복 콜라보 후보 |
| GET/POST/PATCH | `/v1/admin/taxonomies` | 분류값 관리 (추가·수정은 관리자만) |
| GET | `/v1/admin/ingest-runs`, `/v1/admin/submissions` | 수집 실행 기록, 제보 큐 |
| POST | `/v1/ingest/:channel` | 수집 채널. `candidates`: 후보 최대 20건 → 건별 `created`/`duplicate`/`rejected` |
| GET | `/v1/ingest/lookup/entities`, `/v1/ingest/lookup/collabs` | 수집기용 최소 정보 조회 |

오류는 항상 `{ "error": { "code": "validation_failed", "message"?, "fields"? } }` 형식입니다. `locale=ko|en`이면 그 언어의 텍스트를 그대로 내려줍니다 (다른 언어로 대체하지 않음). `phase`는 저장하지 않고 요청 시각 기준으로 계산합니다.

발행·수정이 일어나면 `WEB_REVALIDATE_URL`로 `{ "tags": ["collabs", "collab:<slug>", "property:<slug>", "company:<slug>"] }`를 보냅니다. 작품의 `featuredOrder`나 `image`가 바뀌면(또는 홈에 노출 중인 작품의 이름·종류가 바뀌면) `featured` 태그를 함께 보냅니다. 홈 노출 목록의 건수·커버는 콜라보 발행·수정 때 가는 `collabs` 태그로 갱신됩니다.

## 데이터 모델

PRD의 컬렉션을 그대로 따릅니다: `collabs`, `properties`(게임·IP 통합), `companies`, `taxonomy_terms`, `users`, `revisions`, `submissions`, `ingest_runs`, 그리고 작업 잠금용 `job_locks`.

- 저장 전 훅이 `facetKeys`(입력 키 + 모든 상위 키 + partner 역할의 kind), `searchTokens`(한글 2-gram, 영문 단어·접두어), `rev`를 계산합니다. 분류 키는 `taxonomy_terms`에 있는 키만 허용합니다.
- 검색은 `SearchProvider` 인터페이스 뒤의 자체 토큰 인덱스입니다. Atlas Search로 바꿀 때 구현체만 교체합니다.
- PATCH·전이·병합은 모두 트랜잭션 안에서 `revisions`에 diff를 남깁니다.

**한국어·영어 필수**: 콜라보의 제목·요약(`i18n.ko`, `i18n.en`), 작품·회사 이름(`name.ko`, `name.en`), 연결 전 참여자 이름, 커버 대체 텍스트(넣을 경우)는 초안 단계부터 두 언어가 모두 있어야 저장됩니다. 메모는 두 언어 모두 있거나 둘 다 없어야 합니다. 콜라보 텍스트와 엔티티 이름은 Zod 스키마와 Mongoose 모델 양쪽에서 검사하고, 발행할 때 한 번 더 확인합니다. 원어 이름(`name.original`)만 선택입니다. 수집 후보도 제목·요약을 두 언어로 보내야 하며, 한쪽이 없으면 `rejected`입니다.

PRD에서 조금 바꾸거나 보탠 부분:

- `period.until`: `end`와 `precision`으로 만든 배타적 종료 시각입니다. 시간에 따라 변하지 않는 파생값이라 진행 상태 필터를 범위 쿼리 한 번으로 처리하려고 저장합니다.
- 작품·회사 스냅샷에 `name`과 함께 `slug`도 저장합니다 (목록에서 링크를 `$lookup` 없이 그리기 위해).
- 회사 역할에 `unspecified`를 추가했습니다. MVP 데이터는 역할을 구분하지 않기 때문입니다.
- 수집 후보의 게임·파트너·회사는 slug → 이름·별칭 순으로 기존 작품·회사에 연결합니다. 맞는 것이 없고 후보가 공식 한·영 이름(`game.names`, `partner.names`, `companies[].names`, 회사는 `country`도)을 보냈으면 그 이름으로 새로 만들어 연결합니다 (`createdByRun`에 수집 run id 기록, 결과 `warnings`에 "created game/partner/company"). 중복·반려된 후보는 아무것도 만들지 않습니다. 이름이 잘못 만들어졌으면 관리자 화면의 작품·회사에서 고치거나 기존 작품에 병합합니다.
- 공식 이름이 없으면 참여자는 이름만 가진 채로 남고(`propertyId: null`, 발행하려면 연결 필요), 회사는 수집 원본값(`origin.unmapped.companies`)으로만 남습니다.
- 전이에 `reject`(폐기, 사유 저장 → 프롬프트 개선용)와 `reopen`을 추가했습니다.

## 자동 수집

```text
ChatGPT 예약 작업 → mcp.<도메인>/mcp (OAuth 2.1, GitHub 계정 1개만 허용)
  → apps/mcp → http://api:3000/v1/ingest/candidates (Bearer INTERNAL_API_KEY)
  → ingestCandidates(): 스키마 → 중복(출처 URL 또는 같은 게임·파트너 ±14일) → 출처 URL 접속 확인 → 분류 매핑(실패 값은 origin.unmapped에 보존) → draft
```

- MCP 도구: `get_taxonomy`, `search_collabs`, `find_entity`(읽기, `readOnlyHint: true`), `submit_collab_candidates`(`readOnlyHint: false`, `idempotentHint: true`), 그리고 후속 확인용 `list_followups`, `report_followup` (아래 참고).
- 안전장치: 호출당 20건(스키마), 하루 100건(`INGEST_DAILY_LIMIT`, KST 기준, 초과 시 거부 + 알림), draft만 생성, 출처 URL 확인 시 사설 IP 차단(SSRF 방지), 모든 도구 호출 로그.
- 대체 경로: `OPENAI_API_KEY`와 `OPENAI_MODEL`을 설정하면 `discover-openai` 작업이 매일 09:05 KST에 Responses API(`web_search` + JSON 스키마)를 호출해 같은 `ingestCandidates`로 넣습니다. 월 예산은 `OPENAI_MONTHLY_BUDGET_USD`로 제한합니다.
- ChatGPT 커넥터 등록: GitHub OAuth 앱의 콜백을 `https://mcp.<도메인>/oauth/github/callback`으로 만들고, ChatGPT에 `https://mcp.<도메인>/mcp`를 추가합니다. 등록된 클라이언트는 `DATA_DIR/oauth-clients.json`에 남습니다.

### 후속 확인 (날짜 미정 콜라보)

발표만 되고 날짜가 "coming soon"인 콜라보, 월만 알려진 콜라보, 종료일이 발표되지 않은 콜라보는 저장할 때 `followUp.reason`이 붙어 재확인 대상이 됩니다.

| `reason` | 조건 | 기다리는 정보 |
| --- | --- | --- |
| `start_tba` | 시작일 없음 | 시작일 |
| `month_only` | 시작일이 월 단위 (그 달이 끝날 때까지) | 정확한 시작일 |
| `end_tba` | 종료일 없음, `endKind: "tba"` | 종료일 또는 상시(`permanent`) 여부 |
| `end_missing` | 종료일 없음, `endKind: "fixed"` | 종료일 (데이터 누락) |

날짜가 다 채워지거나, 종료됐거나, `permanent`이거나, 보관된 콜라보는 대상에서 빠집니다.

- 일정: 첫 확인은 3일 뒤, 이후 변화가 없을 때마다 7 → 14 → 30일 간격입니다. 5번 연속 변화가 없으면 한 번 알림을 보내고 `escalated`로 표시합니다 (날짜를 넣거나, `permanent`로 바꾸거나, 보관할지 사람이 결정).
- MCP 도구 (`/mcp`, `/mcp/admin` 둘 다): `list_followups`로 확인할 콜라보를 받고, `report_followup`으로 결과를 보냅니다. 예약 작업 프롬프트는 `prompts/daily-followup.md`입니다.
  - `no_change`: 다음 확인일만 뒤로 미룹니다 (`rev`는 바뀌지 않음).
  - `updated`: **초안은 바로 수정**합니다 (`rev` 확인, 변경 이력 기록, 새 출처는 기존 출처 뒤에 추가). **검수 중·발행된 콜라보는 수정하지 않고 제안(`followUp.proposal`)으로 저장**하고 알림을 보냅니다. 제안이 처리될 때까지 그 콜라보는 확인 대상에서 빠집니다.
- 관리용 도구: `followup_queue`(`proposals`/`escalated`/`due`), `resolve_followup`(`apply`는 `update_collab`과 같은 규칙으로 반영, `rev` 필요 / `dismiss`는 제안을 버리고 확인 재개).
- API: `GET /v1/ingest/followups`, `POST /v1/ingest/followups/:id`(수집 토큰), `GET /v1/admin/followups?view=`, `POST /v1/admin/collabs/:id/followup`(`If-Match` 필요, apply 시).
- `followups` 작업이 매일 사유를 다시 계산합니다 (시간이 지나 종료되거나 `month_only`에서 벗어난 콜라보 반영, 기존 데이터 채우기). 새로 대상이 된 콜라보는 바로 확인 대상입니다. 배포 직후 한 번 `pnpm --filter @gamecollabs/api job followups`(컨테이너에서는 `node dist/cli/index.js job followups`)로 기존 데이터를 채우세요.

### 관리용 MCP (`/mcp/admin`)

`deploy/.env.mcp`에 `ADMIN_API_KEY`(관리자 역할 API 토큰)를 넣으면 `https://mcp.<도메인>/mcp/admin`이 열립니다. 수집·후속 확인 도구에 더해 운영 데이터를 고치는 도구가 붙습니다. `/mcp`(ChatGPT 수집용)는 그대로 수집·후속 확인 전용입니다.

| 도구 | 하는 일 |
| --- | --- |
| `list_collabs`, `get_collab`, `collab_history` | 초안·발행본 조회(id 또는 slug), 중복 후보, 변경 이력 |
| `update_collab` | 필드 수정 (`rev` 필수, 보낸 최상위 필드만 교체, 변경 이력에 기록) |
| `transition_collab` | 검수 요청·발행·반려(사유 필수)·보관·복구 |
| `create_entity`, `update_entity`, `merge_entities` | 작품·회사 생성, 이름·slug 수정, 병합(이전 slug는 리다이렉트) |
| `mirror_cover` | 커버 이미지를 R2로 복사 |

```bash
docker compose exec api node dist/cli/index.js create-token --name mcp-admin --role admin   # 출력된 gct_ 토큰을 ADMIN_API_KEY에
docker compose up -d mcp
```

Claude에서 쓰려면 claude.ai → 설정 → 커넥터 → 커스텀 커넥터 추가에 `https://mcp.<도메인>/mcp/admin`을 넣고 GitHub으로 로그인합니다 (같은 GitHub OAuth 앱, 같은 허용 계정 1개). 토큰을 없애려면 `revoke-token --name mcp-admin` 후 `ADMIN_API_KEY`를 비우세요.

## 주기 작업

API 컨테이너 안의 스케줄러(`SCHEDULER_ENABLED=true`)가 실행하고, 같은 작업을 CLI로도 실행할 수 있습니다: `pnpm --filter @gamecollabs/api job <name>`. MongoDB 잠금으로 인스턴스가 여러 개여도 한 번만 돕니다.

| 작업 | 시각 (KST) | 내용 |
| --- | --- | --- |
| `link-check` | 월 04:10 | 출처 URL 상태 확인, 깨진 링크 알림 (F-10) |
| `recount` | 매일 03:20 | `collabCount` 보정 |
| `followups` | 매일 03:50 | 후속 확인 사유 재계산, 기존 데이터 채우기 |
| `reindex-facets` | 매일 03:40 | 분류 계층 변경 후 `facetKeys` 재계산 |
| `consistency` | 일 04:40 | 이름 스냅샷 불일치 수정 |
| `mirror-covers` | 매시 15분 | 커버 이미지를 R2로 복사 (F-09) |
| `cleanup-uploads` | 일 05:30 | 어느 콜라보 커버나 작품 이미지도 쓰지 않는 업로드(`covers/`) 중 7일 지난 것 삭제 |
| `export-json` | 일 05:00 | 컬렉션별 Extended JSON 덤프 (`EXPORT_DIR`, Git 커밋용) |
| `discover-openai` | 매일 09:05 | 대체 수집 경로 (키가 있을 때만) |

일일 `mongodump`는 `backup` 컨테이너가 R2 `backups` 버킷에 올리고 30일 보관합니다 (`deploy/backup/backup.sh once`로 즉시 실행).

## MDX 이관 (M1)

원본 114건과 이관 설정은 `deploy/migration/`에 있습니다.

| 파일 | 내용 |
| --- | --- |
| `collab-tracker/*.mdx` | 블로그 MVP의 콜라보 원본 |
| `fields.json` | 필드명 차이 (`title` → `title_ko`) |
| `mapping.json` | 분류표 별칭으로 처리하지 않는 값: 플랫폼이 아닌 값은 버림(`null`), `PC / Console`은 키 두 개로 |

나머지 표기 변형(`Quest / Event`, `Character Skin`, `Web Browser` …)은 분류표의 별칭(`legacyValues`, `apps/api/src/seed/taxonomy.ts`)으로 처리되어, GPT 수집에도 똑같이 적용됩니다. 분류표를 바꾼 뒤에는 `seed-taxonomy --update`로 DB에 반영합니다.

```bash
pnpm build
pnpm --filter @gamecollabs/api cli seed-taxonomy --update

# 1) 미리보기: DB에 쓰지 않고 problems / unmapped / warnings만 보고
pnpm --filter @gamecollabs/api cli migrate-mdx --dir ../../deploy/migration/collab-tracker \
  --fields ../../deploy/migration/fields.json --mapping ../../deploy/migration/mapping.json \
  --dry-run --report report.json

# 2) 실제 이관: 같은 명령에서 --dry-run만 빼기
pnpm --filter @gamecollabs/api cli migrate-mdx --dir ../../deploy/migration/collab-tracker \
  --fields ../../deploy/migration/fields.json --mapping ../../deploy/migration/mapping.json \
  --report report.json
```

홈서버의 운영 DB에 이관할 때는 API 컨테이너 안에서 실행합니다 (호스트의 `pnpm ... cli`는 루트 `.env`의 개발 DB에 씁니다). 이관 폴더는 읽기 전용으로 붙입니다:

```bash
cd deploy
docker compose run --rm -v "$(pwd)/migration:/app/migration:ro" api \
  node dist/cli/index.js migrate-mdx --dir migration/collab-tracker \
  --fields migration/fields.json --mapping migration/mapping.json \
  --image-base-url https://<옛 블로그 도메인> --dry-run
```

- slug 기준 upsert라 몇 번이고 다시 실행할 수 있습니다. 다만 다시 실행하면 그사이 관리자 화면에서 고친 내용도 원본 값으로 덮어씁니다.
- 다시 실행해도 이미 있는 작품·회사의 이름은 바꾸지 않습니다. 파일에서 표기를 고쳤다면(`Sega` → `SEGA`) `--update-names`를 붙이면 파일의 한·영 표기로 바뀌고 이전 표기는 별칭으로 남습니다. 이름 자체가 바뀐 경우(다른 이름 키)는 새 항목이 생기므로, 이전 항목을 관리자 화면에서 새 항목으로 병합하세요(이전 slug는 리다이렉트로 유지).
- 판정되지 않은 값(`problems`, `unmapped`)이 남아 있거나 대조 리포트에 누락이 있으면 종료 코드 1입니다 (M0/M1 게이트). `warnings`는 이관을 막지 않습니다.
- `active`/`ongoing`/`upcoming` → `published`. 단, 발행 조건을 못 채우는 항목(시작일이나 카테고리 없음)은 `draft`로 들어오고 `warnings`에 나옵니다.
- `company_roles`(목록, `companies`와 같은 순서): 회사별 역할(`developer`, `publisher`, `licensor`, `brand_partner`, `organizer`). 없으면 `unspecified`.
- `source_url` → `sources[0]`(primary), `extra_sources`(목록) → 나머지 출처. 종료일이 없는 항목은 `end_kind`(`permanent`/`tba`)를 따르고, 없으면 `endKind: "tba"`. `note`와 `tags`는 내부 메모(`origin.notes`)로 남깁니다(공개되지 않음).
- `partner_category`가 여러 개면 첫 번째만 쓰고 `warnings`에 남깁니다.
- `image`가 `/blog/uploads/...`처럼 옛 블로그의 경로면 `--image-base-url https://<블로그 도메인>`으로 전체 주소로 바꿔 저장합니다(없으면 `problems`). 이미 R2로 복사된 커버는 이미지가 그대로면 다시 실행해도 유지됩니다.
- 모든 항목은 한국어·영어를 다 갖춰야 합니다. 필요한 필드: `title`/`title_en`(둘 다 없으면 작품명으로 만듦), `summary_ko`/`summary_en`, `game_title`/`game_title_ko`, `ip_title`/`ip_title_ko`, `companies`/`companies_ko`(같은 순서). 하나라도 빠지면 `problems`에 나오고 이관이 중단됩니다.
- 매핑 파일 형식: `{ "<taxonomy>": { "<원본 값>": "<키>" | ["<키>", …] | null } }`. 키가 분류표에 없으면 `unmapped`로 보고합니다. 표기가 다른 같은 작품은 `--entity-map entities.json`(`{ "AoT": "Attack on Titan" }`)으로 합칩니다.

## 배포 (홈서버)

```bash
cd deploy
cp .env.example .env && cp .env.mcp.example .env.mcp && cp .env.backup.example .env.backup   # 값 채우기
docker compose up -d
docker compose exec api node dist/cli/index.js sync-indexes
docker compose exec api node dist/cli/index.js seed-taxonomy
```

- 호스트 포트를 열지 않습니다. Cloudflare Tunnel에서 `api.<도메인>` → `http://api:3000`, `mcp.<도메인>` → `http://mcp:3001`로 연결하고, WAF로 `/v1/admin/*`, `/v1/ingest/*`, `/mcp`에 횟수 제한을 겁니다.
- MongoDB는 Compose 내부 네트워크에만 있고 인증 없이 돕니다. 포트를 외부에 열지 마세요.
- `main`에 푸시하면 CI가 테스트 후 `ghcr.io/<owner>/gamecollabs-{api,mcp}` 이미지를 올립니다.
- 클라우드 이전 때는 `READ_ONLY_MODE=true`로 쓰기를 막고 `mongodump`/`mongorestore` 후 `MONGODB_URI`와 DNS만 바꿉니다.
