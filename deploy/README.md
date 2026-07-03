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

## 한 줄 설치 (bootstrap.sh) — "코드 없이"

`bootstrap.sh` 가 **코드 획득 → install.sh** 를 한 번에 한다. 고객은 소스·git clone·빌드 없이 한 줄:

```bash
curl -fsSL <bootstrap-url> | PUBLIC_URL=http://<host>:8080 BOOTSTRAP_ADMIN_EMAIL=you@org.com ORG_DOMAIN=org.com sh
```

### 구조 — 코드 획득(교체 가능) ↔ 설치(전달 방식 무관)

```
 bootstrap.sh ─ 코드 획득 ──────────────────┐       install.sh ─ 설치(코드가 어떻게 왔는지 모름)
   온라인 : git clone | LIVELY_CODE_URL(tgz) │  →    1 deps  2 .env  3 store  4 build
   오프라인: LIVELY_BUNDLE(로컬 tgz)          │        5 service  6 bootstrap  7 kit
   → APP_DIR 에 풀고 install.sh 실행 ─────────┘       (OFFLINE=1 이면 네트워크 단계 스킵)
```

**설치 로직(install.sh)은 전달 방식과 무관** → 코드 획득만 바꾸면 온라인↔오프라인 전환(install.sh 무수정).

| | 온라인 (기본, 지금) | 오프라인 (에어갭 — 구조만, 번들 CI 는 추후) |
|---|---|---|
| 코드 획득 | `git clone` / `LIVELY_CODE_URL` tgz | `LIVELY_BUNDLE` 로컬 tgz |
| node·deps | install.sh 가 설치 + `npm ci`(node-pty 자동) | 번들에 node_modules 동봉 → `OFFLINE=1` 이 `npm ci` 스킵 |
| 인터넷 | 필요(npm·nodejs·github) | 불필요 |
| 아티팩트 | 작음(코드만) | 큼(node_modules·dist·런타임 동봉) |

- **지금 = 온라인.** 오프라인은 **플래그(`LIVELY_BUNDLE` + `OFFLINE=1`)로 이미 분기**돼 있다 — 남은 건 *살찐 번들(node_modules 동봉)을 굽는 CI* 뿐(에어갭 고객 생기면 추가).
- **private 레포** 다운로드: `LIVELY_CODE_TOKEN`(Bearer) 추가. 공개(OSS) 레포면 토큰 불요(`git clone` 기본).
- 코드만 받고 검증: `LIVELY_FETCH_ONLY=1`.

### 릴리스 발행 (메인테이너 — 태그 푸쉬)

`.github/workflows/release.yml` 가 **`vX.Y.Z` 태그 푸쉬 시 자동**으로: 빌드 → `context-ontology.tgz`(dist+public+kit+deploy+package*, node_modules 미포함 = arch 무관) → GitHub Release 발행.

```bash
git tag v0.1.0 && git push origin v0.1.0     # → Actions 가 Release v0.1.0 + 에셋(context-ontology.tgz) 발행
```

그러면 고객은 버전만 주면 됨 — bootstrap 이 에셋 URL 을 자동 구성:
```bash
curl -fsSL <bootstrap-url> | LIVELY_VERSION=latest PUBLIC_URL=… BOOTSTRAP_ADMIN_EMAIL=… sh
```
(private 레포 동안은 다운로드에 `LIVELY_CODE_TOKEN`(Bearer) 필요 — OSS 공개 시 tokenless.)

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
| 5 서비스+TLS | systemd(Linux) / launchd(Mac) 등록·기동 + `/healthz` 확인 (스키마 자가 마이그레이션) + `LIVELY_DOMAIN` 있으면 Caddy 자동 HTTPS |
| 6 부트스트랩 | 첫 관리자(웹 세션 로그인 계정) 시드 — `deploy/bootstrap-admin.mjs` (⚠ 서비스 기동 뒤에) |
| 7 중앙박스 키트 | 호스트 claude 에 lively 설치(MCP+훅+컨텍스트) — `deploy/install-kit.sh`. **웹터미널 세션이 맥락 CRUD 가능해짐.** |

환경변수: `LIVELY_DOMAIN`(설정 시 자동 HTTPS — 아래 [TLS](#tls-자동-https--caddy)) · `PUBLIC_URL` · `BOOTSTRAP_ADMIN_EMAIL`
· `BOOTSTRAP_ADMIN_PASSWORD`(생략 시 랜덤) · `ORG_DOMAIN` · `WITH_EMBEDDINGS=1`(임베딩 사이드카+provider=http+설치 말미 백필까지 e2e — t4g.large+ 권장) · `FORCE=1`(기존 :8080 감지 무시).

## 임베딩(벡터검색 #172) 켜기

기본 off(검색 = grep 폴백). **기존 지식은 provider 를 켜는 것만으론 임베딩되지 않는다**(쓰기훅은 켠 이후의 신규·수정분만) → 아래 경로는 모두 **기존 지식 백필**을 포함한다.

- **기존 박스 한 방:** `bash deploy/enable-embeddings.sh` — 로컬 Ollama 사이드카(bge-m3) 기동 → `.env` `EMBEDDINGS_PROVIDER=http` → 게이트웨이 재시작 → 기존 지식 백필. 4GB 박스는 RAM 가드로 중단(→ 업사이즈 / 외부 엔드포인트 / `FORCE=1`).
  - 외부 엔드포인트(사이드카 없이): `EMBEDDINGS_BASE_URL=<host> EMBEDDINGS_MODEL=<m> [EMBEDDINGS_AUTH_ENV=<키담은env이름>] bash deploy/enable-embeddings.sh --external`
- **관리탭 UI:** ‘임베딩(벡터검색)’ 섹션 — provider/base_url/model/dim 저장(무재시작) + [기존 지식 임베딩(백필)] 버튼(진행 표시).
- **처음부터:** `WITH_EMBEDDINGS=1 bash deploy/install.sh`.

끄기: `bash deploy/disable-embeddings.sh`(provider off + 사이드카 down — 벡터 데이터는 보존). 모델 스왑: `EMBEDDINGS_MODEL` 변경 후 `node --env-file-if-exists=.env scripts/backfill-embeddings.mjs --model-changed`(차원이 다르면 `--all`).

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

## TLS (자동 HTTPS — Caddy)

**`LIVELY_DOMAIN` 하나면 끝.** 설정하면 `install.sh`(5단계)가 Caddy 리버스 프록시(profile=proxy)를 띄워
**Let's Encrypt 인증서를 자동 발급·갱신**하고 `:443` 을 종단해 네이티브 게이트웨이(`localhost:8080`)로 프록시한다.
`PUBLIC_URL` 은 자동으로 `https://도메인` 이 되고(→ 세션 쿠키 `Secure`), HTTP→HTTPS 리다이렉트·WebSocket(웹터미널)은 Caddy 가 투명 처리한다.

```bash
# 최초 설치부터 HTTPS로 (도메인 A레코드가 이 호스트를 향해야 발급됨)
LIVELY_DOMAIN=gw.org.com BOOTSTRAP_ADMIN_EMAIL=you@org.com ORG_DOMAIN=org.com \
  bash deploy/install.sh
```

**기존 박스에 TLS 추가:** `.env` 에 `LIVELY_DOMAIN=gw.org.com` 한 줄 추가(필요 시 `PUBLIC_URL=https://gw.org.com` 도) → `bash deploy/update.sh`. `proxy_up` 이 Caddy 를 기동한다.

- **전제:** 도메인의 A(또는 AAAA) 레코드가 이 호스트 공인 IP 를 향해야 한다(ACME HTTP-01). 방화벽/SG 는 `80`·`443` 개방. `8080` 직접 공개는 불필요(SG 로 차단, 디버그는 `ssh -L 8080:localhost:8080`).
- **인증서 영속:** `caddy-data` 볼륨(ACME 계정·인증서). 삭제 시 재발급(Let's Encrypt rate-limit 주의).
- **도메인 없이(IP만):** `LIVELY_DOMAIN` 을 비우면 프록시 없음 — `:8080` 직접(신뢰 IP 로 SG 제한) 또는 SSH 터널. Let's Encrypt 는 IP 인증서를 발급하지 않으므로 공개 서비스엔 도메인 필요.
- **커스텀 프록시/사내 CA:** `deploy/Caddyfile` 을 수정하거나, 별도 프록시(nginx 등)를 `localhost:8080` 앞단에 두면 된다.

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
  bootstrap.sh        # 한 줄 설치 진입점(curl|sh): 코드 획득(온라인/오프라인) → install.sh
  install.sh          # 설치 엔진 (OS 감지 → <os>/provision.sh, 7단계). 전달 방식 무관.
  update.sh           # 기존 박스 업데이트(빌드→재시작→healthz, --kit)
  uninstall.sh        # 제거(install 역연산): 서비스·컨테이너·키트 제거 / --purge=볼륨·.env·디렉토리까지
  lib/common.sh       # 공유: 로그·OS감지·시크릿·.env 비파괴 생성·store_up·healthz·proxy_up(TLS)
  Caddyfile           # Caddy 리버스 프록시 설정(자동 HTTPS — LIVELY_DOMAIN)
  env.example         # .env 문서(시크릿 없음)
  initdb/01-init.sh   # pgvector 최초 init: domainmap DB 생성
  bootstrap-admin.mjs # 첫 관리자(세션 로그인) 시드
  bootstrap-baseline.mjs # 익명 조직 baseline(페르소나·규칙) 시드 — 빈 경우만
  install-kit.sh      # 중앙박스 키트 — 호스트 claude 에 lively(MCP+훅+컨텍스트) 설치
  enable-embeddings.sh  # 임베딩(벡터검색) 켜기 — 사이드카→provider=http→재시작→기존 지식 백필(기존 박스, 멱등)
  disable-embeddings.sh # 임베딩 끄기 — provider off + 사이드카 down(벡터 데이터 보존)
  linux/              # ── Linux 지원 ──
    provision.sh                          # apt·docker·node·claude / systemd 설치
    context-ontology-gateway.service      # systemd 유닛 템플릿
  mac/                # ── macOS 지원 ──
    provision.sh                          # brew·docker·node·claude / launchd 설치
    io.lvly.context-ontology.plist        # launchd plist 템플릿
../docker-compose.yml # store(items-db) + embeddings(profile) + gateway(profile) + caddy(profile=proxy, TLS)
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
- **TLS:** `LIVELY_DOMAIN` 설정 시 Caddy 자동 HTTPS(위 [TLS](#tls-자동-https--caddy)) — 공개 서비스는 이걸 권장. 미설정(IP 직결)이면 :8080 을 SG/방화벽으로 신뢰 IP 제한.
- `.env`(시크릿)는 0600, `.gitignore` 등재. 정적 토큰은 admin/runtime 불가(kill-switch) — 사람관리는 세션 로그인.

## 추후 (TODO)

- **멀티 프로필 / 프로필별 다른 Claude Code 계정** — 중앙박스 세션이 사용자·프로필별로 다른 클코 계정/인증을 쓰도록.
- Option 1(러너 분리 → 게이트웨이 컨테이너화), 에어갭 오프라인 번들.
