이건 **runbook-bootstrap-domains**(LLM 프로세스: Step0 스택탐지 ~ Step5 기록)의 **도구 보강 델타**다 — 프로세스 자체는 그 런북을 따르고, Step 1(사실수집)·Step 5(기록)에 아래 신규 도구를 얹는다. (별도 런북 아님.)

## 왜 (제품 갭)
bootstrap-domains 런북 Step 5 는 세션이 **호스트 셸로 `dm ingest < payload.json`**(context-ontology/ 디렉, requires bash)를 직접 실행한다고 전제한다. **MCP 전용(호스트 셸 없음)** 세션은 그 write 경로에 못 닿아 결국 프로즈 위키 문서로 떨어진다. 즉 갭 = "LLM 이 is 에 쓸 손 부재". → write 경로를 MCP/REST 로 노출해 해소.

## Step 1 보강 — 결정론 '사실' helper `dm scan`
`dm scan <repo> <clonePath>` (= `node --env-file-if-exists=.env dist/domainmap/cli.js scan`, DB 무접촉) → `{files[], module_hints[], stack, head}` JSON 한 방. 매번 find/확장자 카운트 수동 대신 이걸 grep/슬라이스로 참조(크니까 통째 컨텍스트 금지). `files`=무손실 사실 바닥, `module_hints`=마커기반 경계 힌트(강제 아님).

## 유닛 경계 = 판단(결정론 아님)
`module_hints` 는 출발점일 뿐. **한 모듈이 두 도메인에 걸치면 하위 디렉터리로 쪼갠다** — 거칠기를 결정론으로 못박으면 다도메인 모듈이 뭉개져 정보 손실(예: 한 모듈이 오리지네이션↔서비싱을 공유). code_unit.path 는 **디렉터리 경로**여야 한다(증분 `aggregate.ts` 가 파일-diff 를 경로 prefix 로 유닛에 정합).

## Step 5 보강 — MCP/REST write 경로 `domainmap_ingest`
호스트 셸 없는(MCP 전용) 세션은 `dm ingest` 대신 **`domainmap_ingest`**(MCP tool / REST `POST /api/ui/domainmap/ingest`)로 동일 payload 를 쓴다. insert-only·trust-first(비-agent 소유 매핑 무클로버)·단일 트랜잭션, actor 는 게이트웨이 스탬프. (셸 있는 세션은 기존 `dm ingest < payload.json` 도 그대로 가능.)

## 토큰규율 (대량 부트스트랩)
읽기=사실파일 grep(파일당 MCP 호출 금지) · 도메인=`category_list` 1회 · 쓰기=ingest **한 콜**(payload=전 유닛+매핑+imports; 건별 `map_code_unit` N회 금지). 대량 payload 는 파일로 떨궈 `curl -X POST /api/ui/domainmap/ingest -d @payload.json`(bearer). 분류의 나머지(남은 unmapped)는 기존 `map_unmapped`(LLM)/수동이 영구히 이어받음.
