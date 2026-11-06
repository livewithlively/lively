// 지식 저작 표면(#1313 R57) — 저장(replace/append)·lifecycle·WIKI 핀·삭제(휴지통)·트리 이동.
//  본문을 바꾸는 경로가 여기 모여 있다: 인입 허용선 게이트(#783)·append 병합(#921)·중복감지(#172)·
//  시딩 지식 경고(#846)·위키링크 엣지(#907)가 전부 이 파일의 저장 경로를 지난다.
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import type { Capability, CapabilityCtx } from "../types.js";
import type { LivelyUser } from "../../context.js";
import {
  upsertKnowledge, setKnowledgeLifecycle, getKnowledgeGateFields, setKnowledgeWiki, deleteKnowledge,
  findSimilarKnowledge, moveKnowledge, appendBody, isDuplicateAppend, stampSessionVisibility, slugify,
  applyKnowledgeEdits, type KnowledgeEdit,
  setKnowledgeTitle, sessionStampListId, KnowledgeExistsError, patchKnowledgeFields, setKnowledgeSearchable,
} from "../../v6/knowledge-store.js";
import { isJsonObject } from "../../v6/knowledge-fields.js";
// #4824 증류 저장 — 저장 · 원본 연결 · 공개범위를 한 트랜잭션에서(사양 R6) · 증류 배치는 원본 없이 못 쓴다(R7).
import {
  derivedEnforced, linkDerivedSources, planNewDerivedKnowledge, withDerivedTx, writeNewDerivedKnowledge,
  type LinkDerivedResult,
} from "../../v6/derived-visibility.js";
import { derivedDupNote } from "../../v6/knowledge-links.js";
import { distillBatchOf } from "../../org/distill/distill-batch.js";
import { canSeeSource } from "../../v6/source-store.js";
// #783 인입 허용선 게이트 — 에이전트(MCP) 저작 지식의 자동 검토대기 + 기존 지식 수정 검토 큐.
import { resolveKnowledgeGate } from "../../v6/knowledge-gate.js";
import { denyLifecycleChange } from "./lifecycle-guard.js";
import { proposeRevision, pendingStagedRevisionId } from "../../v6/knowledge-revision-store.js";
import {
  assertKnowledgeWritable, BODY_MD_MAX, DEDUP_WARN_SIMILARITY, classificationInfo, seedSyncWarning, wikiLinkInfo,
} from "./shared.js";
// #1442 소프트캡 — 짧은 메타 필드의 길이 초과가 body_md 전체를 튕기지 않게 한다(서버 조정 + 응답 capped).
import { SOFT_CAPS, applySoftCaps, softCapHint } from "../soft-cap.js";
import { assertNoContentSecrets, assertNoSecretKeys } from "../content-secrets.js";

// #1442 소프트캡 — 아래 다섯 짧은 필드(name·title·supersedes·parent_name·change_note)엔 zod .max() 를 두지
//  않는다. SDK 는 검증을 핸들러 앞에서 하므로 그 max 가 body_md(최대 200,000자)까지 통째로 튕겨 재전송을
//  부르고, 그 실패는 mcp_call_log 에도 안 남았다. 상한은 describe(softCapHint)로 광고하고 조정은
//  핸들러(applySoftCaps)가 한다 — 표는 soft-cap.ts SOFT_CAPS.knowledge_save 하나뿐이다.
const CAPS = SOFT_CAPS.knowledge_save;
/** derived_from 한 번에 실을 수 있는 자료 수 — 스레드 하나(대개 수십 건)를 넉넉히 덮는다. */
const DERIVED_FROM_MAX = 500;

/** REST 의 derived_from — zod 를 안 타므로 여기서 모양을 본다(양의 정수 배열 · 상한). 없으면 undefined.
 *  자료 id 하나(숫자·숫자 문자열)는 [id] 로 받는다 — 폼·쿼리에서 한 건만 보내는 호출을 굳이 튕기지 않는다(잘못된 값은 400). */
function parseDerivedFrom(raw: unknown): number[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const list = Array.isArray(raw) ? raw : [raw];
  const ids = list.map((x) => (typeof x === "number" || (typeof x === "string" && /^\d+$/.test(x.trim())) ? Number(x) : NaN));
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new HttpError(400, "derived_from 은 자료 id(양의 정수) 배열입니다");
  if (ids.length > DERIVED_FROM_MAX) throw new HttpError(400, `derived_from 은 한 번에 ${DERIVED_FROM_MAX}건까지입니다`);
  return ids;
}

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
  provenance: z.enum(["authored", "observed"]).optional(),
  // #335 지식의 injection 은 서버 고정값(recalled)이다 — 저작자가 못 정한다. 그런데 종전엔 **선언에도 없고
  //  parse 도 안 실어** 그 입력이 조용히 사라졌다: `injection:"always"` 를 보낸 저장이 200 으로 성공하고
  //  값만 없어진다(실측 2026-09-08). 500 보다 나쁘다 — 잘못된 입력이 성공으로 기록되고 호출자는 자기 지정이
  //  먹혔다고 믿는다. 그래서 '유일 허용값' enum 으로 선언에 남긴다: MCP 는 SDK 가, REST 는 enum 파리티
  //  가드가 같은 판정을 내리고(둘 다 400), 이유는 아래 안내문 하나에서 나온다.
  injection: z.enum(["recalled"]).optional()
    .describe("지식은 항상 recalled 고정이라 저작자가 지정할 수 없다(#335) — 보내지 않는 것이 정상이고, 보낸다면 recalled 만 허용된다. '세션마다 항상 주입'은 관리 ▸ 세션 주입 섹션 문서(org_update_section)로, WIKI 인덱스 핀은 knowledge_set_wiki 로 지정한다."),
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
  searchable: z.boolean().optional()
    .describe("#5169 검색 제외 — false 면 이 지식은 knowledge_get(이름)·knowledge_list(카테고리)·트리·링크로만 읽히고, 검색(knowledge_search·knowledge_grep·knowledge_similar·추천)·자동 소환·임베딩에서 빠진다. "
      + "같은 사실이 검색용 문서에 이미 있는 재집계 문서·색인처럼 «이름으로만 읽는» 문서를 만들 때 싣는다(만들 때부터 임베딩하지 않는다). 미전송 시 기존값 보존(신규 기본 true). 나중에 바꾸려면 knowledge_set_searchable."),
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
    .describe("#968 변경 요약 — **기존 지식을 고칠 땐 무엇을·왜 바꾸는지 1~2문장으로 함께 보내라**(예: \"재시작 완료 기준을 healthz 200 으로 명확화. 계기 — 7/15 장애 때 절차 부재\"). 검토 카드와 변화 기록에 이 문장이 그대로 표시된다 — 없으면 사람이 diff 만 보고 판단해야 한다. "
      + softCapHint(CAPS.change_note)),
  // #4824 — 증류(자료 → 지식)의 정식 길. 따로 source_link_knowledge 를 부르던 두 번 호출은 둘째를 빠뜨리면 잠긴 자료로 만든
  //  지식이 공개로 남았다. 여기 실으면 저장·연결·공개범위가 한 트랜잭션이다.
  //  ⚠ 배열 상한을 zod .max() 로 두지 않는다(#1442) — SDK 가 핸들러 앞에서 검증해 본문째 튕기고 기록도 안 남는다. 핸들러가 본다.
  derived_from: z.array(z.number().int().positive()).optional()
    .describe("이 지식이 나온 자료(source) id 목록 — **자료를 지식으로 증류할 땐 반드시 싣는다**. 저장과 원본 연결(derived_from)과 공개범위를 서버가 한 번에 한다(source_link_knowledge 를 따로 부를 필요 없다). "
      + "잠긴 자료(볼 수 있는 사람만)가 섞이면 이 지식도 그 사람들만 보게 된다. 그래서 **잠긴 자료를 이미 더 넓게 보이는 기존 지식에 합치는 저장은 거절된다(409)** — 그땐 새 이름으로 따로 저장하라. "
      + "볼 수 있는 사람이 서로 안 겹치는 잠긴 자료를 한 지식에 모으는 것도 거절된다(아무도 못 보게 되므로 — 자료별로 나눠라). 증류 배치 세션에서는 이 칸 없는 저장이 거절된다."),
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
    "**자료를 지식으로 증류할 땐 derived_from(자료 id 배열)을 실어라(#4824)** — 저장·원본 연결·공개범위가 한 번에 된다(source_link_knowledge 를 따로 부르지 않는다). 잠긴 자료(볼 수 있는 사람만)에서 나온 지식은 그 사람들만 보도록 저장되고, 잠긴 자료를 더 넓게 보이는 기존 지식에 합치는 저장은 409 로 거절된다(새 이름으로 따로 저장하라). 증류 배치에서는 derived_from 없는 저장이 거절된다. " +
    "**시딩 지식 경고(#846): 응답에 seed_warning 이 오면** 이 지식은 신규 고객 게이트웨이에 시딩되는 런북이라, 이 WIKI 편집은 고객이 받는 각색 스냅샷(src/org/delivery/seed-knowledge/…)에 자동 반영되지 않는다 — 안내대로 그 파일도 갱신하고, 그 사실을 사용자에게 알려라. " +
    "**append 모드(#921): 기존 문서에 내용을 보탤 땐 mode='append' 를 써라** — 이때 body_md 는 전문이 아니라 **덧붙일 조각**이고, 서버가 기존 본문 끝에 빈 줄로 잇는다. " +
    "전문을 읽어와(knowledge_get) 재조립해 통째로 되보내지 마라 — 원문이 그대로 보존되고(네가 재출력하며 생기는 요약·드리프트·누락이 없다) 전문이 컨텍스트를 오갈 일도 없다. " +
    "기존 지식 전용(name 필수 · 신규는 mode 없이 만들고 · 외부 미러(observed)엔 불가), 응답엔 본문 전문 대신 증분 요약(appended)만 온다. " +
    "**edit 모드(#1531): 문서 '중간'을 고칠 땐 mode='edit' + edits=[{old,new}] 를 써라** — append 는 끝에만 붙으므로 타임라인 중간 삽입·표의 수치 교체·낡은 항목 갱신엔 못 쓴다. " +
    "그때 replace 로 전문을 되보내면 네가 4만 자를 받아쓰게 되고, 그 전사 중에 **손대지 말아야 할 문장이 깨진다**(실측: 무관한 쉼표가 여는 괄호로 바뀌어 괄호가 닫히지 않았다). " +
    "edit 는 old 를 정확일치로 찾아 그 자리만 바꾸므로 나머지는 문자 단위로 보존된다. old 는 공백·줄바꿈까지 원문 그대로여야 하고, **못 찾거나 여러 곳에서 찾으면 저장이 실패한다**(조용히 넘어가지 않는다 — 여러 곳이면 앞뒤를 더 붙여 유일하게 만들거나 replace_all: true). " +
    "**변경 요약(#968): 기존 지식을 고칠 땐 change_note(무엇을·왜 — 1~2문장)를 함께 보내라** — 검토 카드와 변화 기록에 그 문장이 그대로 표시된다. " +
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
        // #5169 검색 제외 — 불리언만 받는다. 문자열 "false" 를 조용히 버리면 «검색에서 빼라» 를 실은 저장이 검색에 그대로 남는다.
        if (b.searchable != null && typeof b.searchable !== "boolean") throw new HttpError(400, "searchable 은 true|false");
        return {
          name: b.name ? String(b.name) : undefined,
          title: b.title ? String(b.title) : undefined,
          body_md, provenance, lifecycle,
          supersedes: b.supersedes ? String(b.supersedes) : undefined,
          type: b.type ? String(b.type) : undefined,
          category,
          is_folder,
          parent_name: b.parent_name ? String(b.parent_name) : undefined,   // #592 생성 시 트리 배치(이동은 /move)
          searchable: typeof b.searchable === "boolean" ? b.searchable : undefined,   // #5169 검색 제외(미전송 = 기존값 보존)
          mode,                                                             // #921/#1531 replace(기본)|append|edit
          edits,                                                            // #1531 edit 전용(그 외 undefined)
          // #968 변경 요약(검토 카드·기록). 길이 조정은 여기서 하지 않는다 — 핸들러 소프트캡(#1442)이 유일한
          //  상한 지점이라야 REST 호출자도 '잘렸다'는 사실을 응답 capped 로 받는다(여기서 자르면 조용히 사라진다).
          change_note: b.change_note ? String(b.change_note) : undefined,
          derived_from: parseDerivedFrom(b.derived_from),                  // #4824 저장 + 원본 연결 한 번에
        };
      } }],
  },
  handler: async (input: KnowledgeSaveInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    // #4501 평문 시크릿 차단 — 맨 앞(어떤 조회·게이트보다 먼저). edit 의 old 는 «지금 본문» 이라 건너뛴다(지우는 편집을 막지 않게).
    assertNoContentSecrets(input, new Set(["edits.*.old"]));
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
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    // 공개범위(#1291) — 이름을 명시해 **기존 문서를 고치는** 경우만 막는다(신규 생성은 그대로).
    //  안 그러면 이름만 알면 안 보이는 문서를 upsert 로 통째로 덮어쓸 수 있다.
    if (input.name) await assertKnowledgeWritable(input.name, ctx?.viewer ?? null);

    // ── #4824 증류 저장 — derived_from 정리 · 증류 배치 가드(사양 R7) · 볼 수 있는 자료인가. 전부 쓰기 **전에**. ──
    //  빈 배열은 «없음» 과 같다. 안 보이는 자료는 없는 자료와 같은 문구(존재 은닉 — source_link_knowledge 와 같은 규율).
    const derivedIds = [...new Set((input.derived_from ?? []).map(Number))];
    if (derivedIds.length > DERIVED_FROM_MAX) {
      throw new HttpError(400, `derived_from 은 한 번에 ${DERIVED_FROM_MAX}건까지입니다(${derivedIds.length}건) — 자료를 나눠 저장하세요. 아무것도 저장하지 않았습니다.`);
    }
    //  축 상태는 트랜잭션(잠금) **전에** 읽어 넘긴다 — 잠금을 쥔 채 풀을 기다리지 않게(derived-visibility.ts 머리말). 30초 캐시.
    //   폴더도 같은 값을 쓴다 — derived_from 을 실은 폴더가 잠긴 자료에서 나왔으면 그 대상으로 태어나야 한다(가드만 폴더를 뺀다).
    const enforced = await derivedEnforced();
    //  증류 배치 가드는 축이 켜져 있을 때만 — 꺼진 워크스페이스는 공개범위를 강제하지 않아 «연결 빠뜨림 = 공개로 남음» 이 아니고,
    //   종전 두 번 호출(저장 → source_link_knowledge)도 켤 때 reconcileAllDerived 가 연결을 따라 맞춘다(격리 리뷰 — 레인마다
    //   저장된 옛 기준 문구가 첫 저장마다 400 을 맞지 않게).
    if (!derivedIds.length && input.is_folder !== true && enforced && await distillBatchOf(ctx?.session)) {
      throw new HttpError(400,
        "증류 배치의 지식 저장에는 derived_from(이 지식이 나온 자료 id 목록)이 필수입니다 — knowledge_save(…, derived_from: [자료 id]) 로 "
        + "저장과 원본 연결을 한 번에 하세요(따로 source_link_knowledge 를 부르는 두 번 호출은 연결이 빠지면 잠긴 자료로 만든 지식이 공개로 남습니다). "
        + "아무것도 저장하지 않았습니다.");
    }
    for (const id of derivedIds) {
      if (!(await canSeeSource(id, ctx?.viewer ?? null))) throw new HttpError(404, `자료 #${id} 없음`);
    }
    //  #1631 중복 증류 알림 — 두 번 호출 시절 source_link_knowledge 에만 있던 것을 이 길에도 싣는다(커밋 뒤에 잰다).
    const dupWarning = async (name: string): Promise<Record<string, unknown>> => {
      const notes = new Set<string>();
      for (const id of derivedIds) { const n = await derivedDupNote(id, name, ctx?.viewer ?? null).catch(() => null); if (n) notes.add(n); }
      return notes.size ? { warning: [...notes].join(" ") } : {};
    };

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
      let knowledge: Record<string, unknown> & { name: string; version?: unknown };
      let wikilinks: Awaited<ReturnType<typeof upsertKnowledge>>["wikilinks"];
      let stampedList: number | null;
      let derivedInfo: Record<string, unknown> | null = null;
      if (derivedIds.length) {
        // #4824 — 저장 · 원본 연결 · 공개범위를 **한 트랜잭션**에서(사양 R6). 공개범위는 INSERT 전에 정해 그 값으로 태어난다 —
        //  잠긴 자료로 만든 지식이 한순간도 공개로 있지 않다. 하나라도 실패하면 행·연결·감사 전부 롤백된다.
        //  세션 스탬핑(비공개 프로젝트)도 같은 자리에서 정한다 — 잠긴 자료와 겹치면 거절(planNewDerivedKnowledge).
        //  ⚠ 스탬프 조회가 실패하면(null) 리스트 없이 만든다 — derived_from 이 없는 저장과 같은 종전 규칙이다(프로젝트 스탬핑은
        //   #1291 v2 의 best-effort). 잠긴 자료의 대상은 그대로 걸리므로 «잠긴 자료로 만든 지식이 공개» 는 생기지 않는다.
        const stampList = await sessionStampListId(ctx?.session).catch(() => null);
        let created;
        try {
          created = await withDerivedTx(async (client) => {
            const planned = await planNewDerivedKnowledge(client, derivedIds, stampList, enforced);
            const row = await upsertKnowledge({ ...saveInput, lifecycle }, writeCtx,
              { db: client, insertOnly: true, deferPost: true, visibility: planned.plan.next.open ? "open" : "members" });
            await writeNewDerivedKnowledge(client, row.name, planned, writeCtx);
            return { row, planned };
          });
        } catch (e) {
          if (e instanceof KnowledgeExistsError) {
            throw new HttpError(409, `지식 '${e.knowledgeName}' 이(가) 방금 다른 저장으로 생겼습니다 — 아무것도 저장하지 않았습니다. knowledge_get 으로 그 지식을 보고, 고칠 거면 같은 이름으로 다시 저장하세요.`);
          }
          throw e;
        }
        const { post, wikilinks: _unused, ...row } = created.row;
        knowledge = row as typeof knowledge;
        wikilinks = await post?.();   // 커밋 뒤 — 임베딩 표시·위키링크 엣지(best-effort)
        stampedList = created.planned.plan.next.lists[0] ?? null;
        const next = created.planned.plan.next;
        derivedInfo = {
          linked: created.planned.sourceIds.length, visibility: next.open ? "open" : "members", audience: next.subjects.length,
          ...(created.planned.lockedIds.length ? {
            locked_sources: created.planned.lockedIds,
            note: "잠긴 자료(볼 수 있는 사람만)에서 나온 지식이라, 그 자료를 볼 수 있는 사람만 보도록 저장했습니다. 이 지식에 잠기지 않은 다른 내용을 합치지 마세요.",
          } : {}),
        };
      } else {
        const r = await upsertKnowledge({ ...saveInput, lifecycle }, writeCtx);
        ({ wikilinks, ...knowledge } = r);
        // ── 세션 산출물 스탬핑(#1291 v2) — **신규 생성에만** 건다. ──
        //  기존 문서 수정에 걸면 남의 공개 문서를 잠긴 프로젝트 세션에서 한 글자 고치는 것만으로 조직에서 사라지게 만든다
        //  (가시성 축소가 편집의 부수효과가 되면 안 된다 — 축소는 언제나 명시적 행위여야 한다).
        //  잠긴 리스트의 프로젝트 세션이 아니면 no-op → 종전대로 open.
        stampedList = await stampSessionVisibility(knowledge.name, ctx?.session, writeCtx);
      }
      const visInfo = stampedList
        ? { visibility: { level: "members", via_project_list: stampedList,
            note: "이 지식은 지금 세션이 속한 프로젝트가 비공개라, 그 프로젝트를 볼 수 있는 사람에게만 보이도록 저장됐습니다(공개 위키에는 안 뜹니다). 전 조직에 공유할 내용이라면 프로젝트 밖 세션에서 다시 쓰거나 사람에게 공개범위 변경을 요청하세요." } }
        : {};
      const wl = wikiLinkInfo(wikilinks);   // #907 자동 엣지 결과 — 응답 최상위로(knowledge 행에 섞지 않는다)
      const derivedOut = derivedInfo ? { derived: derivedInfo, ...(await dupWarning(knowledge.name)) } : {};
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
          return { knowledge, ...visInfo, ...seedSyncWarning(knowledge.name), ...capped, ...(gateInfo ? { gate: gateInfo } : {}), ...wl, ...derivedOut, ...(await classificationInfo(knowledge.name)), similar, similar_note: "⚠ 비슷한 기존 지식이 있습니다(유사도순). 별개 주제가 아니라면 새로 만들지 말고 기존을 갱신하거나 supersedes 로 대체하세요 — 다음부터는 저장 전 knowledge_similar 로 먼저 확인하세요." };
        }
      }
      return { knowledge, ...visInfo, ...seedSyncWarning(knowledge.name), ...capped, ...(gateInfo ? { gate: gateInfo } : {}), ...wl, ...derivedOut, ...(await classificationInfo(knowledge.name)) };
    }

    // ② 기존 지식 수정 — 라이브(active) 대상일 때만 게이트(pending 초안 다듬기는 그대로 통과).
    if (gate.update === "drop") {
      throw new HttpError(403, "인입 허용선 정책상 이 지식은 수정할 수 없습니다(drop) — 관리탭 '인입 허용선'에서 규칙을 확인하세요.");
    }
    const before = gate.before!;
    // #4824 — 기존 지식 + derived_from: 판정 · 연결 · 내용을 **한 트랜잭션**에서(사양 R6). 자료를 잡고(FOR SHARE) 지식을 잡은 뒤
    //  «이 자료들을 이으면 지금 이 지식을 보는 사람이 줄어드나» 를 본다 — 줄면 409, 본문·연결·공개범위 아무것도 안 바뀐다
    //  (잠긴 자료를 공개 지식에 합치지 않는다 — 빈틈 ②). 줄지 않으면 연결과 내용이 함께 커밋된다(검증 실패면 함께 롤백 —
    //  «증류됨» 으로 빠졌는데 내용은 없는 자료가 생기지 않는다).
    //  그 사이 다른 저장이 끼었으면(판이 바뀜) 409 — append·edit 가 합친 본문의 바탕이 낡아 남의 저장을 덮지 않게.
    //  검토 게이트 stage 는 본문을 안 바꾸므로 연결만 하고 제안은 커밋 뒤에 낸다.
    let derivedLink: LinkDerivedResult | null = null;
    let written: Awaited<ReturnType<typeof upsertKnowledge>> | null = null;
    if (derivedIds.length) {
      const res = await withDerivedTx(async (c) => {
        const link = await linkDerivedSources(c, before.name, derivedIds, writeCtx, { mode: "save", enforced });
        const cur = await c.query(`SELECT version FROM knowledge WHERE name=$1`, [before.name]);
        if (Number(cur.rows[0]?.version) !== Number(before.version)) {
          throw new HttpError(409, `지식 '${before.name}' 이(가) 그 사이 다른 저장으로 바뀌었습니다(판 ${before.version} → ${cur.rows[0]?.version}) — 아무것도 저장하지 않았습니다. knowledge_get 으로 지금 본문을 보고 다시 저장하세요.`);
        }
        const row = gate.update === "stage" ? null : await upsertKnowledge(saveInput, writeCtx, { db: c, deferPost: true });
        return { link, row };
      });
      derivedLink = res.link;
      written = res.row;
    }
    const derivedOut = derivedLink
      ? {
          derived: { linked: derivedLink.inserted.length, visibility: derivedLink.visibility, audience: derivedLink.audience, ...(derivedLink.changed ? { changed: true } : {}) },
          ...(await dupWarning(before.name)),
        }
      : {};
    if (gate.update === "stage") {
      //  #5169 검색 제외는 내용이 아니라 소환 설정이다(knowledge_set_searchable 과 같은 급 — 인입 허용선을 타지 않는다). 리비전엔 실을
      //   자리도 없어(제목·본문만) 제안과 따로 바로 반영한다 — 안 하면 «검색에서 빼라» 를 실은 저장이 조용히 무시된다.
      const searchableOut = input.searchable === undefined ? {} : {
        searchable: {
          value: input.searchable, changed: (await setKnowledgeSearchable(before.name, input.searchable, writeCtx)).changed,
          note: "검색 제외 표시(searchable)는 본문 수정 제안과 따로 바로 반영했습니다 — 검토 대상이 아닙니다.",
        },
      };
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
        ...derivedOut,
        ...searchableOut,
        gate: {
          action: "stage", state: "proposed", revision_id: revision.id, rule_id: gate.rule_id,
          note: "수정 제안으로 접수됐습니다 — 라이브 본문은 아직 바뀌지 않았습니다(사람이 승인해야 반영). 같은 지식을 다시 저장하면 이 제안이 갱신됩니다.",
        },
      };
    }
    // #921 saveInput — append 면 body_md 가 조각이 아니라 base+조각 전문(위 append 분기에서 병합).
    //  #4824 derived_from 이면 위 트랜잭션이 이미 썼다 — 커밋 뒤 임베딩 표시·위키링크(post)만 남았다.
    let knowledge: Record<string, unknown> & { name: string };
    let wikilinks: Awaited<ReturnType<typeof upsertKnowledge>>["wikilinks"];
    if (written) {
      const { post, wikilinks: _unused, ...row } = written;
      knowledge = row as typeof knowledge;
      wikilinks = await post?.();
    } else {
      ({ wikilinks, ...knowledge } = await upsertKnowledge(saveInput, writeCtx));
    }
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
        ...derivedOut,
        gate: {
          action: "review", state: "applied_pending_review", revision_id: revision.id, rule_id: gate.rule_id,
          note: "수정이 반영됐고(라이브), 사람 검토 큐에 diff 가 적재됐습니다 — 검토에서 되돌려질 수 있습니다.",
        },
      };
    }
    return { ...withBody(knowledge), ...seedSyncWarning(knowledge.name), ...capped, ...wl, ...derivedOut, ...(await classificationInfo(knowledge.name)) };
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
    "⚠ 승인(→active)과 '검토 대기 중 지식의 상태 변경'은 **사람 전용**(웹) — 에이전트(MCP)는 403. 자기가 쓴 지식을 스스로 승인할 수 없다. " +
    "외부 미러의 archived→active «복원» 은 사람도 403 — 원본에서 복원하면 싱크가 따라온다(#638). 미러의 pending→active 검토 승인은 정상 경로다.",
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
    // 🔒 전환 가드(#783 자가승인 차단 · #638 미러 복원 금지) — 판정은 denyLifecycleChange 한 곳에.
    //  여기서 막아야 MCP·웹 REST·다른 클라이언트가 같은 규칙을 쓴다. UI 버튼 숨김은 안내일 뿐 규칙이 아니다.
    const gate = await getKnowledgeGateFields(input.name);
    const denied = denyLifecycleChange({
      source: ctx?.source, target: input.lifecycle, current: gate.lifecycle, provenance: gate.provenance,
      externalSystem: gate.external_system,
    });
    if (denied) throw new HttpError(403, denied);
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
    assertNoContentSecrets(input);   // #4501
    const capped = applySoftCaps("knowledge_set_title", input, KSET_CAPS);
    // name 정규화는 공개범위 검사 **앞에서** — 아래 resolveKnowledgeGate 가 slugify 한 이름의 행을 고치므로 검사도
    //  같은 이름을 봐야 한다(knowledge_save 의 #1442 정규화와 같은 이유). slugify 는 멱등이다.
    input.name = slugify(input.name);
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

// fields(메타데이터) 부분 갱신 — set_title 과 같은 경량 메타 툴 계열(본문을 받지 않는다). knowledge_save 에 fields_patch 를
//  얹지 않은 이유: save 는 body_md 가 필수(replace·append)이거나 edits 가 필수(edit)라, code_sot 한 줄을 고치려고 본문이나
//  가짜 edit 를 실어야 한다 — set_title(#1442)이 없애려던 바로 그 재전송이다. 그리고 save 의 인입 게이트·서술 형식·리비전은
//  전부 제목·본문을 다루는 장치라 fields 만 바꾸는 저장엔 맞지 않는다.
//  인입 허용선 게이트(#783)는 탄다 — drop 이면 수정이 막힌 지식이라 fields 도 막는다. stage·review 도 거절한다:
//  수정 제안 모델(리비전)이 제목·본문만 담아 fields 를 실을 자리가 없어, stage 는 접수할 수 없고 review 는 반영해도
//  사람이 사후 검토할 diff 가 큐에 오르지 않는다(반려해도 되돌릴 수 없다) — 정책이 걸렸는데 집행이 빠진 «조용한 통과» 가 된다.
//  외부 미러(observed)는 거절한다 — append·edit 와 같은 이유(다음 재싱크가 fields 를 통째로 덮어 고친 값이 사라진다).
const KFIELDS_CAPS = SOFT_CAPS.knowledge_set_fields;
/** 패치 하나의 직렬화 상한 — fields 는 몇 개 키의 메타데이터다. 본문을 fields 로 우회해 싣는 것을 막는다. */
const FIELDS_PATCH_MAX_BYTES = 16 * 1024;
/** 병합 결과 상한 — 상한 안에 있던 fields 를 상한 밖으로 **넘기는** 패치만 거절한다. 커넥터가 이미 상한 넘게 채운 fields 는
 *  고칠 때마다 몇 바이트씩 늘 수 있으므로(code_sot 을 더 긴 문장으로 바꾸는 것도 증가다) 막지 않는다 — 그쪽 증가폭은 patch 상한이 묶는다. */
const FIELDS_MAX_BYTES = 64 * 1024;
/** 밑줄로 시작하는 최상위 키는 커넥터가 쓰는 시스템 값이다(_item_type — 미러가 원 item.type 을 보존하는 자리). */
const RESERVED_FIELD_KEY = /^_/;
/** 커넥터가 **읽고 그 값으로 행동하는** 최상위 키 — 노션 후처리(v6/mirror/notion-post.ts)는 external_system='notion' 인
 *  지식이면 provenance 와 무관하게 fields.notion.links·children_order 로 링크를 만들고 다른 지식의 sort 를 바꾼다.
 *  입양한(authored + 외부 좌표) 노션 문서에서 이 값을 고치면 남의 문서 순서를 바꾸는 우회로가 되므로 막는다. */
const CONNECTOR_FIELD_KEYS = new Set(["notion"]);
/** patch 의 중첩 깊이 상한 — fields 는 몇 단짜리 메타데이터다. 깊은 중첩은 재귀 병합·직렬화를 스택 초과(500)로 죽인다. */
const FIELDS_PATCH_MAX_DEPTH = 32;

/** patch 를 스택 없이 한 번 훑어 저장할 수 없는 값을 찾는다(없으면 null) — 깊이 상한 · `__proto__` 키 ·
 *  NUL(\u0000)·짝 없는 서로게이트(PG jsonb 가 거절해 500 이 된다) · 유한하지 않은 수(JSON 으로 못 쓴다 — null 로 바뀌어 저장된다).
 *  `__proto__` 를 막는 이유: JSON.parse 는 이걸 자기 키로 만들지만 병합의 `out[k] = …` 대입은 키가 아니라 프로토타입을 바꿔,
 *  저장되지 않은 채 changed:false 로 «성공» 한다(조용한 무시). 그래서 입구에서 400 으로 알린다. */
const BAD_JSON_TEXT = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function fieldsPatchProblem(root: unknown): string | null {
  const stack: Array<[unknown, number]> = [[root, 0]];
  while (stack.length) {
    const [v, depth] = stack.pop()!;
    if (typeof v === "string") { if (BAD_JSON_TEXT.test(v)) return "문자열에 NUL(\\u0000)이나 짝 없는 서로게이트가 있습니다"; continue; }
    if (typeof v === "number") { if (!Number.isFinite(v)) return "유한하지 않은 수(Infinity·NaN)는 쓸 수 없습니다"; continue; }
    if (v === null || typeof v !== "object") continue;
    if (depth >= FIELDS_PATCH_MAX_DEPTH) return `중첩이 ${FIELDS_PATCH_MAX_DEPTH}단을 넘습니다`;
    if (Array.isArray(v)) { for (const x of v) stack.push([x, depth + 1]); continue; }
    for (const [k, x] of Object.entries(v)) {
      if (k === "__proto__") return "__proto__ 키는 쓸 수 없습니다";
      if (BAD_JSON_TEXT.test(k)) return "키에 NUL(\\u0000)이나 짝 없는 서로게이트가 있습니다";
      stack.push([x, depth + 1]);
    }
  }
  return null;
}

/** expected_version 이 있으면 잠근 행의 판과 같아야 한다 — 어긋나면 409(current_version 을 실어 다시 읽게 한다). */
function assertFieldsVersion(current: number | string, expected: number | undefined): void {
  if (expected == null || Number(current) === expected) return;
  throw new HttpError(409, `이 지식은 그 사이 바뀌었습니다(보낸 판 ${expected}, 지금 판 ${current}). knowledge_get 으로 지금 값을 다시 읽고 고치세요 — 그대로 고치면 그 변경을 덮어씁니다.`,
    { body: { conflict: "version", expected_version: expected, current_version: Number(current) } });
}

/** REST·MCP 공통 patch 검증 — 객체 · 비어 있지 않음 · 예약 키 없음 · 저장할 수 없는 값 없음(깊이·`__proto__`·NUL 등) ·
 *  크기 상한 · 키 속 시크릿 없음. 통과하면 그대로 돌려준다. 재귀하는 검사(시크릿 키)는 깊이·크기를 확인한 **뒤에** 돈다. */
function validateFieldsPatch(raw: unknown): Record<string, unknown> {
  if (!isJsonObject(raw)) throw new HttpError(400, "patch 는 객체여야 합니다 — 예: {\"domain_wiki\": {\"code_sot\": \"…\"}} (null 값은 그 키를 지웁니다)");
  const keys = Object.keys(raw);
  if (!keys.length) throw new HttpError(400, "patch 가 비었습니다 — 바꿀 키를 하나 이상 지정하세요.");
  const reserved = keys.filter((k) => RESERVED_FIELD_KEY.test(k));
  if (reserved.length) {
    throw new HttpError(400, `밑줄로 시작하는 키(${reserved.join(", ")})는 커넥터가 관리하는 시스템 값이라 고칠 수 없습니다.`);
  }
  const connector = keys.filter((k) => CONNECTOR_FIELD_KEYS.has(k));
  if (connector.length) {
    throw new HttpError(400, `${connector.join(", ")} 키는 커넥터가 읽어 링크·순서를 정하는 값이라 고칠 수 없습니다 — 원본에서 고치세요.`);
  }
  const problem = fieldsPatchProblem(raw);
  if (problem) throw new HttpError(400, `patch 를 저장할 수 없습니다 — ${problem}.`);
  const bytes = Buffer.byteLength(JSON.stringify(raw), "utf8");
  if (bytes > FIELDS_PATCH_MAX_BYTES) {
    throw new HttpError(400, `patch 가 ${FIELDS_PATCH_MAX_BYTES / 1024}KiB 를 넘습니다(${bytes}바이트) — fields 는 짧은 메타데이터 자리입니다. 긴 내용은 본문(knowledge_save)에 쓰세요.`);
  }
  assertNoSecretKeys(raw, "patch");   // assertNoContentSecrets 는 값만 본다 — patch 는 키도 호출자가 정한다
  return raw;
}

const knowledgeSetFieldsInput = {
  name: z.string().min(1).max(64).describe("fields 를 고칠 지식 이름"),
  patch: z.record(z.unknown())
    .describe("fields 에 적용할 JSON Merge Patch(RFC 7396) — 적은 키만 바뀌고 나머지는 그대로 남는다. 값이 객체면 안쪽까지 병합한다"
      + "(예: {\"domain_wiki\": {\"code_sot\": \"…\"}} 는 domain_wiki.relpath 를 보존한다). 값이 null 이면 그 키를 지운다. 배열은 통째로 바뀐다. "
      + "밑줄로 시작하는 최상위 키(_item_type 등)와 커넥터가 읽는 notion 키는 고칠 수 없다."),
  expected_version: z.number().int().positive().optional()
    .describe("읽었을 때의 version(knowledge_get 의 knowledge.version). 보내면 지금 판과 다를 때 바꾸지 않고 409(current_version 포함)로 알린다."),
  change_note: z.string().optional()
    .describe(`#968 변경 요약 — 무엇을·왜 바꾸는지 1~2문장(변화 기록에 남는다). ${softCapHint(KFIELDS_CAPS.change_note)}`),
};
type KnowledgeSetFieldsInput = z.infer<z.ZodObject<typeof knowledgeSetFieldsInput>>;
export const knowledgeSetFields: Capability = {
  name: "knowledge_set_fields",
  title: "지식 fields 갱신",
  description:
    "기존 지식의 **fields(메타데이터)만** 고친다 — 본문·제목·provenance 는 그대로다. knowledge_get 응답의 knowledge.fields(예: domain_wiki.code_sot)를 바꿀 때 쓴다. " +
    "patch 는 JSON Merge Patch 다: 적은 키만 바뀌고, 객체는 안쪽까지 병합되며(형제 키 보존), null 은 그 키를 지운다. " +
    "version 이 올라가고 변화 기록(knowledge_history include_meta)에 남는다. 바뀐 게 없으면 저장하지 않고 changed:false 로 알린다. " +
    "외부 미러(observed) 지식과, 인입 허용선 정책이 수정을 막거나(drop) 검토를 요구하는(stage·review) 지식은 거절된다 — 수정 제안·검토 큐는 fields 를 담지 못한다. " +
    "외부 원본 좌표가 남은 지식이면 응답 resync_warning 이 온다 — 그 커넥터가 다시 싱크하면 fields 가 원본값으로 통째로 바뀐다. " +
    "응답 knowledge 에는 본문(body_md)이 없다(메타데이터만).",
  scope: "memory",
  input: knowledgeSetFieldsInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge/:name/fields"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        // REST 는 zod 를 안 타므로 여기서 거른다 — 숫자가 아닌 값을 조용히 버리면 CAS 를 요청한 호출이 대조 없이 덮어쓴다.
        //  Number() 로 바꾸지 않는다: true→1 · "0x10"→16 · [5]→5 · "1e1"→10 처럼 다른 판으로 대조하게 된다. 정수나 숫자 문자열만 받는다.
        let expected_version: number | undefined;
        const ev = b.expected_version;
        if (ev != null && ev !== "") {
          expected_version = typeof ev === "number" ? ev : typeof ev === "string" && /^\d+$/.test(ev) ? Number(ev) : NaN;
          if (!Number.isSafeInteger(expected_version) || expected_version < 1) throw new HttpError(400, "expected_version 은 1 이상의 정수");
        }
        return {
          name: String(req.params?.name ?? ""),
          patch: validateFieldsPatch(b.patch),
          expected_version,
          change_note: b.change_note ? String(b.change_note) : undefined,
        };
      } }],
  },
  handler: async (input: KnowledgeSetFieldsInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    const patch = validateFieldsPatch(input.patch);   // MCP 경로(zod 는 객체 여부만 본다)도 같은 판정 — 깊이를 먼저 묶어 아래 재귀 검사가 스택을 넘지 않게
    assertNoContentSecrets(input);   // #4501 — patch 안쪽 문자열까지 본다
    const capped = applySoftCaps("knowledge_set_fields", input, KFIELDS_CAPS);
    // 이름 정규화 → 공개범위 검사 순서는 set_title 과 같다(정규화한 이름의 행을 고치므로 검사도 그 이름을 본다).
    input.name = slugify(input.name);
    await assertKnowledgeWritable(input.name, ctx?.viewer ?? null);
    const gate = await resolveKnowledgeGate({ name: input.name }, ctx);
    if (gate.isCreate || !gate.before) {
      throw new HttpError(404, `지식 '${input.name}' 없음 — fields 갱신은 기존 지식에만 됩니다.`);
    }
    if (gate.update === "drop") {
      throw new HttpError(403, "인입 허용선 정책상 이 지식은 수정할 수 없습니다(drop) — 관리탭 '인입 허용선'에서 규칙을 확인하세요.");
    }
    if (gate.update === "stage" || gate.update === "review") {
      throw new HttpError(403, `이 지식의 수정은 사람 검토(${gate.update})를 거치는 정책인데, 수정 제안·검토 큐는 제목·본문만 담을 수 있어 fields 변경을 검토에 올릴 수 없습니다 — 관리탭 '인입 허용선' 규칙을 확인하세요.`);
    }
    if (gate.before.provenance === "observed") {
      throw new HttpError(400, "외부 미러(observed) 지식엔 fields 갱신이 허용되지 않습니다 — 다음 재싱크가 fields 를 통째로 덮어 고친 값이 사라집니다. 원본에서 고치세요.");
    }
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    const result = await patchKnowledgeFields(gate.before.name, patch, {
      changeNote: input.change_note ?? null,
      // 잠근 행 기준으로 본다 — 게이트가 읽은 판(gate.before)은 잠금 전 값이라 그 사이 저장을 못 본다.
      check: (before, merged) => {
        assertFieldsVersion(before.version, input.expected_version);
        const size = Buffer.byteLength(JSON.stringify(merged), "utf8");
        if (size > FIELDS_MAX_BYTES && Buffer.byteLength(JSON.stringify(before.fields ?? {}), "utf8") <= FIELDS_MAX_BYTES) {
          throw new HttpError(400, `병합 결과 fields 가 ${FIELDS_MAX_BYTES / 1024}KiB 를 넘습니다(${size}바이트) — 긴 내용은 본문에 쓰세요.`);
        }
      },
    }, writeCtx);
    // 게이트 조회와 잠금 사이에 지워진 경우.
    if (!result.found) throw new HttpError(404, `지식 '${input.name}' 없음`);
    // 응답에서 본문을 뺀다 — 이 툴은 본문 재전송을 없애려고 있는데, 15만 자 문서의 키 하나를 고쳐도 본문 전문이 되돌아오면
    //  그 비용을 응답이 다시 낸다(knowledge_save append 의 withBody 와 같은 판단).
    const { body_md: _body, ...k } = result.knowledge as Record<string, unknown>;
    const resync = k.external_system
      ? { resync_warning: `이 지식은 외부 원본(${String(k.external_system)}) 좌표를 갖고 있습니다 — 그 커넥터가 이 항목을 다시 싱크하면 fields 가 원본값으로 통째로 바뀝니다(본문·제목도). 오래 남길 값이면 원본에도 같이 고치세요.` }
      : {};
    return { knowledge: k, changed: result.changed, ...capped, ...resync };
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

// 검색 제외 토글(#5169 · 이슈 #1619) — searchable 만 갱신. set_wiki 와 같은 급의 소환 설정이라 인입 허용선(#783)을 타지 않는다:
//  본문·제목은 그대로이고, 검토 큐(리비전)는 이 값을 담을 자리가 없다. 공개범위 검사(assertKnowledgeWritable)는 탄다.
//  ⚠ REST 는 불리언만 받는다 — set_wiki 처럼 `=== true` 로 읽으면 누락·"false" 문자열이 조용히 «검색 제외» 가 되어
//   요청과 반대로 문서가 검색에서 사라진다.
const knowledgeSetSearchableInput = {
  name: z.string().min(1).max(64).describe("검색 제외를 켜거나 끌 지식 이름"),
  searchable: z.boolean().describe("false = 검색 제외(이름으로만 읽힌다) · true = 다시 검색 대상"),
};
type KnowledgeSetSearchableInput = z.infer<z.ZodObject<typeof knowledgeSetSearchableInput>>;
export const knowledgeSetSearchable: Capability = {
  name: "knowledge_set_searchable",
  title: "검색 제외 토글",
  description:
    "지식을 «검색 제외»로 두거나(searchable=false) 다시 검색 대상으로 돌린다(true). " +
    "검색 제외 지식은 knowledge_get(이름 · 부분 읽기)·knowledge_list(카테고리 목록 · q 거르기)·트리·링크·WIKI 인덱스 핀으로는 종전처럼 읽히지만, " +
    "knowledge_search·knowledge_grep·knowledge_similar·추천·자동 소환 훅에는 나오지 않고 임베딩도 하지 않는다(있던 벡터는 비운다). 사람이 화면에서 글로 찾을 때(⌘K · 링크 고르기)는 «검색 제외» 표시를 달고 나온다. " +
    "같은 사실이 검색용 문서에 이미 있는 재집계 문서·색인처럼 «이름으로만 읽는» 문서가 대상이다 — 검색 결과에 같은 사실이 두 번 나와 자리를 나눠 먹지 않게 한다. " +
    "true 로 돌리면 임베딩 대기로 돌아가 곧 다시 검색에 나온다. 값이 이미 같으면 아무것도 바꾸지 않는다(changed:false). 본문·제목·version 은 그대로다. " +
    "새로 만들 때부터 빼려면 knowledge_save 의 searchable:false 를 쓴다.",
  scope: "memory",
  input: knowledgeSetSearchableInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge/:name/searchable"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        if (typeof b.searchable !== "boolean") throw new HttpError(400, "searchable 은 true|false 로 보내세요");
        return { name: String(req.params?.name ?? ""), searchable: b.searchable };
      } }],
  },
  handler: async (input: KnowledgeSetSearchableInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertKnowledgeWritable(input.name, ctx?.viewer ?? null);
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    try {
      return await setKnowledgeSearchable(input.name, input.searchable, writeCtx);
    } catch (e) {
      if (/없음$/.test((e as Error).message)) throw new HttpError(404, (e as Error).message);
      throw e;
    }
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
  knowledgeSave, knowledgeSetLifecycle, knowledgeSetWiki, knowledgeDelete, knowledgeSetTitle, knowledgeSetFields,
  knowledgeSetSearchable,   // #5169 — 같은 까닭으로 맨 뒤(새 op 추가만이 표면 변화)
];
// #592 트리 이동 — 원본 등록 배열에서 **맨 뒤**(다른 :name 하위 경로들 뒤)였다. 도메인은 저작이지만
//  등록 순서(= tools/list 순 · REST 마운트 순 · 표면 스냅샷)를 바꾸지 않으려 자리를 지켜 따로 내보낸다.
export const authoringMoveCapabilities: Capability[] = [knowledgeMove];
