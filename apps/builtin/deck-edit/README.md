# 장표 수정 (deck-edit)

세션의 AI 가 만든 HTML 산출물(장표 · 보고서 · 시안)을 **장 단위로 보며 글을 바로 고치고, 의견을 달고, 그 묶음을 세션의 AI 에게 곧바로 보내는** 앱입니다. 세션에 붙이면(＋ → 이 세션에 붙이기) 사이드바 탭으로 뜨고, 붙어 있는 동안 세션의 AI 에게 이 앱의 지침(`agent.instructions`)이 실립니다 — HTML 을 만들면 앱에 판으로 올리고, 보낸 묶음을 받으면 원본 소스를 고쳐 새 판을 올리고 의견마다 답을 적습니다.

기획안 · 실측 · 결정은 프로젝트 #4592(라이블리 지식 `deck-edit-app-plan-v1-4592`, 실측 `deck-app-measure-4593`).

## 화면

| 폭 | 모양 |
|---|---|
| 사이드바(640px 미만) | 장 번호 띠 · 작은 장표(끌 수 있음) · 글 줄 목록 · 아래 [AI에게 보내기] |
| 크게 보기 | 장표와 글 줄을 **2열**(옆) 또는 **2행**(위아래, 장표 폭 가득) — 머리줄에서 고르고 사람마다 저장 |

글 줄을 누르면 바로 고칠 수 있고 장표에 즉시 반영됩니다. `Tab` 은 그 글의 의견 칸. 장표의 글을 눌러도 그 줄로 옵니다. 장 전체 의견 · 문서 전체 의견은 따로 있습니다. 보낸 줄은 접히고(설정), AI 의 답(반영함 · 반영 안 함 · 안 올림)이 그 줄 옆에 붙습니다. 한 장에 안이 여럿이면 장표 아래에서 고릅니다.

표시 설정(⚙ · 나에게만): 배치 2열/2행 · 장표 크기 · 글 줄 글자 · 보낸 줄 접기 · 좁은 화면의 작은 장표. `lively.prefs` 에 저장됩니다(호스트가 아직 지원하지 않으면 이번 열기 동안만).

## 표

| 표 | 뜻 |
|---|---|
| `docs` | 문서 하나(doc · title · session · latest_ver · source_path) |
| `versions` | 판 = 머리 1행(kind head · seq 0) + 장 N행(kind slide · seq 1… · slide_id · variant) + 꼬리 1행(kind tail). 머리의 큰 data: 자원은 `__ASSET:<sha256>__` 자리표 |
| `assets` | 글꼴 · 그림. sha256 키, 990,000자 이하 조각(seq) |
| `comments` | 고친 글(edited)과 의견(note)을 한 행에. scope = unit(글 줄) · slide(장 전체) · doc(문서 전체). bundle = 보낸 묶음 번호. status = draft · sent · applied · declined · options. reply = AI 의 답 |
| `picks` | 장마다 고른 안(variant) |
| `pins` | AI 가 특정 글(match 가 든 글)에 붙인 메모 |

글 줄(unit)은 저장하지 않고 판의 HTML 에서 화면이 매번 뽑습니다. `unit_key` = `장 id|줄 번호|원문 앞 20자`. 새 판에 같은 원문이 있으면 안 보낸 의견이 따라오고, 없으면 「옛 판 의견」으로 남습니다.

## 올리기 (AI 가 세션에서)

```
node bin/deck-push.mjs --doc <문서이름> [--title <제목>] <html>
node bin/deck-push.mjs --doc <문서이름> --variant <안 이름> [--slides a,b] <html>   # 같은 판에 안 덧붙이기
```

세션 안에서 돌리면 토큰(`~/.lively/token`) · 게이트웨이(`~/.lively/gateway-url`) · 세션(`LIVELY_SESSION_ID`)을 알아서 씁니다. HTML 을 머리 · 장 · 꼬리로 나누고(섹션 `section.page` 바깥 것만 장 · 없으면 문서 전체가 장 하나), 큰 data: 자원은 조각으로 한 번만 올리고, 문서가 쓰는 글꼴 이름 가운데 `@font-face` 가 없는 것은 첫 글꼴 자원으로 별칭을 겁니다(앱 안은 네트워크가 막혀 CDN 글꼴이 조용히 깨지기 때문). 외부 참조(link · @import · url(http))는 경고로 알립니다. 스크립트가 없는 세션은 `app_pull deck-edit` 로 받습니다.

## 그리는 방식 (알아 둘 것)

앱 화면은 샌드박스 iframe 이고 장표는 그 **안의 중첩 iframe(srcdoc)** 에 그립니다. 중첩 문서는 출처가 따로라 앱이 DOM 에 못 닿으므로, 머리에 대리 스크립트를 끼워 postMessage 로 글 줄 뽑기 · 고치기 · 좌표를 주고받습니다(실측 #4593). 글 줄을 뽑는 규칙은 세일즈 덱 워딩 시트(`project/4577/세일즈덱/rv3/sheet.js`)에서 옮겼습니다: 굵게 · 색 꼬리표는 지키고, 숨은 글 · 번호 동그라미 · 쪽 번호는 뺍니다. 자식 문서에서 `localStorage` 는 쓸 수 없습니다.

## 이 앱을 고치기

세션에 「장표 앱 글 줄 칸을 아래로 내려 줘」처럼 말하면 AI 가 `app_pull deck-edit` 로 소스를 받아 `ui/index.html` 을 고치고 `app_save` 로 저장합니다(워크스페이스 판 · 모두에게 적용). 되돌리기는 앱 탭 ⋯ 메뉴. 고칠 때 지킬 것: 폼 제출 금지(click · keydown) · 한글 조합 중 Enter 무시(`isComposing`) · 외부 스크립트 · 네트워크 없음 · `lively.store.onChange` 로 바깥 변경 반영 · 글 12px 미만 금지.

## 시험

- `node scripts/deck-push.test.mjs` — 나누기 · 자원 분리 · 조각 · 글꼴 별칭 · 외부 참조 · plan 행 모양.
- `node scripts/builtin-app-ui-sandbox.test.mjs` — 폼 태그 0(빌트인 전부 자동 대상).
- `node scripts/icon-table.test.mjs` — 아이콘 `deck` 과 색 토큰 `--gi-c-deck`(대비 3:1).
