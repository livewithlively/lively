// v6 knowledge capability — 지식 CRUD + lifecycle + 카테고리 연결.
//  레거시 ctx_*/memory_* 와 병행(REST-only 로 시작 — 웹 지식 탭이 소비). MCP 노출은 컷오버에서 일괄.
//  scope='memory'(조직 지식 — ctx_* 와 동일). injection/provenance 는 v6 직교축.
//
// #1313 R57 — 실체는 knowledge/ 로 분할됐다(shared·read·authoring·classification·wiki-ui·review).
//  이 파일은 소비자(capabilities/index.ts)의 import 스펙 "./knowledge.js" 를 그대로 두기 위한 조립 shim 이다:
//  각 도메인 배열을 **원본 등록 순서 그대로** concat 한다(그 순서가 tools/list 순 · REST 마운트 순 · 표면 스냅샷).
import type { Capability } from "./types.js";
import { readStaticCapabilities, readNamedCapabilities } from "./knowledge/read.js";
import { authoringCapabilities, authoringMoveCapabilities } from "./knowledge/authoring.js";
import { classificationInboxCapabilities, classificationCapabilities } from "./knowledge/classification.js";
import { wikiUiStaticCapabilities, wikiUiNamedCapabilities } from "./knowledge/wiki-ui.js";
import { reviewCapabilities } from "./knowledge/review.js";

// ⚠ REST 마운트 순서 주의 — knowledgeGrep(REST 경로는 그대로 /knowledge/search — 웹 지식탭 소비)는
//  반드시 knowledgeGet(/knowledge/:name) **앞**에 둔다(web.ts 가 배열순 app.get 마운트 → Express 선매치;
//  뒤에 두면 'search'/'overview'가 :name 으로 잡혀 404). MCP 등록은 이름목록 기반이라 순서 무관.
//  knowledge_graph(/knowledge-graph)·knowledge_link(/knowledge/:name/link)는 :name 단일세그먼트와 안 겹친다(경로 깊이 상이).
//  #592 정적 경로(knowledge-view-config·knowledge-comments)도 같은 규칙으로 :name 계열 **앞**에 둔다
//  (현 Express 패턴상 세그먼트가 달라 실충돌은 없지만, 순서 규칙을 지켜 미래 경로 추가에도 안전).
export const knowledgeCapabilities: Capability[] = [
  ...readStaticCapabilities,            // list · grep · search · similar · graph · tree
  ...wikiUiStaticCapabilities,          // #592 정적 경로 — /:name 계열보다 먼저
  ...reviewCapabilities,                // #783 수정 검토 큐 · #802 검토 카운트
  ...classificationInboxCapabilities,   // #982 미분류 인박스 · #1102 proposed 분류 인박스(정적, :name 보다 먼저)
  ...readNamedCapabilities,             // knowledge_get(/knowledge/:name)
  ...authoringCapabilities,             // save · set_lifecycle · set_wiki · delete
  ...classificationCapabilities,        // link_category · propose_category · link
  ...wikiUiNamedCapabilities,           // #592 :name 하위 경로(props-ui · comments)
  ...authoringMoveCapabilities,         // #592 트리 이동(/knowledge/:name/move — 원본 배열 마지막 자리)
];
