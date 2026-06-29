# context-ontology 배포 (셀프호스트)

고객사가 **코드 없이** 한 호스트에 올리는 패키징. Linux·macOS 양쪽을 지원한다.

## 토폴로지 — Option 2 (store=도커 / gateway=네이티브)

```
 ┌─ 호스트(EC2 Linux · 또는 Mac) ───────────────────────────────────┐
 │                                                                   │
 │   gateway (네이티브: systemd | launchd)                           │
 │     · MCP(/mcp) · 웹UI(/ui) · 전달(/install) · 중앙박스(웹터미널)  │
 │     · node dist/index.js  ←─ .env                                  │
 │            │ localhost:5432                                        │
 │            ▼                                                       │
 │   store (docker compose)                                          │
 │     · items-db = pgvector/pgvector:pg18  (지식·v6·도메인맵)        │
 │     · embeddings = Ollama (선택, profile)                          │
 │                                                                   │
 │   docker (호스트)  ←─ 중앙박스 세션이 그대로 사용(DinD 없음)        │
 └───────────────────────────────────────────────────────────────────┘
```

**왜 게이트웨이는 네이티브인가:** 게이트웨이가 중앙박스(웹터미널) 세션을 *프로세스 안에서* tmux/PTY 로 띄운다.
게이트웨이를 컨테이너에 넣으면 그 세션도 컨테이너 안 → 고객 레포 빌드/`docker compose` 가 **DinD 함정**에 빠진다.
네이티브로 두면 세션이 호스트 docker 를 그대로 쓴다. (근거: `knowledge_get central-box-design`)

> full-docker(게이트웨이까지 컨테이너 = Option 1)는 `docker compose --profile gateway up` 로 미리보기 가능하지만,
> 중앙박스를 쓰려면 러너 분리가 선행돼야 한다(추후).

## 최초 설치 (새 박스 — install.sh)

> 전체 흐름(EC2): `lively-infra` 에서 `terraform apply` → 코드 rsync → 아래 `install.sh` → `claude` 로그인.
> (인프라·rsync 명령은 `lively-infra/projects/honest-ai-pilot/README.md` 참조.)

```bash
# 호스트에서 (코드가 이미 와 있는 상태)
PUBLIC_URL=http://<host>:8080 BOOTSTRAP_ADMIN_EMAIL=you@org.com ORG_DOMAIN=org.com \
  bash deploy/install.sh
```

`install.sh` 가 OS 를 감지해 7단계를 수행한다(전부 멱등·비파괴):

| 단계 | 내용 |
|---|---|
| 1 의존성 | docker · node22 · tmux · build-deps · Claude Code (`deploy/<os>/provision.sh`) |
| 2 .env | 없으면 시크릿(`openssl rand`) 자동 생성 — **있으면 보존** |
| 3 store | `docker compose up -d --wait items-db` (pgvector, 127.0.0.1 바인딩) |
| 4 빌드 | `npm ci && npm run build` |
| 5 서비스 | systemd(Linux) / launchd(Mac) 등록·기동 + `/healthz` 확인 (스키마 자가 마이그레이션) |
| 6 부트스트랩 | 첫 관리자(웹 세션 로그인 계정) 시드 — `deploy/bootstrap-admin.mjs` (⚠ 서비스 기동 뒤에) |
| 7 중앙박스 키트 | 호스트 claude 에 lively 설치(MCP+훅+컨텍스트) — `deploy/install-kit.sh`. **웹터미널 세션이 맥락 CRUD 가능해짐.** |

환경변수: `PUBLIC_URL` · `BOOTSTRAP_ADMIN_EMAIL` · `BOOTSTRAP_ADMIN_PASSWORD`(생략 시 랜덤) · `ORG_DOMAIN`
· `WITH_EMBEDDINGS=1`(t4g.large+) · `FORCE=1`(기존 :8080 감지 무시).

## 업데이트 (기존 박스 — update.sh)

최초 설치와 다르다: **의존성·서비스 유닛·`.env`·데이터(볼륨)·claude 인증·부트스트랩은 그대로 두고 코드만 갱신**한다.
부트스트랩(관리자·baseline)은 멱등이라 재실행 불요. 스키마는 게이트웨이 부팅(재시작) 시 자가 마이그레이션.

```bash
# 1) 새 코드 전달 — operator 머신의 '깨끗한 main' 에서 rsync (WIP 섞지 말 것: git clone 또는 worktree at origin/main).
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude dist --exclude logs \
  --exclude backups --exclude '.env*' --exclude '*.bak*' --exclude var/repos \
  -e "ssh -i ~/.ssh/<key>" <clean-main>/  ubuntu@<host>:~/context-ontology/

# 2) 박스에서 반영 — 빌드 → store 멱등 → 재시작 → healthz. kit/ 가 바뀌었으면 --kit.
ssh -i ~/.ssh/<key> ubuntu@<host> 'cd ~/context-ontology && bash deploy/update.sh --kit'
```

| | 최초 설치 (`install.sh`) | 업데이트 (`update.sh`) |
|---|---|---|
| 의존성(docker·node·tmux·claude) | 설치 | 건드리지 않음 |
| `.env`·시크릿 | 없으면 생성 | 보존 |
| store(pgvector) | 생성 | 멱등 반영(이미지/compose 변경만) |
| 빌드·서비스 | 등록·기동 | 빌드 후 **재시작** |
| 첫 관리자·baseline | 시드 | 건너뜀(멱등·이미 존재) |
| 중앙박스 키트 | 설치 | `--kit` 일 때만 갱신 |

- **빌드 실패 시**: `update.sh` 가 재시작 전에 중단 → 기존 게이트웨이 계속 가동(다운 없음).
- **롤백**: 이전 main 커밋을 rsync 후 다시 `update.sh`.
- **git clone 박스**라면 1) 대신 `git pull` 후 `update.sh`.

## 중앙박스 키트 (왜 호스트에도 까나)

게이트웨이의 **중앙박스(웹터미널) 세션은 이 호스트에서 claude 를 돌린다.** 그 세션이 lively MCP 로 조직 맥락을
CRUD 하려면, 멤버 로컬 PC 처럼 **호스트의 claude 에도 lively 키트가 깔려 있어야 한다.** 그래서 설치 7단계에
`install-kit.sh` 를 포함한다(멤버 로컬 설치와 동일 end-state, 단 gateway=localhost·OS무관 경로).

- 키트의 `install-via-curl.sh` 는 `setup-mac.sh` 에만 위임(Mac 전용)이라, 중앙박스/Linux 는 `install-kit.sh` 가
  번들의 OS-무관 자산(`user-install.mjs` + `register-clients.sh`)을 직접 써서 깐다.
- 결과: `~/.lively/{token,gateway-url,context.md,hooks/…}` + `~/.claude/settings.json`(훅 비파괴 머지·auto-approve)
  + `claude mcp add lively`(user scope). 검증: `claude mcp list | grep lively` → `✔ Connected`.
- 단독 재설치: `bash deploy/install-kit.sh` (env: `LIVELY_TOKEN`·`LIVELY_GATEWAY`·`KIT_HARNESS=claude,codex`).
- ⚠ 현재는 호스트 단일 인증/토큰 공유(세션=`agent` 신원). **프로필별 다른 claude 계정은 프로젝트 #269 / 태스크 #271.**

## 디렉토리 구조 (Linux/Mac 패리티가 구조로 드러남)

```
deploy/
  install.sh          # 크로스플랫폼 진입점 (OS 감지 → <os>/provision.sh)
  lib/common.sh       # 공유: 로그·OS감지·시크릿·.env 비파괴 생성·store_up·healthz
  env.example         # .env 문서(시크릿 없음)
  initdb/01-init.sh   # pgvector 최초 init: domainmap DB 생성
  bootstrap-admin.mjs # 첫 관리자(세션 로그인) 시드
  install-kit.sh      # 중앙박스 키트 — 호스트 claude 에 lively(MCP+훅+컨텍스트) 설치
  linux/              # ── Linux 지원 ──
    provision.sh                          # apt·docker·node·claude / systemd 설치
    context-ontology-gateway.service      # systemd 유닛 템플릿
  mac/                # ── macOS 지원 ──
    provision.sh                          # brew·docker·node·claude / launchd 설치
    io.lvly.context-ontology.plist        # launchd plist 템플릿
../docker-compose.yml # store(items-db) + embeddings(profile) + gateway(profile)
../Dockerfile         # 게이트웨이 이미지(full-docker/Option 1 용)
```

## 운영

| 작업 | Linux (systemd) | macOS (launchd) |
|---|---|---|
| 상태 | `systemctl status context-ontology-gateway` | `launchctl print gui/$(id -u)/io.lvly.context-ontology` |
| 로그 | `journalctl -u context-ontology-gateway -f` 또는 `tail -f logs/gateway.log` | `tail -f logs/gateway.log` |
| 재시작 | `sudo systemctl restart context-ontology-gateway` | `launchctl kickstart -k gui/$(id -u)/io.lvly.context-ontology` |
| 코드 반영 | `npm run build && sudo systemctl restart …` | `scripts/restart-gateway.sh` |
| store | `docker compose ps` · `docker compose logs items-db` | 동일 |

**백업(중요):** 조직 지식 전체가 `items-db-data` 볼륨에 있다.
`docker compose exec -T items-db pg_dump -U lively items > backup.sql` (+ domainmap). EC2 면 EBS 스냅샷 병행.

## 보안 메모

- store(pgvector)는 `127.0.0.1` 바인딩 — 외부 노출 안 함.
- 게이트웨이 :8080 은 TLS 미적용(P2) — 공개 전엔 SG/방화벽으로 신뢰 IP 제한, 또는 리버스 프록시(Caddy) 추가.
- `.env`(시크릿)는 0600, `.gitignore` 등재. 정적 토큰은 admin/runtime 불가(kill-switch) — 사람관리는 세션 로그인.

## 추후 (TODO)

- **멀티 프로필 / 프로필별 다른 Claude Code 계정** — 중앙박스 세션이 사용자·프로필별로 다른 클코 계정/인증을 쓰도록.
- 리버스 프록시 + 자동 TLS(Caddy) 프로파일.
- Option 1(러너 분리 → 게이트웨이 컨테이너화), 에어갭 오프라인 번들.
