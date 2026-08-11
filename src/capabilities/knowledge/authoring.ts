// 지식 저작 표면(#1313 R57) — 저장(replace/append)·lifecycle·WIKI 핀·삭제(휴지통)·트리 이동.
//  본문을 바꾸는 경로가 여기 모여 있다: 인입 허용선 게이트(#783)·append 병합(#921)·중복감지(#172)·
//  시딩 지식 경고(#846)·위키링크 엣지(#907)가 전부 이 파일의 저장 경로를 지난다.
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import type { Capability, CapabilityCtx } from "../types.js";
import type { LivelyUser } from "../../context.js";
import {
  upsertKnowledge, setKnowledgeLifecycle, getKnowledgeLifecycle, setKnowledgeWiki, deleteKnowledge,
  findSimilarKnowledge, moveKnowledge, appendBody, isDuplicateAppend, stampSessionVisibility, slugify,
  applyKnowledgeEdits, type KnowledgeEdit,
  setKnowledgeTitle,
} from "../../v6/knowledge-store.js";
// #783 인입 허용선 게이트 — 에이전트(MCP) 저작 지식의 자동 검토대기 + 기존 지식 수정 검토 큐.
import { resolveKnowledgeGate } from "../../v6/knowledge-gate.js";
import { proposeRevision, pendingStagedRevisionId } from "../../v6/knowledge-revision-store.js";
import {
  assertKnowledgeWritable, BODY_MD_MAX, DEDUP_WARN_SIMILARITY, classificationInfo, seedSyncWarning, wikiLinkInfo,
} from "./shared.js";
// #1442 소프트캡 — 짧은 메타 필드의 길이 초과가 body_md 전체를 튕기지 않게 한다(서버 조정 + 응답 capped).
import { SOFT_CAPS, applySoftCaps, softCapHint } from "../soft-cap.js";

// #1442 소프트캡 — 아래 다섯 짧은 필드(name·title·supersedes·parent_name·change_note)엔 zod .max() 를 두지
//  않는다. SDK 는 검증을 핸들러 앞에서 하므로 그 max 가 body_md(최대 200,000자)까지 통째로 튕겨 재전송을
//  부르고, 그 실패는 mcp_call_log 에도 안 남았다. 상한은 describe(softCapHint)로 광고하고 조정은
//  핸들러(applySoftCaps)가 한다 — 표는 soft-cap.ts SOFT_CAPS.knowledge_save 하나뿐이다.
const CAPS = SOFT_CAPS.knowledge_save;
const knowledgeSaveInput = {
  name: z.string().optional()
    .describe(`지식 이름(슬러그) — 없으면 title·본문에서 자동 생성. 기존 지식을 고칠 땐 그 이름을 그대로. ${softCapHint(CAPS.name)}`),
  title: z.string().optional()
    .describe(`표시 제목 — 한 줄 라벨이다(문서의 논지·범위를 담되 문단이 아니다). 더 긴 설명·부제는 본문 첫 헤딩으로 내려라. ${softCapHint(CAPS.title)}`),
  // body_md 는 DB 상 TEXT(무제한) — 이 max 는 폭주/실수 입력(붙여넣은 바이너리·base64·무한생성) 차단용 방어 상한일 뿐이다.
  //  구 40,000 은 정상 장문 설계문서(#534: 45k자 doc 이 쪼개짐)를 튕겨 무손실 저장을 막았다 → 200,000(≈50k토큰)으로 상향.
  //  임베딩은 별도로 8,000자 절단(embeddingInputText), grep 은 응답에서 body_md 제외, get 은 부분읽기 — 이 값에 의존하는 하류 없음.
  //  min(1)은 zod 에선 완화(#592: 폴더는 빈 본문 허용) — is_folder=false 의 min 1 은 handler 가 강제(기존 계약 불변).
  //  #921: mode='append' 면 이 값의 의미가 '전문'에서 '조각'으로 바뀐다 → describe 로 스키마에 명시(설명문만 믿게 두지 않는다).
  // #1531 optional 로 완화 — mode='edit' 는 본문을 **보내지 않는다**(서버가 edits 로 만든다). 그 외 모드의
  //  누락은 핸들러가 잡는다(zod 로 필수를 강제하면 edit 호출이 스키마 단계에서 튕겨 도달조차 못 한다).
  body_md: z.string().max(BODY_MD_MAX).optional()
    .describe("본문 전문(mode 미지정·replace 필수). **mode='append' 면 전문이 아니라 기존 본문 끝에 덧붙일 '조각'** · **mode='edit' 면 보내지 않는다**(edits 로 지정)."),
  // #1600 한 줄 요지 — 목록에서 사람이 읽는 줄. **AI 에게는 돌려주지 않는다**(검색·주입·응답에서 제외).
  //  그래서 여기 쓴 말이 AI 판단에 섞이지 않는다 → 정확한 용어보다 **쉬움**을 택하라.
  summary: z.string().optional()
    .describe("사람이 목록에서 읽을 **한 줄 요지**(#1600) — 12살이 읽어도 아는 말로 **한 문장**. "
      + "이슈번호(#1600)·영문 약어·내부 은어·파일 경로·커밋 해시 금지. 결론부터 쓴다. 60~120자 권장. "
      + "⚠ 이 값은 **AI 에게 반환되지 않는다**(임베딩·검색·MCP 응답에서 제외 — 쉬운 요약이 원문 대신 근거로 쓰이는 걸 막는다). "
      + "오직 사람이 보는 목록·카드에만 뜬다. "
      + "나쁜 예 \"#1595 AGPL 구독→영구 BM 판정: prod copyleft 0·CLA 1조로 법적 가능하나 역선택·지원원가 영구화\" / "
      + "좋은 예 \"프로그램을 한 번 사고 계속 쓰게 하는 방식은 법으로는 되지만, 우리한테는 손해라서 권하지 않습니다.\""),
  provenance: z.enum(["authored", "observed"]).optional(),
  lifecycle: z.enum(["active", "pending"]).optional()
    .describe("#638 자동 인입(distill 등)이 검토대기로 저장할 때 pending — 기본 목록·검색·주입에서 격리(승인=set_lifecycle active). 미지정=active(사람 저작 기본). superseded/archived 는 set_lifecycle 로만."),
  supersedes: z.string().optional()
    .describe(`이 지식이 대체하는 기존 지식의 name. ${softCapHint(CAPS.supersedes)}`),
  type: z.enum(["decision", "concept", "how-to", "reference", "research", "entity"]).optional()
    .describe("page-type(#290, 신규 필수): decision(결정·ADR)|concept(개념·배경·도메인설명)|how-to(런북·절차)|reference(사양·참조)|research(조사·분석)|entity(사람·조직·제품)"),
  category: z.string().optional().describe("분류 key 1개(단일 — category_list). 신규 필수."),
  is_folder: z.boolean().optional()
    .describe("#592 폴더 노드 — true 면 트리 그룹핑용 폴더(title 필수, body_md 빈 문자열 허용). 미전송 시 기존값 보존."),
  parent_name: z.string().min(1).optional()
    .describe(`#592 트리 위치 — 부모 지식/폴더 name(생성 시 배치). 이동은 knowledge_move. 미전송 시 기존값 보존. ${softCapHint(CAPS.parent_name)}`),
  mode: z.enum(["replace", "append", "edit"]).optional()
    .describe("#921/#1531 replace(기본)=body_md 로 전문 교체(종전 동작) · append=body_md('조각')를 기존 본문 끝에 덧붙임(구분 빈 줄은 서버가 정규화) · edit=edits 로 본문 **일부만** 정확일치 치환(문서 중간을 고칠 때). append·edit 는 기존 지식 전용(name 필수)."),
  // #1531 edit — 문서 중간을 고치면서 전문을 되보내지 않는 유일한 길. append 는 끝에만 붙는다.
  edits: z.array(z.object({
    old: z.string().min(1).describe("바꿀 기존 텍스트 — 공백·줄바꿈까지 원문 그대로. 본문에 정확히 한 번 있어야 한다."),
    new: z.string().describe("그 자리에 넣을 텍스트. 빈 문자열이면 삭제."),
    replace_all: z.boolean().optional().describe("같은 텍스트가 여러 곳에 있고 전부 바꿔야 할 때만 true."),
  })).optional()
    .describe("mode='edit' 전용. 순차 적용되며, old 를 못 찾거나 여러 곳에서 찾으면 **저장 자체가 실패한다**(조용히 넘어가지 않는다)."),
  change_note: z.string().optional()
    .describe("#968 변경 요약 — **기존 지식을 고칠 땐 무엇을·왜 바꾸는지 함께 보내라**. "
      + "⚠ **12살이 읽어도 아는 말로 한 문장**(#1600): 이슈번호(#1600)·영문 약어·내부 은어·파일 경로·커밋 해시를 쓰지 마라. "
      + "이 문장은 사람이 보는 '수정 기록' 화면에 **그대로** 뜬다 — 거기 있는 사람은 이 프로젝트를 모른다. "
      + "나쁜 예 \"#1600 조사 산출 + summary 인자 부재 특정\" / 좋은 예 \"위키가 왜 사람에게 안 읽히는지 다시 조사한 결과를 덧붙였습니다\". "
      + "없으면 사람이 바뀐 줄만 보고 판단해야 한다. "
      + softCapHint(CAPS.change_note)),
};
type KnowledgeSaveInput = z.infer<z.ZodObject<typeof knowledgeSaveInput>>;
export const knowledgeSave: Capability = {
  name: "knowledge_save",
  title: "지식 저장",
  description:
    "지식 전문 저장. **신규는 category(분류 key 1개 문자열) + type(page-type) 둘 다 필수(#290)** — type=decision|concept|how-to|reference|research|entity. 교차주제는 카테고리 복수태깅이 아니라 knowledge_link 로. provenance 포함(지식은 항상 recalled — '항상 주입'은 관리탭 '세션 주입' 섹션 문서로만, knowledge_set_wiki 로 인덱스 핀). name 없으면 자동 슬러그. " +
    "**본문의 [[name]] 은 저장 시 자동으로 지식↔지식 엣지가 된다(#907)** — 관련 지식은 그냥 본문에 [[name]] 으로 적어라(knowledge_link 를 따로 부를 필요 없다). 본문이 진실이라 [[name]] 을 빼면 그 엣지도 사라진다. " +
    "문법은 Obsidian 과 동일: [[name]] · [[name|표시글]]('|' 뒤는 표시 텍스트지 관계가 아니다) · [[name#헤딩]] · ![[name]]. 자동 엣지는 전부 relation=related — **related 가 아닌 관계(refines·contradicts·depends_on)는 knowledge_link 로 명시**하라(그 엣지는 본문과 무관하게 보존된다). 코드펜스·인라인코드 안의 [[…]] 는 링크로 잡히지 않는다(문법 예시를 쓸 때 유용). " +
    "응답의 wikilink_warning 은 본문이 **없는 지식**을 가리켰다는 뜻이다(저장은 성공) — 오타면 고치고, 아직 없는 지식이면 그대로 둬도 대상이 생기는 대로 자동으로 이어진다. " +
    "**중복 방지(중요): 신규로 만들기 전에 knowledge_similar(또는 knowledge_search)로 같은 내용이 이미 있는지 먼저 확인하라.** 있으면 새로 만들지 말고 그 지식을 **같은 name 으로 갱신**하라(에이전트는 자기 글을 삭제할 수 없으니 사후 정리보다 사전 확인이 맞다). " +
    "신규 저장 응답에 similar 가 오면(유사도 높음) 중복일 수 있으니 — 별개 주제가 아니라면 supersedes 로 기존을 대체하거나 한쪽으로 병합을 검토하라. " +
    "**검토 게이트(#783): 조직이 '에이전트 지식 검토'를 켜 두면** 네가 저장한 지식은 곧바로 유효해지지 않고 사람 승인 대기로 갈 수 있다 — 응답의 gate 필드가 그 결과를 알려준다(pending=검토대기 저장 · stage=수정 제안만 접수, 라이브 본문 미변경 · review=반영됐으나 사후검토 대상). " +
    "gate 가 오면 그 사실을 사용자에게 그대로 알려라(‘저장했다’가 아니라 ‘검토 대기로 접수됐다’). 게이트가 꺼져 있으면 gate 필드는 없고 종전처럼 즉시 반영된다. " +
    "**시딩 지식 경고(#846): 응답에 seed_warning 이 오면** 이 지식은 신규 고객 게이트웨이에 시딩되는 런북이라, 이 WIKI 편집은 고객이 받는 각색 스냅샷(src/org/delivery/seed-knowledge/…)에 자동 반영되지 않는다 — 안내대로 그 파일도 갱신하고, 그 사실을 사용자에게 알려라. " +
    "**append 모드(#921): 기존 문서에 내용을 보탤 땐 mode='append' 를 써라** — 이때 body_md 는 전문이 아니라 **덧붙일 조각**이고, 서버가 기존 본문 끝에 빈 줄로 잇는다. " +
    "전문을 읽어와(knowledge_get) 재조립해 통째로 되보내지 마라 — 원문이 그대로 보존되고(네가 재출력하며 생기는 요약·드리프트·누락이 없다) 전문이 컨텍스트를 오갈 일도 없다. " +
    "기존 지식 전용(name 필수 · 신규는 mode 없이 만들고 · 외부 미러(observed)엔 불가), 응답엔 본문 전문 대신 증분 요약(appended)만 온다. " +
    "**edit 모드(#1531): 문서 '중간'을 고칠 땐 mode='edit' + edits=[{old,new}] 를 써라** — append 는 끝에만 붙으므로 타임라인 중간 삽입·표의 수치 교체·낡은 항목 갱신엔 못 쓴다. " +
    "그때 replace 로 전문을 되보내면 네가 4만 자를 받아쓰게 되고, 그 전사 중에 **손대지 말아야 할 문장이 깨진다**(실측: 무관한 쉼표가 여는 괄호로 바뀌어 괄호가 닫히지 않았다). " +
    "edit 는 old 를 정확일치로 찾아 그 자리만 바꾸므로 나머지는 문자 단위로 보존된다. old 는 공백·줄바꿈까지 원문 그대로여야 하고, **못 찾거나 여러 곳에서 찾으면 저장이 실패한다**(조용히 넘어가지 않는다 — 여러 곳이면 앞뒤를 더 붙여 유일하게 만들거나 replace_all: true). " +
    "**변경 요약(#968): 기존 지식을 고칠 땐 change_note 를 함께 보내라 — 12살이 읽어도 아는 말로 한 문장**(#1600, 이슈번호·약어·경로 금지). " +
    "사람이 보는 '수정 기록' 화면에 그대로 뜨고, 거기 있는 사람은 이 프로젝트를 모른다. " +
    "**길이 상한(#1442): 짧은 필드(title 200 · name/supersedes/parent_name 64 · change_note 600자)를 넘겨도 이 호출은 실패하지 않는다** — " +
    "서버가 그 필드만 조정(자르기/참조 무시)하고 본문은 그대로 저장한 뒤 응답 capped 로 무엇을 어떻게 조정했는지 알려준다. " +
    "그러니 **본문을 다시 실어 재시도하지 마라**(capped 가 왔다고 저장이 실패한 게 아니다). 잘린 제목을 고치려면 **knowledge_set_title**(name+title — 본문 불요)을 쓰고, 애초에 제목은 한 줄로 짧게 쓰고 긴 설명은 본문 첫 헤딩으로 내려라.",
  scope: "memory",
  input: knowledgeSaveInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const is_folder = typeof b.is_folder === "boolean" ? b.is_folder : undefined;
        // #921 mode — REST 는 zod 를 안 타고 이 화이트리스트가 유일한 검증이라, 미인식 값을 조용히 흘리면
        //  append 의도가 replace 로 떨어져 '조각이 문서를 통째로 교체'한다 → 여기서 fail-closed(provenance/lifecycle 과 같은 모양).
        const mode = b.mode ? String(b.mode) : undefined;
        if (mode && !["replace", "append", "edit"].includes(mode)) throw new HttpError(400, "mode 는 replace|append|edit");
        // #921 append 의 body_md 는 '조각' — trim 하면 첫 줄의 들여쓰기(들여쓴 코드블록)가 MCP 와 달리 REST 에서만 깨진다.
        //  빈 값 검증만 trim 으로 하고 원본은 보존한다(구분 빈 줄·앞뒤 개행 정규화는 appendBody 가 한다).
        const raw = String(b.body_md ?? b.note ?? "");
        const body_md = mode === "append" ? raw : raw.trim();
        // #1531 edit — 본문은 edits 가 만든다. 여기선 모양만 검증하고(빈 배열·타입) 적용은 어댑터가 한다.
        const edits = mode === "edit"
          ? (Array.isArray(b.edits) ? (b.edits as Array<Record<string, unknown>>).map((e) => ({
              old: String(e?.old ?? ""), new: String(e?.new ?? ""),
              replace_all: e?.replace_all === true || undefined,
            })) : [])
          : undefined;
        if (mode === "edit" && (!edits || edits.length === 0)) {
          throw new HttpError(400, "mode='edit' 에는 edits 가 필요합니다 — [{old, new}] 형태로 바꿀 조각을 지정하세요.");
        }
        // #592: 폴더(is_folder=true)만 빈 본문 허용 — min 1 검증은 is_folder 일 때만 우회(기존 문서 계약 불변).
        //  edit 는 본문을 서버가 만들므로 body_md 를 받지 않는다(있어도 무시 — 아래 어댑터가 덮는다).
        if (mode !== "edit" && !body_md.trim() && is_folder !== true) throw new HttpError(400, "body_md(또는 note)가 필요합니다");
        // (#335) injection 사용자 입력 폐기 — 지식은 recalled 고정. 항상-주입은 섹션 문서(org_update_section) 경로로만.
        const provenance = b.provenance ? String(b.provenance) : undefined;
        if (provenance && !["authored", "observed"].includes(provenance)) throw new HttpError(400, "provenance 는 authored|observed");
        const lifecycle = b.lifecycle ? String(b.lifecycle) : undefined;   // #638 자동 인입 pending 저장(사람 web 저작은 미전송=active)
        if (lifecycle && !["active", "pending"].includes(lifecycle)) throw new HttpError(400, "lifecycle 은 active|pending (신규 저장)");
        const category = b.category != null
          ? String(Array.isArray(b.category) ? (b.category[0] ?? "") : b.category) : undefined;  // 단일(#290), 배열 오면 첫 1개
        return {
          name: b.name ? String(b.name) : undefined,
          title: b.title ? String(b.title) : undefined,
          body_md, provenance, lifecycle,
          supersedes: b.supersedes ? String(b.supersedes) : undefined,
          type: b.type ? String(b.type) : undefined,
          category,
          is_folder,
          parent_name: b.parent_name ? String(b.parent_name) : undefined,   // #592 생성 시 트리 배치(이동은 /move)
          mode,                                                             // #921/#1531 replace(기본)|append|edit
          edits,                                                            // #1531 edit 전용(그 외 undefined)
          // #968 변경 요약(검토 카드·기록). 길이 조정은 여기서 하지 않는다 — 핸들러 소프트캡(#1442)이 유일한
          //  상한 지점이라야 REST 호출자도 '잘렸다'는 사실을 응답 capped 로 받는다(여기서 자르면 조용히 사라진다).
          change_note: b.change_note ? String(b.change_note) : undefined,
          // #1600 한 줄 요지. ⚠ 여기 빠뜨리면 zod 스키마에 있어도 REST 로는 **조용히 유실**된다
          //  (MCP 는 스키마를 그대로 쓰지만 REST 는 이 parse 가 유일한 입구다 — 실측으로 잡힌 누락).
          summary: b.summary != null ? String(b.summary) : undefined,
        };
      } }],
  },
  handler: async (input: KnowledgeSaveInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    // #1442 짧은 메타 필드 조정 — **맨 앞에서 한 번**. 아래 경로 전체(인입 게이트·리비전 제안·store)가
    //  조정된 값을 보게 하려면 여기여야 한다. capped(조정 보고)는 성공 return 마다 실어 호출자가 반드시 본다.
    //  MCP·REST 어느 경로로 와도 같은 판정을 받는다(REST 는 zod 를 안 타므로 이 자리가 유일한 상한 지점).
    const capped = applySoftCaps("knowledge_save", input, CAPS);
    // #1442 name 정규화 — 소프트캡 **다음에**(위에서 보낸 길이를 먼저 보고해야 하므로). store 가 upsert 직전
    //  slugify 로 정규화·절단하므로, 정규화를 store 에만 맡기면 아래 인입 게이트·공개범위 검사는 **원본 이름**을
    //  보고 store 는 **잘린 이름**을 쓰는 불일치가 생긴다: 65자 이름이면 게이트는 그 이름의 문서가 없으니 '신규'로
    //  판정하는데 store 는 잘린 이름의 기존 문서를 덮어쓴다(= create 정책으로 update 를 통과시키는 우회).
    //  zod .max(64) 가 그 입력을 튕겨 왔기에 지금까지 닿지 않던 경로다 — 상한을 소프트캡으로 바꾼 이 커밋이
    //  경로를 열므로 같은 커밋에서 닫는다. slugify 는 멱등이라 store 가 한 번 더 불러도 결과가 같다.
    if (input.name) input.name = slugify(input.name);
    // #592: MCP 경로의 빈 본문 방어 — zod min(1) 완화 대신 여기서(폴더만 예외). REST 는 parse 가 이미 걸렀다.
    //  #1531 edit 는 예외 — 본문을 서버가 edits 로 만들므로 호출자는 body_md 를 보내지 않는다(보낼 수 있다면
    //  전문을 아는 것이고, 그럼 이 모드를 쓸 이유가 없다).
    if (input.mode !== "edit" && !String(input.body_md ?? "").trim() && input.is_folder !== true) {
      throw new HttpError(400, "body_md 가 필요합니다(폴더 is_folder=true 만 빈 본문 허용)");
    }
    //  note/session(#1600) — 변경 이력이 '왜 고쳤나'·'어디서 고쳤나'를 답할 수 있게 감사에 함께 싣는다.
    //   change_note 는 종전엔 검토 큐(revision)로만 갔다 → 게이트가 꺼진 조직에선 이유가 아무 데도 안 남았다.
    const writeCtx = {
      actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web",
      note: input.change_note ?? null, session: ctx?.session ?? null,
    };
    // 공개범위(#1291) — 이름을 명시해 **기존 문서를 고치는** 경우만 막는다(신규 생성은 그대로).
    //  안 그러면 이름만 알면 안 보이는 문서를 upsert 로 통째로 덮어쓸 수 있다.
    if (input.name) await assertKnowledgeWritable(input.name, ctx?.viewer ?? null);

    // ── #783 인입 허용선 게이트 — 정책 규칙 0개면 create=auto·update=auto(현행과 100% 동일). ──
    const gate = await resolveKnowledgeGate(input, ctx);

    // ── #921 append — body_md('조각')를 기존 본문 끝에 붙인 **전문**으로 바꿔 아래 경로 전체가 종전처럼 전문만 다루게 한다. ──
    //  이 자리에서 한 번만 병합하는 게 핵심이다: 리비전 제안(next.body_md)에 조각이 들어가면 승인 시
    //  applyRevisionBody 가 전문 교체(knowledge-revision-store.ts)라 문서가 그 조각으로 날아간다.
    //  append 는 이 어댑터의 계약이라 병합·가드를 전부 여기 둔다 — 데이터 층(upsertKnowledge)은 시드/마이그/리비전
    //  적용/undo 도 함께 쓰는 공용 경로라 append 계약을 물려받으면 안 된다(어댑터 층 가드: runbooks/secrets.md 선례).
    const isAppend = input.mode === "append";
    const isEdit = input.mode === "edit";
    let appendBase: string | null = null;
    // body_md 는 스키마상 optional(edit 가 안 보내므로)이라 하류(전문 string 필수)로 넘기기 전에 확정한다.
    //  edit/append 분기가 아래에서 각자 계산한 전문으로 덮는다.
    let saveInput: KnowledgeSaveInput & { body_md: string } = { ...input, body_md: String(input.body_md ?? "") };
    // ── #1531 edit — 본문 일부만 정확일치로 치환. append 와 같은 자리에서 '전문'으로 바꿔 아래 경로를 무변경으로 둔다. ──
    //  append 와 가드가 같은 이유: 둘 다 "호출자가 본문을 안 읽는다"는 전제 위에 서 있어, 그 전제가 깨지는
    //  상황(외부 미러 재싱크·검토 대기 제안)에서 똑같이 조용히 유실된다.
    if (isEdit) {
      if (!gate.name) throw new HttpError(400, "edit 에는 name 이 필수입니다 — 고칠 지식을 지정하세요.");
      if (!gate.before) throw new HttpError(404, `지식 '${gate.name}' 없음 — edit 는 기존 지식에만 됩니다.`);
      if (gate.before.provenance === "observed") {
        throw new HttpError(400, "외부 미러(observed) 지식엔 edit 가 허용되지 않습니다 — 다음 재싱크가 본문을 통째로 덮어 고친 내용이 사라집니다. 원본에서 고치거나 파생 인사이트는 별도 지식(authored)으로 쓰세요.");
      }
      const staged = await pendingStagedRevisionId(gate.before.name);
      if (staged) {
        throw new HttpError(409, `이 지식엔 검토 대기 중인 수정 제안(#${staged})이 있어 edit 가 허용되지 않습니다 — 사람이 승인/반려한 뒤 다시 시도하세요(지금 고치면 검토 결과에 덮여 사라집니다).`);
      }
      appendBase = gate.before.body_md ?? "";
      let edited: string;
      try {
        edited = applyKnowledgeEdits(appendBase, (input as { edits?: KnowledgeEdit[] }).edits ?? []);
      } catch (e) {
        // 앵커 불일치·모호는 **호출자 실수**다(400) — 조용히 넘기면 "저장은 됐는데 안 바뀐" 최악의 실패가 된다.
        throw new HttpError(400, (e as Error).message);
      }
      if (edited.length > BODY_MD_MAX) {
        throw new HttpError(400, `edit 결과가 본문 상한(${BODY_MD_MAX.toLocaleString()}자)을 넘습니다 — 문서를 나누세요.`);
      }
      saveInput = { ...input, body_md: edited };
    }
    if (isAppend) {
      // 신규 금지 — upsertKnowledge 의 category/type 필수(#290)가 실질적으로 막긴 하지만, 신규 분기는 dedup similar
      //  검색 + 전문 에코라 append 의 응답 규약과 아예 다른 모양이다. 여기서 막는 게 그걸 따로 설계하는 것보다 싸다.
      if (!gate.name) throw new HttpError(400, "append 에는 name 이 필수입니다 — 덧붙일 지식을 지정하세요.");
      if (!gate.before) throw new HttpError(404, `지식 '${gate.name}' 없음 — append 는 기존 지식에만 됩니다(신규는 mode 없이 category·type 과 함께 만드세요).`);
      // 외부 미러 — 다음 재싱크가 body_md 를 통째로 덮으므로(connector-mirror) 덧붙인 조각은 반드시 사라진다.
      //  replace 는 안 막지만 그건 '전문을 되보내는 비용'이 사실상 억제해 왔다 — append 는 그 비용을 없애니 여기서 막는다.
      //  (upsertKnowledge 도 observed 의 이동·폴더전환을 같은 이유로 거부한다 — 원본이 진실.)
      if (gate.before.provenance === "observed") {
        throw new HttpError(400, "외부 미러(observed) 지식엔 append 가 허용되지 않습니다 — 다음 재싱크가 본문을 통째로 덮어 덧붙인 내용이 사라집니다. 원본(노션 등)에서 고치거나, 파생 인사이트는 별도 지식(authored)으로 쓰세요.");
      }
      // 검토 대기(staged) 제안이 있으면 거부 — 라이브 위에 붙이면 그 제안이 승인되는 순간 이 append 가 통째로 덮이고,
      //  반대로 제안 위에 쌓으면 라이브와 갈라져(그 사이 사람이 고쳤다면) 승인이 사람 개정을 지운다. 둘 다 조용한 유실이라
      //  '어느 쪽에 붙일지'를 서버가 정하지 않고 사람이 큐를 처리한 뒤로 미룬다. (fail-closed 조회 — 삼키면 유실이 된다.)
      const staged = await pendingStagedRevisionId(gate.before.name);
      if (staged) {
        throw new HttpError(409, `이 지식엔 검토 대기 중인 수정 제안(#${staged})이 있어 append 가 허용되지 않습니다 — 사람이 승인/반려한 뒤 다시 시도하세요(지금 붙이면 검토 결과에 덮여 사라집니다).`);
      }
      appendBase = gate.before.body_md ?? "";
      // 중복 append(재시도) — replace 와 달리 append 는 멱등이 아니다. 응답을 잃은 호출자가 재시도하면 같은 단락이
      //  두 번 붙는데, 본문을 읽지 않는 호출자는 그걸 알 수 없다 → 이미 끝에 그대로 있으면 붙이지 않고 사실을 알린다.
      if (isDuplicateAppend(appendBase, String(input.body_md ?? ""))) {
        throw new HttpError(409, "이 조각은 이미 본문 끝에 그대로 있습니다 — 앞선 append 가 이미 반영된 것으로 보입니다(응답을 못 받아 재시도한 경우라면 그 저장은 성공한 것입니다). 같은 내용을 한 번 더 붙이려는 게 정말 맞다면 mode 없이(replace) 전문으로 저장하세요.");
      }
      const merged = appendBody(appendBase, String(input.body_md ?? ""));
      if (merged.length > BODY_MD_MAX) {
        throw new HttpError(400, `append 결과가 본문 상한(${BODY_MD_MAX.toLocaleString()}자)을 넘습니다(현재 ${appendBase.length.toLocaleString()}자 + 조각 ${String(input.body_md ?? "").length.toLocaleString()}자) — 넘기면 그 문서는 전문 저장(replace·웹 편집기)이 영영 불가해집니다. 문서를 나누세요.`);
      }
      saveInput = { ...input, body_md: merged };
    }

    // #921 append 응답 — 본문 전문은 빼고 증분 요약만. json()(capabilities/index.ts)이 handler 결과를 통째로
    //  stringify 해 에이전트에 돌려주므로, 전문을 에코하면 '전문을 컨텍스트에 안 싣는다'는 이 모드의 목적이 무효가 된다.
    //  (replace 는 종전대로 전문 포함 — 기존 응답 계약 불변.)
    const lineCount = (s: string): number => (s ? s.split("\n").length : 0);
    const withBody = (k: any): Record<string, unknown> => {
      if (appendBase == null) return { knowledge: k };
      const { body_md, ...rest } = k ?? {};
      const body = String(body_md ?? "");
      return {
        knowledge: rest,
        appended: {
          added_chars: body.length - appendBase.length, added_lines: lineCount(body) - lineCount(appendBase),
          total_chars: body.length, total_lines: lineCount(body), version: rest?.version,
          note: "본문 끝에 덧붙였습니다(기존 원문 그대로 보존). 응답에 전문은 넣지 않습니다 — 확인이 필요하면 knowledge_get 부분읽기(offset/limit)로 보세요.",
        },
      };
    };

    // ① 신규 저장.
    if (gate.isCreate) {
      if (gate.create === "drop") {
        throw new HttpError(403, "인입 허용선 정책상 이 지식은 저장할 수 없습니다(drop) — 관리탭 '인입 허용선'에서 규칙을 확인하세요.");
      }
      // 서버 클램프: 에이전트가 lifecycle='active' 로 우회할 수 없다. 반대로 에이전트가 자진 pending 하면 존중(안전 방향).
      const lifecycle = (gate.create === "confirm" || input.lifecycle === "pending") ? "pending" : (input.lifecycle ?? "active");
      const { wikilinks, ...knowledge } = await upsertKnowledge({ ...saveInput, lifecycle }, writeCtx);
      // ── 세션 산출물 스탬핑(#1291 v2) — **신규 생성에만** 건다. ──
      //  기존 문서 수정에 걸면 남의 공개 문서를 잠긴 프로젝트 세션에서 한 글자 고치는 것만으로 조직에서 사라지게 만든다
      //  (가시성 축소가 편집의 부수효과가 되면 안 된다 — 축소는 언제나 명시적 행위여야 한다).
      //  잠긴 리스트의 프로젝트 세션이 아니면 no-op → 종전대로 open.
      const stampedList = await stampSessionVisibility(knowledge.name, ctx?.session, writeCtx);
      const visInfo = stampedList
        ? { visibility: { level: "members", via_project_list: stampedList,
            note: "이 지식은 지금 세션이 속한 프로젝트가 비공개라, 그 프로젝트를 볼 수 있는 사람에게만 보이도록 저장됐습니다(공개 위키에는 안 뜹니다). 전 조직에 공유할 내용이라면 프로젝트 밖 세션에서 다시 쓰거나 사람에게 공개범위 변경을 요청하세요." } }
        : {};
      const wl = wikiLinkInfo(wikilinks);   // #907 자동 엣지 결과 — 응답 최상위로(knowledge 행에 섞지 않는다)
      const gateInfo = lifecycle === "pending"
        ? { action: "confirm", state: "pending", rule_id: gate.rule_id,
            note: "검토 대기(pending)로 저장됐습니다 — 사람이 승인하기 전까지 검색·세션주입·목록에 노출되지 않습니다(knowledge_get·knowledge_list(lifecycle='pending')로는 조회 가능). 같은 name 으로 다시 저장하면 이 초안이 갱신됩니다." }
        : null;
      // 저장-시 중복감지(#172) — 신규(version=1)일 때만, 방금 저장된 임베딩으로 최근접 검색(재임베딩 X).
      //  임베딩 off / 유사 없음이면 그냥 { knowledge }. 비차단 경고 — 중복이면 supersedes/병합을 사람·에이전트가 판단.
      if ((knowledge as any)?.version === 1) {
        // 중복경고도 뷰어 기준 — 안 보이는 문서를 "비슷한 게 있다"고 알려주면 그 제목·발췌가 그대로 나간다.
        const similar = await findSimilarKnowledge({ name: knowledge.name, limit: 3, minScore: DEDUP_WARN_SIMILARITY }, ctx?.viewer ?? null);
        if (similar.length) {
          return { knowledge, ...visInfo, ...seedSyncWarning(knowledge.name), ...capped, ...(gateInfo ? { gate: gateInfo } : {}), ...wl, ...(await classificationInfo(knowledge.name)), similar, similar_note: "⚠ 비슷한 기존 지식이 있습니다(유사도순). 별개 주제가 아니라면 새로 만들지 말고 기존을 갱신하거나 supersedes 로 대체하세요 — 다음부터는 저장 전 knowledge_similar 로 먼저 확인하세요." };
        }
      }
      return { knowledge, ...visInfo, ...seedSyncWarning(knowledge.name), ...capped, ...(gateInfo ? { gate: gateInfo } : {}), ...wl, ...(await classificationInfo(knowledge.name)) };
    }

    // ② 기존 지식 수정 — 라이브(active) 대상일 때만 게이트(pending 초안 다듬기는 그대로 통과).
    if (gate.update === "drop") {
      throw new HttpError(403, "인입 허용선 정책상 이 지식은 수정할 수 없습니다(drop) — 관리탭 '인입 허용선'에서 규칙을 확인하세요.");
    }
    const before = gate.before!;
    if (gate.update === "stage") {
      // 본문 미반영 — 라이브는 옛 승인본 유지, 제안만 큐로. (같은 지식의 pending 제안은 1건으로 coalesce.)
      const revision = await proposeRevision({
        name: before.name, mode: "staged",
        base: { version: before.version, title: before.title, body_md: before.body_md, confidence: before.confidence },
        // #921 append 면 saveInput.body_md 는 '조각'이 아니라 base+조각 전문 — 승인(applyRevisionBody)이 전문 교체라 조각을 넣으면 문서가 날아간다.
        next: { title: input.title ?? null, body_md: String(saveInput.body_md ?? ""), summary: null, type: input.type ?? null },
        proposed_by: writeCtx.actor, actor_kind: gate.actor_kind, agent: gate.agent, rule_id: gate.rule_id,
        note: input.change_note ?? null,   // #968 변경 요약 — 검토 카드·변화 기록에 그대로 표시
      });
      return {
        knowledge: null,
        ...seedSyncWarning(before.name),
        ...capped,
        gate: {
          action: "stage", state: "proposed", revision_id: revision.id, rule_id: gate.rule_id,
          note: "수정 제안으로 접수됐습니다 — 라이브 본문은 아직 바뀌지 않았습니다(사람이 승인해야 반영). 같은 지식을 다시 저장하면 이 제안이 갱신됩니다.",
        },
      };
    }
    // #921 saveInput — append 면 body_md 가 조각이 아니라 base+조각 전문(위 append 분기에서 병합).
    const { wikilinks, ...knowledge } = await upsertKnowledge(saveInput, writeCtx);
    const wl = wikiLinkInfo(wikilinks);
    if (gate.update === "review") {
      // 본문은 즉시 반영(라이브 유지) — 사람은 사후에 diff 를 보고 확인 또는 되돌리기.
      const revision = await proposeRevision({
        name: before.name, mode: "applied",
        base: { version: before.version, title: before.title, body_md: before.body_md, confidence: before.confidence },
        next: { title: input.title ?? null, body_md: String(saveInput.body_md ?? ""), summary: null, type: input.type ?? null },
        proposed_by: writeCtx.actor, actor_kind: gate.actor_kind, agent: gate.agent, rule_id: gate.rule_id,
        note: input.change_note ?? null,   // #968 변경 요약
      });
      return {
        ...withBody(knowledge),
        ...seedSyncWarning(knowledge.name),
        ...capped,
        ...wl,
        gate: {
          action: "review", state: "applied_pending_review", revision_id: revision.id, rule_id: gate.rule_id,
          note: "수정이 반영됐고(라이브), 사람 검토 큐에 diff 가 적재됐습니다 — 검토에서 되돌려질 수 있습니다.",
        },
      };
    }
    return { ...withBody(knowledge), ...seedSyncWarning(knowledge.name), ...capped, ...wl, ...(await classificationInfo(knowledge.name)) };
  },
};

const knowledgeSetLifecycleInput = {
  name: z.string().min(1).max(64),
  lifecycle: z.enum(["active", "pending", "superseded", "archived"]),
};
type KnowledgeSetLifecycleInput = z.infer<z.ZodObject<typeof knowledgeSetLifecycleInput>>;
export const knowledgeSetLifecycle: Capability = {
  name: "knowledge_set_lifecycle",
  title: "지식 lifecycle",
  description: "active/pending/superseded/archived 전환. pending→active = 검토 승인(#638/#783 게이트). active→pending = 검토대기로 되돌림. 제거(반려)는 폐기 — 대신 knowledge_delete(휴지통, 복원가능). archived 는 외부 미러 원본 아카이브 전파에도 쓰인다(#551). " +
    "⚠ 승인(→active)과 '검토 대기 중 지식의 상태 변경'은 **사람 전용**(웹) — 에이전트(MCP)는 403. 자기가 쓴 지식을 스스로 승인할 수 없다.",
  scope: "memory",
  input: knowledgeSetLifecycleInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge/:name/lifecycle"],
      parse: (req) => {
        const lifecycle = String(((req.body ?? {}) as Record<string, unknown>).lifecycle ?? "");
        if (!["active", "pending", "superseded", "archived"].includes(lifecycle)) throw new HttpError(400, "lifecycle 은 active|pending|superseded|archived");
        return { name: String(req.params?.name ?? ""), lifecycle };
      } }],
  },
  handler: async (input: KnowledgeSetLifecycleInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertKnowledgeWritable(input.name, ctx?.viewer ?? null);
    // 🔒 #783 자가승인 차단 — 이게 없으면 게이트가 통째로 무력화된다:
    //  에이전트가 knowledge_save 로 pending 저장 → 곧바로 set_lifecycle(active) 로 스스로 승인 → 무검증 지식이 라이브.
    //  검토는 사람의 행위다. knowledge_delete 가 같은 이유로 mcp 를 403 하는 것(자기 글 삭제 금지)과 동형 가드.
    //  · →active(승인)는 MCP 금지. · 검토 대기(pending) 중인 지식의 상태 변경도 MCP 금지(큐에서 몰래 치우는 것 방지).
    //  사람 경로(웹 REST, source='web')는 무영향 — 검토 큐·문서 배너의 승인 버튼이 그대로 동작한다.
    if (ctx?.source === "mcp") {
      if (input.lifecycle === "active") {
        throw new HttpError(403, "승인(→active)은 사람이 웹 검토 큐에서 합니다 — 에이전트는 자기가 쓴 지식을 스스로 승인할 수 없습니다.");
      }
      const cur = await getKnowledgeLifecycle(input.name);
      if (cur === "pending") {
        throw new HttpError(403, "검토 대기 중인 지식의 상태 변경은 사람만 할 수 있습니다(검토 큐).");
      }
    }
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { knowledge: await setKnowledgeLifecycle(input.name, input.lifecycle, writeCtx) };
  },
};

// 제목만 갱신(#1442) — knowledge_save 는 body_md 가 필수라 제목 한 줄을 고치는 데도 전문을 되보내야 했다.
//  그건 소프트캡이 없애려던 바로 그 재전송이라(제목이 잘렸다고 알려주면서 고치는 길은 전문 재전송뿐인 모순)
//  set_lifecycle·set_wiki·move 와 같은 경량 메타 툴로 뒀다.
//  ⚠ 그 둘과 달리 **인입 허용선 게이트(#783)를 탄다.** title 은 사람이 읽고 검색·주입에 나가는 내용이라,
//   게이트를 안 태우면 "본문 수정은 검토 대기인데 제목은 자유롭게 바꿈"이라는 우회로가 생긴다.
//   stage 일 때 제안의 next.body_md 는 **서버가 DB 에서 읽어** 채운다 — 호출자가 전문을 실을 이유가 없다(이 툴의 존재 이유).
const KSET_CAPS = SOFT_CAPS.knowledge_set_title;
const knowledgeSetTitleInput = {
  name: z.string().min(1).max(64).describe("제목을 고칠 지식 이름"),
  title: z.string().min(1).describe(`새 제목 — 한 줄 라벨(문서의 논지·범위를 담되 문단이 아니다). ${softCapHint(KSET_CAPS.title)}`),
  change_note: z.string().optional()
    .describe(`#968 변경 요약 — 무엇을·왜 바꾸는지 1~2문장(검토 카드·변화 기록에 그대로 표시된다). ${softCapHint(KSET_CAPS.change_note)}`),
};
type KnowledgeSetTitleInput = z.infer<z.ZodObject<typeof knowledgeSetTitleInput>>;
export const knowledgeSetTitle: Capability = {
  name: "knowledge_set_title",
  title: "지식 제목 갱신",
  description:
    "기존 지식의 **제목만** 바꾼다(본문 불변). knowledge_save 는 body_md 가 필수라 제목 한 줄을 고치려면 전문을 되보내야 하는데, " +
    "이 툴은 name+title 만 받으므로 본문을 컨텍스트에 실을 필요가 없다 — **knowledge_save 응답에 capped(제목이 잘렸다)가 왔을 때 쓰라고 만든 경로다**(#1442). " +
    "제목은 검색·주입에 나가는 내용이라 version 이 올라가고 임베딩도 다시 계산된다(뷰 설정 토글과 다른 클래스). " +
    "조직이 '에이전트 지식 검토'를 켜 두면 이 변경도 게이트를 탄다 — 응답 gate 가 결과를 알려준다(pending 제안 접수 / 반영 후 사후검토). " +
    "제목을 아예 비우거나 본문·분류를 함께 고치려면 knowledge_save 를 쓰라.",
  scope: "memory",
  input: knowledgeSetTitleInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge/:name/title"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const title = String(b.title ?? "").trim();
        if (!title) throw new HttpError(400, "title 이(가) 필요합니다");
        return {
          name: String(req.params?.name ?? ""), title,
          change_note: b.change_note ? String(b.change_note) : undefined,
        };
      } }],
  },
  handler: async (input: KnowledgeSetTitleInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    const capped = applySoftCaps("knowledge_set_title", input, KSET_CAPS);
    await assertKnowledgeWritable(input.name, ctx?.viewer ?? null);
    // 게이트는 knowledge_save 와 같은 함수로 판정한다(같은 '기존 지식 수정'이므로 같은 규칙을 받아야 한다).
    const gate = await resolveKnowledgeGate({ name: input.name }, ctx);
    if (gate.isCreate || !gate.before) {
      throw new HttpError(404, `지식 '${input.name}' 없음 — 제목 갱신은 기존 지식에만 됩니다(신규는 knowledge_save).`);
    }
    if (gate.update === "drop") {
      throw new HttpError(403, "인입 허용선 정책상 이 지식은 수정할 수 없습니다(drop) — 관리탭 '인입 허용선'에서 규칙을 확인하세요.");
    }
    // 검토 대기(staged) 제안이 있으면 거부 — 라이브 제목을 지금 바꿔도 그 제안이 승인되는 순간 제안의 제목으로
    //  덮여 사라진다(조용한 유실). append 가 같은 이유로 409 하는 것과 동형 가드.
    const staged = await pendingStagedRevisionId(gate.before.name);
    if (staged) {
      throw new HttpError(409, `이 지식엔 검토 대기 중인 수정 제안(#${staged})이 있어 제목 갱신이 허용되지 않습니다 — 사람이 승인/반려한 뒤 다시 시도하세요(지금 바꾸면 검토 결과에 덮여 사라집니다).`);
    }
    const before = gate.before;
    const revisionInput = {
      name: before.name,
      base: { version: before.version, title: before.title, body_md: before.body_md, confidence: before.confidence },
      // 본문은 그대로 유지된다 — before.body_md(서버가 DB 에서 읽은 값)를 그대로 next 로 넘긴다.
      //  승인 시 applyRevisionBody 가 전문 교체라, 여기에 빈 값이나 조각을 넣으면 문서가 날아간다.
      next: { title: input.title, body_md: before.body_md ?? "", summary: null, type: before.type ?? null },
      proposed_by: ctx?.actor ?? user?.userId ?? null, actor_kind: gate.actor_kind, agent: gate.agent, rule_id: gate.rule_id,
      note: input.change_note ?? null,
    };
    if (gate.update === "stage") {
      const revision = await proposeRevision({ ...revisionInput, mode: "staged" });
      return {
        knowledge: null, ...capped,
        gate: { action: "stage", state: "proposed", revision_id: revision.id, rule_id: gate.rule_id,
          note: "제목 변경이 수정 제안으로 접수됐습니다 — 라이브 제목은 아직 그대로입니다(사람이 승인해야 반영)." },
      };
    }
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    const knowledge = await setKnowledgeTitle(before.name, input.title, writeCtx);
    if (gate.update === "review") {
      const revision = await proposeRevision({ ...revisionInput, mode: "applied" });
      return {
        knowledge, ...capped,
        gate: { action: "review", state: "applied_pending_review", revision_id: revision.id, rule_id: gate.rule_id,
          note: "제목이 반영됐고(라이브), 사람 검토 큐에 diff 가 적재됐습니다 — 검토에서 되돌려질 수 있습니다." },
      };
    }
    return { knowledge, ...capped };
  },
};

// WIKI 핀 토글 — is_wiki 만 갱신. 핀된 지식의 제목+메타가 가이드 ${wiki} 로 매 세션 항상-주입(본문 제외).
const knowledgeSetWikiInput = {
  name: z.string().min(1).max(64),
  is_wiki: z.boolean(),
};
type KnowledgeSetWikiInput = z.infer<z.ZodObject<typeof knowledgeSetWikiInput>>;
export const knowledgeSetWiki: Capability = {
  name: "knowledge_set_wiki",
  title: "WIKI 핀 토글",
  description: "지식을 WIKI 인덱스에 핀(고정)하거나 해제한다. 핀된 지식의 제목+메타가 컨텍스트 온톨로지 가이드의 ${wiki} 위치에 매 세션 항상-주입된다(본문 제외 — 인덱스).",
  scope: "memory",
  input: knowledgeSetWikiInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge/:name/wiki"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return { name: String(req.params?.name ?? ""), is_wiki: b.is_wiki === true };
      } }],
  },
  handler: async (input: KnowledgeSetWikiInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertKnowledgeWritable(input.name, ctx?.viewer ?? null);
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { knowledge: await setKnowledgeWiki(input.name, input.is_wiki, writeCtx) };
  },
};

// 삭제(휴지통) — 활성 목록에서 제거하되 감사 스냅샷으로 보존(content_restore 로 복원). 제거의 유일 경로
//  (가역 숨김 '반려' 는 폐기 — 삭제가 복원가능이라 흡수). ⚠ 사람(웹)만 — 에이전트(MCP)는 403. deny pattern 은 domain_delete 동형.
const knowledgeDeleteInput = { name: z.string().min(1).max(64) };
type KnowledgeDeleteInput = z.infer<z.ZodObject<typeof knowledgeDeleteInput>>;
export const knowledgeDelete: Capability = {
  name: "knowledge_delete",
  title: "지식 삭제(휴지통)",
  description:
    "지식을 삭제한다 — 활성 목록·검색·주입에서 사라지되 감사 스냅샷(before)으로 보존되어 content_restore(휴지통)로 복원 가능. " +
    "연결(카테고리·프로젝트 필요/산출·활동)은 FK CASCADE 로 정리된다(복원 시 링크는 돌아오지 않음). " +
    "지식 제거의 유일 경로(가역 숨김 '반려' 는 폐기). ⚠ 사람(웹)만 — 에이전트(MCP)는 403(비가역).",
  scope: "memory",
  input: knowledgeDeleteInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge/:name/delete"],
      parse: (req) => ({ name: String(req.params?.name ?? "") }) }],
  },
  handler: async (input: KnowledgeDeleteInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertKnowledgeWritable(input.name, ctx?.viewer ?? null);
    if (ctx?.source === "mcp") {
      throw new HttpError(403, "지식 삭제는 사람(웹)만 가능합니다 — 에이전트는 거부됩니다(비가역). 정정은 같은 이름으로 덮어쓰기(저장)하세요");
    }
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    const before = await deleteKnowledge(input.name, writeCtx);
    return { deleted: true, name: input.name, title: (before as any)?.title ?? null };
  },
};

// 트리 이동 — parent_name(null=루트)·sort?. 가드(스토어): 대상 observed 400 / 부모 존재 404·observed 400·순환 400.
const knowledgeMoveInput = {
  name: z.string().min(1).max(64),
  parent_name: z.string().min(1).max(64).nullable().describe("부모 지식/폴더 name — null 이면 루트로"),
  sort: z.number().int().optional().describe("형제 간 순서(작을수록 앞). 생략 시 기존 유지"),
};
type KnowledgeMoveInput = z.infer<z.ZodObject<typeof knowledgeMoveInput>>;
export const knowledgeMove: Capability = {
  name: "knowledge_move",
  title: "지식 트리 이동",
  description:
    "지식(폴더 포함)을 저작 지식 트리에서 이동한다 — parent_name(부모 지식/폴더 name, null=루트)과 sort(형제 순서, 선택). " +
    "외부 미러(observed) 지식은 이동 불가(원본에서 옮겨야 함), observed 아래로의 배치·순환도 거부된다.",
  scope: "memory",
  input: knowledgeMoveInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge/:name/move"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        if (!("parent_name" in b)) throw new HttpError(400, "parent_name(지식 이름 또는 null=루트)이 필요합니다");
        const parent_name = b.parent_name == null ? null : String(b.parent_name).trim();
        if (parent_name === "") throw new HttpError(400, "parent_name 은 지식 이름 또는 null 이어야 합니다");
        const out: Record<string, unknown> = { name: String(req.params?.name ?? ""), parent_name };
        if (b.sort != null) {
          const s = Number(b.sort);
          if (!Number.isInteger(s)) throw new HttpError(400, "sort 는 정수여야 합니다");
          out.sort = s;
        }
        return out;
      } }],
  },
  handler: async (input: KnowledgeMoveInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertKnowledgeWritable(input.name, ctx?.viewer ?? null);
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { knowledge: await moveKnowledge(input.name, input.parent_name ?? null, input.sort, writeCtx) };
  },
};

export const authoringCapabilities: Capability[] = [
  // #1442 knowledgeSetTitle 은 **맨 뒤**에 붙인다 — 앞에 끼우면 기존 op 들의 등록 순서(= tools/list 순 ·
  //  REST 마운트 순 · 표면 스냅샷)가 통째로 밀린다. 새 op 추가만이 표면 변화이도록 자리를 고른다.
  knowledgeSave, knowledgeSetLifecycle, knowledgeSetWiki, knowledgeDelete, knowledgeSetTitle,
];
// #592 트리 이동 — 원본 등록 배열에서 **맨 뒤**(다른 :name 하위 경로들 뒤)였다. 도메인은 저작이지만
//  등록 순서(= tools/list 순 · REST 마운트 순 · 표면 스냅샷)를 바꾸지 않으려 자리를 지켜 따로 내보낸다.
export const authoringMoveCapabilities: Capability[] = [knowledgeMove];
