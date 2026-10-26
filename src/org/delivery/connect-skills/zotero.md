# liv-connect-zotero — Zotero 연결

연구자의 Zotero 라이브러리에서 **논문마다 서지·초록과 그 논문에 단 하이라이트·코멘트·노트**를 한 자료로 묶어 라이블리 자료함으로 모은다. 앱 등록 없이 **각자의 API 키**로 연결하고, 수집기는 **사람마다 하나**다(내 라이브러리를 켜도 다른 사람의 수집은 그대로다).

## 길 고르기

`org_connect_status` 의 `zotero` 줄을 본다. Zotero 의 길은 개인 토큰(`token`) 하나다(여기서 토큰은 API 키다) — 그 길의 `state` 마다:
- `connect` → «연결»부터 · `set_scope` → «모을 범위»부터 · `collecting` → «확인»만 하고 범위·종류를 바꿀지 묻는다.
- `ask_admin` → 키는 넣었지만 이 사람은 수집을 켤 수 없다(워크스페이스 관리 권한이 없다) — 관리자에게 이 사람 권한을 부탁하게 한다. AI 가 이 사람의 Zotero 를 직접 읽는 것(아래 «AI 가 바로 읽기»)은 키만으로 된다.
- 상태를 더 자세히 볼 때는 `org_zotero_collect` 다(내 연결 `me_connected` · 켜짐 `enabled` · 범위·종류 `scope` · 마지막 실행 `last_run` · 수집기 `collector_id`). 이 도구는 **부른 사람의** 수집기를 보여 준다.

## 연결 — API 키

1. 사람에게: «zotero.org/settings/keys/new 를 열어 주세요(로그인이 필요해요). 설정 메뉴에서 찾으려면 [Create new private key] 버튼이 있는 화면입니다.» 메뉴 이름(«Feeds/API» · «Security»)은 계정마다 다르게 보여 주소로 안내한다.
2. 켤 칸을 하나씩 말한다 — **Personal Library 의 «Allow library access» 와 «Allow notes access»**(노트 권한은 따로다 — 빠지면 노트가 안 온다). 연구실 그룹도 모으려면 **Default Group Permissions 를 «Read Only»**. 쓰기 권한(«Allow write access»)은 켜지 않는다 — 라이블리는 읽기만 한다. 그리고 [Save Key].
3. 키 넣기 — 공통 규칙 6의 경고를 먼저 하고: `me_credential_set { kind:"zotero_token", scope_key:"", secret:"<키>", meta:{ auth_header:"Zotero-API-Key", token_prefix:"" } }`. `scope_key` 는 반드시 비워 둔다. 키는 저장 직후 한 번만 보이니 그 자리에서 복사하게 한다.
4. `me_credential_verify { kind:"zotero_token" }` 로 확인한다. «노트 권한이 꺼져 있어요» 같은 말이 붙어 오면 그대로 전하고, zotero.org/settings/keys 에서 그 키의 권한에 그 칸을 켜게 한다(화면에서 바꿀 수 없으면 새 키를 만들어 3부터 다시 한다).

## 모을 범위와 종류

- 라이브러리 목록: `org_collect_scope_options { system:"zotero" }` — 내 라이브러리와 키에 열린 그룹이 나온다.
- **비우면 이 키가 읽을 수 있는 라이브러리 전부**를 가져온다. 사람에게 한 번 묻는다: «내 라이브러리에 연구와 관계없는 자료(개인 메모·취미 등)도 섞여 있나요?» 섞여 있으면 둘 중 하나로 좁힌다:
  - 라이브러리 고르기: `scope:{ libraries:"groups/123 users/456" }`.
  - 컬렉션 고르기: 그 컬렉션을 zotero.org 웹 라이브러리에서 열면 주소에 `collections/<8자>` 가 있다 — 그 8자(또는 주소 그대로)를 받는다. `scope:{ collections:"ABCD1234" }`. 컬렉션을 넣으면 **그 컬렉션(하위 포함)만** 모은다. 다른 라이브러리를 통째로 함께 모으려면 그 라이브러리를 `libraries` 에도 적는다(예: `libraries:"groups/123"` + `collections:"ABCD1234"`). 고른 컬렉션을 어디서도 못 찾으면 수집이 실패로 멈춘다 — `last_run` 이 그 말을 한다.
- 종류(기본값 그대로가 보통이다 — 사람이 바꾸고 싶다고 할 때만):
  - `include_annotations` 하이라이트·코멘트(기본 on) · `include_notes` 노트(기본 on)
  - `include_fulltext` 전문 색인(기본 off — 논문 본문이라 연구자의 생각이 아니고, 저작권·용량 부담이 있다)
  - `include_auto_tags` 자동 태그(기본 off — DB 에서 따라온 주제어라 잡음이 많다. 손으로 단 태그는 늘 모은다)
- 켜기: `org_zotero_collect_set { enabled:true, scope:{ libraries:"…", collections:"…", include_fulltext:"off" } }` — 범위·종류는 꼭 `scope` 안에. 범위를 정하지 않으면 `scope` 없이 켠다.
- **공개범위를 사실대로 말한다**: 개인 라이브러리에서 온 자료는 그 사람에게 잠긴 채 들어온다 — 이 워크스페이스의 «자료 공개범위»가 켜져 있으면 그 사람만 보고, 꺼져 있으면 잠금이 적용되지 않아 구성원이 함께 본다(나중에 켜면 그때까지 모인 것도 잠긴다). 그룹 라이브러리 자료는 함께 본다.
- 같은 그룹 라이브러리를 여러 사람이 모으면 자료는 한 건으로 합쳐지고, **마지막에 읽은 사람의 종류 설정**이 본문에 남는다. 그룹을 함께 모으는 사람끼리는 종류를 기본값 그대로 두게 권한다.

## 확인

- 처음 켜면 첫 수집이 바로 시작된다. 라이브러리가 크면(수천 편) 몇 분 걸린다. 1~2분 뒤 `org_zotero_collect` 의 `last_run` 을 보고, 들어온 자료는 `source_list { system:"zotero", limit:5 }`.
- Zotero 는 **바뀐 논문만** 따라간다. 종류·라이브러리·컬렉션을 바꿨거나, 껐다가 다시 켰으면 `org_collector_sync_run { id:<collector_id>, full:true }` 로 처음부터 다시 읽게 한다(화면의 [지금 전부 다시 읽기]와 같다). 안 하면 이미 모은 논문은 옛 설정 그대로다.
- 자료가 서지만 있고 하이라이트가 하나도 없으면 두 가지를 묻는다: ① 다른 PDF 앱(Acrobat 등)으로 주석을 달았나 — 그런 주석은 PDF 파일 안에만 있어 Zotero 가 동기화하지 않는다. Zotero 에서 그 PDF 를 열고 [Import Annotations] 를 하면 들어온다. ② Zotero 데스크톱 앱의 동기화가 켜져 있나 — 라이블리는 zotero.org 에 동기화된 것만 읽는다.
- 켤 때 «Zotero 논문 정리 규칙»(증류기 `zotero-papers`)이 **꺼진 채로** 함께 만들어진다. 주석·노트가 있는 논문만 지식이 되고, 서지만 있는 논문은 검색용 자료로 남는다. 하이라이트 색에 뜻을 두는지(예: 노랑=핵심, 빨강=반박) 한 번 묻고, 뜻이 있으면 `me_liv_profile_set { decision:{ what:"Zotero 색 규칙", why:"<사람이 말한 규칙>" } }` 로 남긴다. 정리하려면 사람에게 확인받고 `org_distiller_zotero_ensure { enable:true }`.

## AI 가 바로 읽기

키를 저장하면 AI 가 그 사람의 Zotero 를 직접 읽는 도구(`zotero_search_items` · `zotero_get_item` · `zotero_get_item_children` · `zotero_list_collections` · `zotero_list_collection_items` · `zotero_get_fulltext` · `zotero_list_groups`)가 워크스페이스에 생긴다. 개인 라이브러리는 `libraryType:"users", libraryId:<내 userID>` 로 부르고, 그 userID 는 `me_credentials` 의 `zotero_token` 줄 `meta.user_id` 에 있다. 하이라이트는 논문이 아니라 **PDF 첨부의 children** 이다 — 논문 children 으로 첨부 key 를 얻고, 그 첨부 key 로 한 번 더 부른다.
