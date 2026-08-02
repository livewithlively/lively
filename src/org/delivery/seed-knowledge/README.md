# seed-knowledge — 신규 게이트웨이에 시딩되는 지식의 본문 SoT

여기 있는 `<name>.md`(+ `manifest.json` 메타)는 **코드가 이름으로 전제하는 런북**(#713)을 신규 고객
게이트웨이에 시딩할 때 쓰는 **각색 본문의 원본(SoT)**이다. `seed-content.ts` 가 기동시 idempotent 하게
심는다(신규=삽입, 손 안 댄 시드=갱신, 운영자 편집분=영구 보존).

## 왜 WIKI DB 가 아니라 여기서 오나 (#846)
예전엔 `capture-default-content.mjs` 가 라이블리 dev WIKI DB 의 지식 본문을 **그대로 스냅샷**했다. 그런데
우리 WIKI 본문에는 내부 사고 이야기·`[[내부 링크]]`·사내 이슈번호·**타 고객사 이름**이 섞여 있어, 그게
고객 박스로 새어 나갔다(v0.1.148~150 실측 유출: closeout 메타블록·타 고객사 도메인 구조). → 시딩 본문의
SoT 를 이 디렉터리로 분리해 DB 캡처가 덮지 못하게 했다.

## 편집 규칙
1. **고객 맥락으로 각색한다.** 우리 내부 사고 서사·`[[위키 링크]]`·사내 이슈번호(#nnn 중 내부 프로젝트)·
   사내 인물명·**타 고객사 이름**은 뺀다. 제품 기능 참조(예: MCP 인자 설명)는 남겨도 된다.
2. 본문을 고쳤으면 **`node scripts/sync-seed-knowledge.mjs`** 로 `src/org/delivery/default-content.ts`(baked 런타임
   시드)를 재생성하고 `git diff` 로 확인한다. (DB 필요한 전체 재생성은 `capture-default-content.mjs`.)
3. `npm test`(seed-content.test) 가 default-content.ts ↔ 이 파일들의 바이트 일치 + 내부 흔적 부재를
   강제한다. sync 를 빠뜨리거나 각색을 안 하면 테스트가 깨져 알려준다.
4. 새 지식을 시딩 대상에 추가하려면: `manifest.json` 항목 + `<name>.md` 를 만들고,
   `capture-default-content.mjs` 의 `KNOWLEDGE_NAMES`(코드가 그 이름을 knowledge_get 하는 근거)에도 더한다.

> ⚠ `src/org/delivery/default-content.ts` 의 지식 본문을 **직접 고치지 말 것** — 다음 재생성에 덮여 사라진다
> (그게 #846 이 재오염된 경위다). 지식 본문은 언제나 이 디렉터리가 원본이다.
