// org_member — 구성원 CRUD + jsonb 부속(온보딩 보고·하네스 관측 스냅샷·머신 별명·로컬 토글 지시)
//  + person/person_identity 동기화. (#1313 R18) 구 org/store.ts 에서 verbatim 분리.
import { itemsPool } from "../../db/client.js";
import { TENANT_DEFAULT_EXPR } from "../../db/tenant-column.js";
import { audit } from "./audit.js";
import { logger } from "../../log.js";

// ── 멤버 비활성 전이 훅(#1780 v2 §7-1, 설계 R2-O8) ──────────────────────────────
//  active → 비active(inactive·삭제) 전이는 **그 사람 이름으로 도는 것**(앱 동의·앱 세션·자격 리스)을 거둬야 한다.
//  이 저장소는 terminal/apps 를 몰라야 하므로(순환) registry.onTaskDone 선례의 단일 슬롯 콜백으로 둔다 —
//  apps/member-deactivation.ts 가 부팅 스텝에서 건다. 콜백 실패는 삼키고 경고만(멤버 상태 변경 자체는 성공해야 한다).
export type MemberDeactivatedReason = "inactive" | "removed";
type MemberDeactivatedHandler = (memberId: string, reason: MemberDeactivatedReason, actor: string | null) => Promise<void>;
let deactivatedHandler: MemberDeactivatedHandler | null = null;
export function onMemberDeactivated(cb: MemberDeactivatedHandler | null): void { deactivatedHandler = cb; }

/** 순수 판정 — 'active' 에서 벗어나는 전이만 true(inactive→inactive 재저장·inactive→삭제는 이미 거둬졌으므로 false). */
export function isMemberDeactivation(beforeState: string | null | undefined, afterState: string | null | undefined): boolean {
  return beforeState === "active" && afterState !== "active";
}

async function fireMemberDeactivated(memberId: string, reason: MemberDeactivatedReason, actor: string | null): Promise<void> {
  if (!deactivatedHandler) return;
  try { await deactivatedHandler(memberId, reason, actor); }
  catch (err) { logger.warn({ err, member: memberId, reason }, "member deactivation hook failed (state change kept)"); }
}

export interface MemberIdentity {
  system: string;
  external_id: string;
  email?: string;
  instance?: string;
  display_name?: string;
}
export interface OrgMember {
  id: string;
  kind: "human" | "agent" | "system";
  display_name: string | null;
  nickname: string | null; // 표시 이름과 별개의 닉네임(#762). 활동 로그 등 캐주얼 표기용. null/''=display_name 폴백.
  use_nickname: boolean;     // 「이 닉네임을 내 이름으로 사용」(#1813) — 켜면 이름을 보이는 자리 전부에서 nickname 이 이긴다.
  email: string | null;
  identities: MemberIdentity[];
  body_md: string;
  avatar: string | null; // 프로필 이미지 data URL(셀프 업로드). null=이니셜+색상 자동생성.
  avatar_char: string | null; // 이미지 없을 때 쓸 커스텀 글자(1~3자). null=이름 이니셜 자동.
  avatar_color: string | null; // 이미지 없을 때 쓸 커스텀 배경색(#rrggbb). null=id 해시색 자동.
  state: "active" | "inactive";
  scopes: string[]; // 권한(발급 토큰의 scope)
  sort: number;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}

// ── org_member ──
function mapMember(row: Record<string, unknown>): OrgMember {
  return {
    id: row.id as string,
    kind: row.kind as OrgMember["kind"],
    display_name: (row.display_name as string) ?? null,
    nickname: (row.nickname as string) ?? null,
    use_nickname: row.use_nickname === true,
    email: (row.email as string) ?? null,
    identities: (row.identities as MemberIdentity[]) ?? [],
    body_md: (row.body_md as string) ?? "",
    avatar: (row.avatar as string) ?? null,
    avatar_char: (row.avatar_char as string) ?? null,
    avatar_color: (row.avatar_color as string) ?? null,
    state: row.state as OrgMember["state"],
    scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
    sort: (row.sort as number) ?? 0,
    version: (row.version as number) ?? 1,
    updated_at: (row.updated_at as string) ?? null,
    updated_by: (row.updated_by as string) ?? null,
  };
}

const MEMBER_COLS = "id, kind, display_name, nickname, use_nickname, email, identities, body_md, avatar, avatar_char, avatar_color, state, scopes, sort, version, updated_at, updated_by";

export async function listMembers(): Promise<OrgMember[]> {
  const r = await itemsPool.query(`SELECT ${MEMBER_COLS} FROM org_member ORDER BY sort, id`);
  return r.rows.map(mapMember);
}

export async function getMember(id: string): Promise<OrgMember | null> {
  //  ★ 지금 맥락으로 못박는다(#1879) — 접기가 남긴 짝이 있으면 tenant 없는 조회는 **아무 행이나**
  //   돌려준다. 상수(primary)로 박으면 매니지드에서 RLS 가 걸러 0행이 된다(실측) — 그래서 맥락식이다.
  const r = await itemsPool.query(
    `SELECT ${MEMBER_COLS} FROM org_member WHERE id=$1 AND tenant_id = ${TENANT_DEFAULT_EXPR}`, [id]);
  return r.rows[0] ? mapMember(r.rows[0]) : null;
}

// ── 구성원 온보딩(#846/850) — **보고된** 상태만 담는다 ──────────────────────────────
//  자동 판정되는 것(MCP 호출 이력·자격 등록·레포 연결)은 여기 없다 — computeMemberOnboarding 이 조회
//  시점에 라이브 계산한다. 이 컬럼엔 서버가 **볼 수 없는 것**(그 사람 노트북의 로컬 이관 완료 — AI 스킬이
//  보고)과 사용자의 **의도적 오버라이드**(웹 ⋯ 메뉴)만 들어간다. 상태를 두 곳에 두면 반드시 어긋난다.
//  OrgMember 타입엔 넣지 않는다 — listMembers/admin 응답에 실릴 이유가 없다.
export interface ReportedStep { state: "done" | "skipped"; at: string; by: "ai" | "self"; note?: string }

export async function getMemberOnboarding(id: string): Promise<Record<string, ReportedStep>> {
  const r = await itemsPool.query(`SELECT onboarding FROM org_member WHERE id=$1`, [id]);
  const v = r.rows[0]?.onboarding as unknown;
  return (v && typeof v === "object" && !Array.isArray(v)) ? v as Record<string, ReportedStep> : {};
}

// 한 스텝만 갱신(다른 스텝 보존). patch=null 이면 그 키를 **삭제** = '다시 열기'(자동 판정으로 복귀).
//  jsonb_set 은 상위 키가 없으면 no-op 이라 shallow merge(`||`)를 쓴다.
export async function setMemberOnboardingStep(
  id: string, step: string, patch: ReportedStep | null,
): Promise<Record<string, ReportedStep>> {
  const r = patch
    ? await itemsPool.query(
      `UPDATE org_member SET onboarding = COALESCE(onboarding,'{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb)
         WHERE id=$1 RETURNING onboarding`, [id, step, JSON.stringify(patch)])
    : await itemsPool.query(
      `UPDATE org_member SET onboarding = COALESCE(onboarding,'{}'::jsonb) - $2::text
         WHERE id=$1 RETURNING onboarding`, [id, step]);
  if (!r.rows[0]) throw new Error("구성원 정보를 찾을 수 없습니다");
  return (r.rows[0].onboarding ?? {}) as Record<string, ReportedStep>;
}

// ── 리브 프로필(#1631) — **리브가 이 사람에 대해 아는 것**이 사는 자리 ──────────────
//  리브의 기억은 대화가 아니라 여기 있다(세션은 교체 가능하다는 기획 불변식). 그래서 담는 것은
//  서버가 **볼 수 없는 것**뿐이다 — 온보딩·파이프라인·하네스 인벤토리는 각자 자기 자리에서 라이브
//  계산되므로 여기 복제하면 두 개의 진실이 생긴다(#850 이 온보딩에서 이미 내린 결론).
export interface LivWork { asis?: string; tobe?: string; at?: string; by?: "ai" | "self" }
/** 처음 설정의 결과. 무엇을 만들었는지까지 남긴다 — "왜 이 서랍이 있죠?" 에 답할 유일한 근거다. */
//  session_id(#1631) — 처음 설정 직후 열린 **리브 세션**. 다시 반영해도 세션을 또 열지 않는 근거(멱등)이자 화면이 그리로 보내는 좌표.
//  distill_at / distill_gave_up_at / distill_note — 2턴(증류 지시)을 그 세션에 넣었나·포기했나·왜(second-turn-sweep). 둘 다 없으면 대기 중.
export interface LivWelcome {
  done_at: string; drawers?: string[]; first_order?: string | null; session_id?: string | null;
  distill_at?: string | null; distill_gave_up_at?: string | null; distill_note?: string | null;
}

/**
 * (#1631) 2턴 대기 중인 사람 — 리브 세션은 열렸는데 증류 지시를 아직 안 넣었고 포기도 안 한 구성원.
 *  신원 전역 표라 테넌트 컨텍스트 없이 **모든 워크스페이스를 한 번에** 훑는다(스윕이 워크스페이스마다 돌지 않는다).
 *
 * ⚠ welcome 은 #2265 이후 **워크스페이스 칸**(by_workspace)에 산다. 옛 최상위 자리도 아직 남아 있을 수
 *  있으므로(승계 전) 둘을 합쳐 본다 — 한쪽만 보면 그 사람들에게 2턴이 영영 안 간다.
 *  돌려주는 `workspace_id` 는 호출부가 **그 테넌트 컨텍스트 안에서** 표식을 찍는 데 쓴다(안 그러면 멱등이 깨져 반복 발사).
 */
export async function listLivSecondTurnCandidates(): Promise<Array<{ id: string; display_name: string | null; welcome: LivWelcome; workspace_id: string | null }>> {
  const r = await itemsPool.query(
    `WITH cand AS (
       SELECT id, display_name, NULL::text AS ws, liv_profile->'welcome' AS welcome
         FROM org_member WHERE state='active' AND kind='human' AND liv_profile ? 'welcome'
       UNION ALL
       SELECT m.id, m.display_name, e.key AS ws, e.value->'welcome' AS welcome
         FROM org_member m,
              LATERAL jsonb_each(COALESCE(m.liv_profile->'by_workspace', '{}'::jsonb)) e
        WHERE m.state='active' AND m.kind='human' AND e.value ? 'welcome'
     )
     SELECT id, display_name, ws, welcome FROM cand
      WHERE welcome->>'session_id' IS NOT NULL
        AND welcome->>'distill_at' IS NULL
        AND welcome->>'distill_gave_up_at' IS NULL
      ORDER BY welcome->>'done_at' ASC LIMIT 200`);
  return r.rows.map((x) => ({
    id: String(x.id), display_name: (x.display_name as string | null) ?? null,
    welcome: x.welcome as LivWelcome, workspace_id: (x.ws as string | null) ?? null,
  }));
}
/**
 * 처음 설정을 **하다 만 자리**(#2207). 끝난 결과(LivWelcome)와 별개다 — 이건 아직 안 끝난 사람의 자리표다.
 *
 * 왜 서버에 두나: 종전엔 진행 상태가 브라우저 sessionStorage(`lively-ob-v2`) 하나였다. sessionStorage 는
 *  **탭을 닫으면 사라진다** — 온보딩을 하다 창을 닫고 app.lvly.io 로 다시 들어오면 이름부터 다시 물었고,
 *  거기까지 답한 것(무대·직무·고른 AI·자료함 갈래)은 아무 데도 안 남았다. 답을 받아 놓고 잃는 것은
 *  이름·업무를 그 자리에서 저장하기로 한 결정(#1813)과 같은 이유로 고쳐야 하는 결함이다.
 *
 * `state` 는 **화면이 쥔 상태 그대로**(불투명)다. 서버는 해석하지 않는다 — 장면이 늘고 줄 때마다
 *  서버 스키마를 따라 고치게 만들면 그 순간부터 두 벌이 어긋난다. 서버가 아는 것은 두 가지뿐:
 *  «어느 장면에서 멈췄나»(scene — 되돌아갈 자리)와 «언제»(at). 나머지는 화면이 읽고 화면이 쓴다.
 */
export interface LivWelcomeProgress {
  /** 마지막으로 저장된 시각(ISO). */
  at: string;
  /** 멈춘 장면 key(화면의 SCENES/CHAT_STEPS key). 되돌아갈 자리. */
  scene: string;
  /** 화면이 쥔 진행 상태 그대로 — 서버는 해석하지 않는다. */
  state: Record<string, unknown>;
}
export interface LivDecision { at: string; what: string; why?: string; by?: string }
/** 사람이 "그건 안 할게요"라고 한 것. `key` 는 카드 key(예: `org.embeddings`). */
export interface LivDeclined { at: string; key: string; why?: string }
/**
 * 리브가 **지금 사람에게 받아야 하는 자격 하나**(#1631).
 *
 * ⚠ 여기 담기는 것은 "무엇이 필요한가"뿐이다 — **값은 절대 담기지 않는다.** 값은 화면이 받아
 *  곧바로 금고(수집기 secrets)로 보내고, 이 요청은 지워진다. 리브는 값을 보지 못한다.
 *
 * 왜 프로필에 얹었나: 이건 지식이 아니라 **일시 상태**라 원래는 남의 자리다. 그럼에도 여기 둔 이유는
 *  ① 사람 축으로 정확히 하나이고 ② 새로고침을 견뎌야 하며(사람이 창을 다시 열 수 있다)
 *  ③ 리브 화면이 이미 이 레코드를 읽고 있어서다. 테이블을 하나 더 만들 값어치가 없다.
 */
export interface LivSecretAsk {
  at: string;
  kind?: "secret";
  /** 어디에 넣을 것인가 — 지금은 수집기뿐이다(collector.id + 그 프리셋의 시크릿 필드 key). */
  collector_id: number;
  field: string;
  /** 사람에게 보일 것. label = 칸 이름, why = 왜 필요한지 한 줄. */
  label: string;
  why?: string;
  /** 값이 어떻게 생겼는지(예: `ntn_` 로 시작하는 긴 문자열). 사람이 맞게 복사했는지 스스로 확인한다. */
  hint?: string;
}

/**
 * **객관식 질문**(#1631) — 리브가 묻고 사람은 고르기만 한다.
 *
 * 왜 객관식인가: 실측에서 사람이 가장 오래 멈춘 자리가 **자유서술**이었다("어디에 쌓고 계셨나요?").
 *  없는 말을 지어내야 하니 어렵고, 답이 제각각이라 우리도 통계를 못 낸다. 고르게 하면 둘 다 풀린다 —
 *  사람은 쉽고, **답이 저절로 구조화된다**(아래 LivAnswer). 그게 이 둘을 한 기능으로 묶은 이유다.
 */
export interface LivChoiceAsk {
  at: string;
  kind: "choice";
  /** 통계의 축이 되는 안정된 key(예: `context_sources`). 문구가 바뀌어도 이건 안 바뀐다. */
  key: string;
  question: string;
  why?: string;
  options: Array<{ id: string; label: string; hint?: string }>;
  /** 복수 선택 허용(예: 쓰는 도구를 다 고르기). */
  multi?: boolean;
  /** '그 외' 자유입력 허용 — 목록에 없는 소스를 놓치지 않기 위한 탈출구. */
  allow_other?: boolean;
}

/** **파일 올리기**(#1631) — 로컬 폴더를 뒤지는 대신 사람이 끌어다 놓는다. */
export interface LivUploadAsk {
  at: string;
  kind: "upload";
  label: string;
  why?: string;
  /** 사람에게 보여줄 허용 형식 안내(실제 차단은 화면이 한다). */
  accept_hint?: string;
}

export type LivAsk = LivSecretAsk | LivChoiceAsk | LivUploadAsk;

/**
 * 사람이 고른 답 — **통계의 원재료**.
 *
 * `key` 가 축이고 `choices` 가 값이라, 워크스페이스 전체에서 SQL 한 줄로 집계된다
 * (예: 어떤 소스를 쓰는 사람이 몇 %인가 · 커넥터 없는 소스로 무엇을 적어내나).
 */
export interface LivAnswer {
  at: string;
  key: string;
  choices: string[];
  /** '그 외'로 적어낸 자유입력. **여기 쌓이는 것이 곧 다음에 만들 커넥터 후보다.** */
  other?: string;
  question?: string;
  /**
   * 누가 기록했나 — `self`(사람이 버튼을 눌렀다) · `liv`(사람이 채팅으로 답한 걸 리브가 옮겨 적었다).
   *
   * ⚠ 왜 나눠야 하나: 리브가 옮겨 적는 걸 허용하지 않으면 **채팅으로 답한 사람의 답이 통째로 유실된다**
   *  (실측: 카톡·네이버밴드를 쓴다고 말했는데 버튼을 안 눌러 통계에 한 줄도 안 남았다). 그렇다고 섞어
   *  버리면 리브가 잘못 옮긴 것과 사람이 직접 고른 것을 구분할 수 없다 — 그래서 표시해 두고 따로 센다.
   */
  by?: "self" | "liv";
}

/** 리브와의 대화 한 줄기(#1631 v1 채팅). **세션이 아니라 여기 산다** — 게이트웨이가 재시작해도
 *  다음 턴이 같은 대화를 이어받는다(`--resume <session_id>`). 대화 내용은 담지 않는다:
 *  본문은 하네스가 자기 트랜스크립트에 갖고 있고, 여기 복제하면 진실이 둘이 된다. */
/** 지나간 턴 한 건 — **본문이 아니라 어디서 읽을지**만 담는다(본문은 그 턴의 진행 파일에 있다). */
export interface LivTurnRef {
  id: string;      // 턴 id(그 턴의 작업 폴더 이름)
  text: string;    // 사람이 한 말 — 이건 어디에도 안 남아서 여기 담는다(리브의 말은 진행 파일에 있다)
  at: string;
  /** 그 턴이 도는 세션 id. **멈추려면 이게 있어야 한다** — 없으면 사람은 시작만 하고 못 멈춘다.
   *  본인 프로필에서만 나오므로 남의 턴은 구조상 못 건드린다. */
  sid?: string;
}

export interface LivChat {
  /** claude 대화 세션 uuid. 첫 턴이 만들고 이후 턴이 이어받는다. */
  session_id: string;
  started_at: string;
  /** 이 대화의 턴들(오래된 것부터). **화면이 새로고침 뒤 기록을 되그리는 근거**다.
   *  ⚠ 리브의 말을 여기 복제하지 않는다 — 진행 파일이 정본이고, 복제하면 진실이 둘이 된다. */
  turns?: LivTurnRef[];
}

export interface LivProfile {
  work?: LivWork; decisions?: LivDecision[]; declined?: LivDeclined[];
  /** 처음 설정(#/welcome)을 끝낸 시각. 종전엔 브라우저 localStorage 표식이라 기기를 바꾸면 온보딩이 다시 떴다(#1813). */
  welcome?: LivWelcome | null;
  /** 처음 설정을 **하다 만 자리**(#2207). 끝나면 지운다(끝난 사실은 위 welcome·onboarded_at 이 말한다). */
  welcome_progress?: LivWelcomeProgress | null;
  /** 처음 설정(#/welcome)을 끝낸 시각(#2039). **브라우저가 아니라 여기가 정본** — 기기를 바꿔도 다시 안 뜬다. */
  onboarded_at?: string | null;
  /**
   * 처음 설정으로 **자동으로 보낸** 시각(#2171). onboarded_at 과 다른 사실이다 —
   *  저건 «끝냈다», 이건 «보여는 줬다». 자동 진입은 이 표식으로 **평생 한 번**만 한다.
   *  종전엔 완주(onboarded_at)만이 유일한 탈출구라, 중간에 나간 사람은 앱을 열 때마다 다시 끌려갔다.
   */
  welcome_shown_at?: string | null;
  /**
   * 사람이 스스로 [나중에 할게요] 로 처음 설정을 **미룬** 시각(#2232). 있으면 하다 만 자리가 있어도 자동으로
   *  끌고 가지 않는다(홈 + «이어서 하기»). 다시 이어서 답을 하나라도 더 하면(진행 저장) 지운다 — 미룸은
   *  '지금은 말고'지 '영영 말고'가 아니다.
   */
  welcome_deferred_at?: string | null;
  /** 대기 중인 요청(자격·객관식·업로드) 하나. 받으면 즉시 지운다 — 시크릿 값은 여기 오지 않는다. */
  secret_ask?: LivAsk | null;
  /** 사람이 고른 답들. 뒤에 쌓인다. */
  answers?: LivAnswer[];
  /** 지금 이어가고 있는 대화. 새로 시작하면 갈아끼운다(null 이면 다음 턴이 첫 턴). */
  chat?: LivChat | null;
}

const LIV_LIST_CAP = 50; // 결정·거절 이력 상한 — 오래된 것부터 버린다(프로필은 로그가 아니다)

/** 요청을 걸거나(ask) 지운다(null). 시크릿 값은 절대 지나가지 않는다. */
export async function setLivSecretAsk(id: string, ask: LivAsk | null): Promise<LivProfile> {
  const cur = await getLivProfile(id);
  const next: LivProfile = { ...cur, secret_ask: ask };
  return await writeLivProfile(id, next as unknown as Record<string, unknown>);
}

/** 이어갈 대화를 정한다(null = 다음 턴이 첫 턴). 대화 **본문은 저장하지 않는다** — 이어받을 열쇠만.
 *  ⚠ 이 함수는 읽고-쓰기라, 같은 사람이 동시에 두 턴을 시작하면 뒤가 앞을 덮는다. 리브 화면은 답을
 *   기다리는 동안 입력을 막으므로 v1 에선 그 경합이 생기지 않는다(막는 게 풀리면 여기부터 다시 봐야 한다). */
/** 이 대화에 턴 하나를 잇는다. 되그릴 수 있는 만큼만 들고 있는다(오래된 것부터 버린다). */
export async function appendLivTurn(id: string, turn: LivTurnRef, cap = 30): Promise<LivProfile> {
  const cur = await getLivProfile(id);
  const chat = cur.chat;
  if (!chat) return cur;                       // 대화가 없으면 이을 곳도 없다
  const turns = [...(chat.turns ?? []), turn].slice(-cap);
  const next: LivProfile = { ...cur, chat: { ...chat, turns } };
  return await writeLivProfile(id, next as unknown as Record<string, unknown>);
}

/**
 * 처음 설정을 하다 만 자리를 남긴다(null = 지운다 — 끝났거나 처음부터 다시 하기로 했을 때) (#2207).
 *
 * ⚠ 읽고-쓰기라 같은 사람이 두 탭에서 온보딩을 하면 뒤가 앞을 덮는다. 그게 맞다 — **마지막으로 만진
 *  화면이 그 사람의 지금**이고, 두 진행을 합칠 방법도 뜻도 없다(반쯤 A, 반쯤 B 인 답은 답이 아니다).
 */
export async function setLivWelcomeProgress(id: string, progress: LivWelcomeProgress | null): Promise<LivProfile> {
  const cur = await getLivProfile(id);
  const next: LivProfile = { ...cur, welcome_progress: progress };
  //  ⚠ #2232 — 여기서 미룸(welcome_deferred_at)을 지우면 안 된다(한 번 그렇게 썼다가 실측으로 잡았다).
  //   [나중에 할게요] 는 «미룸 표식 POST» 와 «나가면서 밀리는 진행 flush» 를 거의 동시에 보내는데, 순서가
  //   뒤집히면 방금 찍은 미룸이 그 자리에서 지워져 다음 입장에 또 끌려간다. 미룸을 푸는 자리는 **사람이
  //   처음 설정 화면을 다시 연 순간**이다(web/v2/onboarding.ts clearWelcomeDeferred) — 그건 나가기보다
  //   한참 앞서 일어나므로 경합이 없다.
  return await writeLivProfile(id, next as unknown as Record<string, unknown>);
}

export async function setLivChat(id: string, chat: LivChat | null): Promise<LivProfile> {
  const cur = await getLivProfile(id);
  const next: LivProfile = { ...cur, chat };
  return await writeLivProfile(id, next as unknown as Record<string, unknown>);
}

/**
 * 고른 답을 남기고 그 요청을 내린다(한 트랜잭션의 뜻 — 답했으면 질문은 사라져야 한다).
 *
 * ⚠ **같은 key 는 갈아끼운다.** 다시 물어 다시 답했으면 최신 하나만 의미가 있고,
 *  두 줄이 남으면 집계가 사람 수보다 커진다(통계가 틀어지는 가장 흔한 경로).
 */
export async function appendLivAnswer(id: string, answer: LivAnswer): Promise<LivProfile> {
  const cur = await getLivProfile(id);
  const { mergeAnswer } = await import("../delivery/liv-secret.js");
  const next: LivProfile = { ...cur, answers: mergeAnswer(cur.answers ?? [], answer, LIV_LIST_CAP) as LivAnswer[], secret_ask: null };
  return await writeLivProfile(id, next as unknown as Record<string, unknown>);
}

/**
 * 워크스페이스 전체 답변 집계 — **개선점을 찾는 자리**.
 *
 * 특히 `other`(목록에 없어 직접 적어낸 것)가 중요하다: 거기 쌓이는 이름이 **다음에 만들 커넥터 후보**다.
 * 사람 이름은 내보내지 않는다(누가 답했는지가 아니라 무엇이 몇 번인지가 알고 싶은 것이다).
 */
export async function livAnswerStats(): Promise<Array<{
  key: string; question: string | null; responders: number; by_self: number; by_liv: number;
  choices: Array<{ id: string; n: number }>; others: Array<{ text: string; n: number }>;
}>> {
  const r = await itemsPool.query<{ liv_profile: LivProfile }>(
    `SELECT liv_profile FROM org_member WHERE liv_profile ? 'answers'`);
  const { foldAnswerStats } = await import("../delivery/liv-secret.js");
  return foldAnswerStats(r.rows.map((row) => row.liv_profile?.answers ?? []));
}

// ── 리브 프로필의 층 가르기(#2265) — 계정 축과 워크스페이스 축을 한 컬럼 안에서 나눈다.
//  ⚠ **별도 모듈로 빼지 않는다.** members.ts 는 노드 에이전트 번들에 이미 실려 있어서, 여기서 새 파일을
//   import 하면 그 잎이 번들에 따라 들어가 경계 부채가 늘어난다(scripts/node-agent-bundle-boundary.test.mjs
//   가 상한으로 막는다). 순수 함수라 여기 있어도 테스트에 지장이 없다.
//
//  ── 문제 ──
//  `org_member` 는 IDENTITY_GLOBAL 표라(db/tenant-column.ts) `liv_profile` 이 **계정당 한 벌**이다.
//  그런데 그 안의 상당수는 워크스페이스마다 달라야 하는 사실이다(서랍·첫 지시·리브 세션 좌표·설정 결정).
//  그래서 워크스페이스 두 곳에서 온보딩하면 **뒤가 앞을 덮는다**
//  (실측: 한 계정으로 여러 워크스페이스를 시딩했더니 그 계정의 결정 이력 27건이 사라졌다).
//
//  ── 왜 새 표를 안 만드나 ──
//  같은 컬럼 안에서 층만 가르면 마이그레이션이 필요 없고 되돌리기도 쉽다. RLS·백업·복구 표면도 안 늘어난다.
//  옛 데이터는 **옮기지 않는다** — 읽을 때 워크스페이스 자리가 비어 있으면 옛 최상위 값으로 폴백하므로,
//  기존 사용자는 자기 첫 워크스페이스에서 종전과 똑같이 보인다. 쓸 때부터 새 자리에 넣는다.

/** 워크스페이스마다 달라야 하는 키 — 이 표가 이 변경의 전부다. */
export const WORKSPACE_SCOPED_KEYS = ["welcome", "welcome_progress", "onboarded_at", "decisions"] as const;
export type WorkspaceScopedKey = (typeof WORKSPACE_SCOPED_KEYS)[number];

/** 워크스페이스 층이 사는 자리. */
export const BY_WORKSPACE = "by_workspace";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * 저장된 프로필에서 **이 워크스페이스가 보는 한 벌**을 만든다(순수).
 *
 * 계정 층은 그대로 얹고, 워크스페이스 층은 `by_workspace[wsId]` 에서 가져온다.
 * 그 자리가 없으면 **옛 최상위 값으로 폴백**한다(하위호환) — 단, 워크스페이스 id 가 없을 때(단일 테넌트)도 같다.
 *
 * ⚠ 폴백은 **옛 최상위**만 본다. 다른 워크스페이스의 값을 빌려 오지 않는다 — 그게 이 결함의 본체다.
 */
export function viewForWorkspace(profile: Rec | null | undefined, workspaceId: string | null | undefined): Rec {
  const p = isRec(profile) ? profile : {};
  const ws = String(workspaceId ?? "").trim();
  const out: Rec = {};
  // ① 계정 층 — by_workspace 와 워크스페이스 전용 키를 뺀 나머지 전부.
  for (const [k, v] of Object.entries(p)) {
    if (k === BY_WORKSPACE) continue;
    if ((WORKSPACE_SCOPED_KEYS as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  // ② 워크스페이스 층 — 새 자리가 있으면 그것, 없으면 옛 최상위(폴백).
  const box = isRec(p[BY_WORKSPACE]) ? (p[BY_WORKSPACE] as Rec) : {};
  const mine = ws && isRec(box[ws]) ? (box[ws] as Rec) : null;
  for (const k of WORKSPACE_SCOPED_KEYS) {
    if (mine && k in mine) out[k] = mine[k];
    else if (!mine && k in p) out[k] = p[k];    // 새 자리가 아예 없을 때만 옛 값을 쓴다
  }
  return out;
}

/**
 * 갱신할 조각을 층에 맞게 **꽂아 넣은 새 프로필**을 만든다(순수 — 원본을 안 바꾼다).
 *
 * 워크스페이스 전용 키는 `by_workspace[wsId]` 로, 나머지는 최상위로 간다.
 * 워크스페이스 id 가 없으면(단일 테넌트·컨텍스트 밖) 종전처럼 최상위에 쓴다 — 무회귀.
 */
export function mergeForWorkspace(profile: Rec | null | undefined, patch: Rec, workspaceId: string | null | undefined): Rec {
  const p: Rec = { ...(isRec(profile) ? profile : {}) };
  const ws = String(workspaceId ?? "").trim();
  if (!ws) return { ...p, ...patch };

  const box: Rec = isRec(p[BY_WORKSPACE]) ? { ...(p[BY_WORKSPACE] as Rec) } : {};
  const mine: Rec = isRec(box[ws]) ? { ...(box[ws] as Rec) } : {};
  //  새 자리를 처음 만들 때는 **옛 최상위 값을 밑에 깔아** 시작한다(그 워크스페이스가 첫 워크스페이스였을 수 있다).
  //  안 깔면 기존 사용자가 한 번 쓰는 순간 종전 값이 사라진 것처럼 보인다.
  const seeded = isRec(box[ws]) ? mine : Object.fromEntries(
    WORKSPACE_SCOPED_KEYS.filter((k) => k in p).map((k) => [k, p[k]]));

  const nextMine: Rec = { ...seeded };
  for (const [k, v] of Object.entries(patch)) {
    if ((WORKSPACE_SCOPED_KEYS as readonly string[]).includes(k)) nextMine[k] = v;
    else p[k] = v;
  }
  box[ws] = nextMine;
  p[BY_WORKSPACE] = box;
  //  승계가 끝났으면 **옛 최상위 자리를 비운다.** 남겨 두면 아직 칸이 없는 *다른* 워크스페이스가
  //  그 값을 폴백으로 상속해 «이미 온보딩했고 리브 세션도 있다»고 오인한다(그러면 2턴이 안 간다).
  //  폴백은 '아무 워크스페이스도 아직 쓴 적 없을 때' 한 번만 쓰이는 다리여야 한다.
  for (const k of WORKSPACE_SCOPED_KEYS) delete p[k];
  return p;
}

// ── 워크스페이스 층(#2265) ──────────────────────────────────────────────────
//  org_member 는 IDENTITY_GLOBAL 표라 liv_profile 이 계정당 한 벌인데, 그 안의 서랍·첫 지시·리브 세션
//  좌표·설정 결정은 **워크스페이스마다 달라야 한다**. 그래서 같은 컬럼 안에서 층을 가른다
//  (형태·폴백 규율은 org/liv/profile-scope.ts 머리말).
//
//  ⚠ **쓰기는 반드시 이 창구를 지난다.** 읽어 온 프로필은 '이 워크스페이스가 보는 뷰'라,
//   그걸 `{...cur}` 로 통째로 되쓰면 **다른 워크스페이스 칸이 통째로 날아간다.**
async function writeLivProfile(id: string, patch: Record<string, unknown>): Promise<LivProfile> {
  const { currentTenant } = await import("../tenant-context.js");
  const ws = currentTenant()?.id ?? null;
  const raw = await itemsPool.query(`SELECT liv_profile FROM org_member WHERE id=$1`, [id]);
  if (!raw.rows[0]) throw new Error("구성원 정보를 찾을 수 없습니다");
  const cur = (raw.rows[0].liv_profile ?? {}) as Record<string, unknown>;
  const next = mergeForWorkspace(cur, patch, ws);
  const r = await itemsPool.query(
    `UPDATE org_member SET liv_profile=$2::jsonb WHERE id=$1 RETURNING liv_profile`, [id, JSON.stringify(next)]);
  if (!r.rows[0]) throw new Error("구성원 정보를 찾을 수 없습니다");
  return viewForWorkspace((r.rows[0].liv_profile ?? {}) as Record<string, unknown>, ws) as LivProfile;
}

export async function getLivProfile(id: string): Promise<LivProfile> {
  const { currentTenant } = await import("../tenant-context.js");
  const r = await itemsPool.query(`SELECT liv_profile FROM org_member WHERE id=$1`, [id]);
  const v = r.rows[0]?.liv_profile as unknown;
  const raw = (v && typeof v === "object" && !Array.isArray(v)) ? v as Record<string, unknown> : {};
  return viewForWorkspace(raw, currentTenant()?.id ?? null) as LivProfile;
}

/**
 * 프로필을 **덧붙인다**(replace 아님).
 *
 * - `work` 는 주면 통째로 갈아끼운다(ASIS/TOBE 는 최신 하나만 의미가 있다).
 * - `decision`·`declined` 는 **뒤에 쌓는다**. 같은 key 의 거절이 이미 있으면 갱신한다 —
 *   두 번 거절했다고 두 줄이 남을 이유가 없고, 중복이 쌓이면 상한에 걸려 옛 결정이 밀려난다.
 */
export async function appendLivProfile(
  id: string, patch: { work?: LivWork; decision?: LivDecision; declined?: LivDeclined; welcome?: LivWelcome; onboarded?: boolean; welcomeSeen?: boolean; welcomeDeferred?: boolean },
): Promise<LivProfile> {
  const cur = await getLivProfile(id);
  const next: LivProfile = { ...cur };
  if (patch.work) next.work = { ...patch.work, at: patch.work.at ?? new Date().toISOString() };
  if (patch.welcome) next.welcome = patch.welcome;
  // #2039 — 처음 설정을 끝냈다는 표식. 처음 찍힌 시각을 지킨다(다시 둘러봐도 '처음'이 뒤로 밀리지 않게).
  if (patch.onboarded && !cur.onboarded_at) next.onboarded_at = new Date().toISOString();
  // #2171 — 자동으로 처음 설정에 **보냈다**는 표식. 끝냈다는 뜻이 아니다(위와 별개 사실).
  //  처음 찍힌 시각을 지킨다 — 이 값이 곧 '자동 진입은 평생 한 번' 의 근거라 뒤로 밀리면 안 된다.
  if (patch.welcomeSeen && !cur.welcome_shown_at) next.welcome_shown_at = new Date().toISOString();
  // #2232 — [나중에 할게요]. true=미룸(매번 갱신 — 마지막으로 미룬 시각이 뜻이 있다) · false=미룸 해제(다시 열었다).
  if (patch.welcomeDeferred === true) next.welcome_deferred_at = new Date().toISOString();
  else if (patch.welcomeDeferred === false) delete next.welcome_deferred_at;
  if (patch.decision) next.decisions = [...(cur.decisions ?? []), patch.decision].slice(-LIV_LIST_CAP);
  if (patch.declined) {
    const rest = (cur.declined ?? []).filter((d) => d.key !== patch.declined!.key);
    next.declined = [...rest, patch.declined].slice(-LIV_LIST_CAP);
  }
  return await writeLivProfile(id, next as unknown as Record<string, unknown>);
}

// ── 로컬 하네스 관측 스냅샷(#891 온보딩 C) — 세션훅이 push, 웹이 라이블리 자산과 대조 ──
//  ⚠ 관측이지 보고가 아니다(onboarding 과 별 컬럼). **메타만**(id·kind·managed) — 스킬 본문·메모리는 절대 안 담는다.
//  ⚠ **머신별 맵**이다 — 한 멤버가 PC 여러 대(집·회사)를 쓰면 각각 다른 로컬 환경이다. machine_id(훅이
//   ~/.lively/machine-id 에 UUID 로 1회 생성)를 키로 각 머신 관측을 따로 보관 → 새 머신이 남의 관측을 안 덮는다.
export interface HarnessSnapshotAsset { id: string; kind: string; managed: boolean }
export type LocalSessionMode = "normal" | "readonly" | "incognito";
export interface HarnessSnapshot { at?: string; host?: string; harness?: string; default_mode?: LocalSessionMode; assets: HarnessSnapshotAsset[] }
export type HarnessSnapshots = Record<string, HarnessSnapshot>; // machine_id → 관측

export async function getHarnessSnapshots(id: string): Promise<HarnessSnapshots> {
  const r = await itemsPool.query(`SELECT harness_snapshot FROM org_member WHERE id=$1`, [id]);
  const v = r.rows[0]?.harness_snapshot as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  // 각 키를 순회하되 **값이 {assets:[...]} 인 것만** 머신으로 취급 — 옛 단일 형태의 top-level 잔재
  //  (at/host/harness 문자열·assets 배열)는 값이 {assets} 아니라 자동으로 걸러진다(merge 로 공존해도 안전).
  const out: HarnessSnapshots = {};
  for (const [mid, snap] of Object.entries(v as Record<string, unknown>)) {
    if (snap && typeof snap === "object" && !Array.isArray(snap) && Array.isArray((snap as HarnessSnapshot).assets)) out[mid] = snap as HarnessSnapshot;
  }
  return out;
}

// 그 machine_id 키만 갱신(다른 머신 관측 보존) — jsonb shallow merge.
export async function setHarnessSnapshot(id: string, machineId: string, snap: HarnessSnapshot): Promise<void> {
  const r = await itemsPool.query(
    `UPDATE org_member SET harness_snapshot = COALESCE(harness_snapshot,'{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb)
       WHERE id=$1 RETURNING id`, [id, machineId, JSON.stringify(snap)]);
  if (!r.rows[0]) throw new Error("구성원 정보를 찾을 수 없습니다");
}

// 한 머신의 관측·토글지시를 통째로 제거(#893) — uninstall 싱크 + 웹 수동 '이 컴퓨터 지우기'.
//  ⚠ uninstall 시 ~/.lively/machine-id 가 지워져 재설치 때 새 UUID 가 생긴다 → 같은 host 가 중복으로 남는다.
//  그걸 정리하는 경로. harness_snapshot·harness_local_pref 양쪽에서 그 머신 키를 뺀다.
export async function removeHarnessMachine(id: string, machineId: string): Promise<void> {
  const r = await itemsPool.query(
    `UPDATE org_member
        SET harness_snapshot      = COALESCE(harness_snapshot,'{}'::jsonb)      - $2::text,
            harness_local_pref    = COALESCE(harness_local_pref,'{}'::jsonb)    - $2::text,
            local_mode_pref       = COALESCE(local_mode_pref,'{}'::jsonb)       - $2::text,
            harness_machine_alias = COALESCE(harness_machine_alias,'{}'::jsonb) - $2::text
      WHERE id=$1 RETURNING id`, [id, machineId]);
  if (!r.rows[0]) throw new Error("구성원 정보를 찾을 수 없습니다");
}

// ── 머신 별명(#893 후속) — 사용자가 각 PC 에 붙이는 이름. 관측(host)과 별개, 세션 report 가 안 덮는다. ──
export type HarnessMachineAlias = Record<string, string>; // machine_id → 별명

export async function getHarnessMachineAlias(id: string): Promise<HarnessMachineAlias> {
  const r = await itemsPool.query(`SELECT harness_machine_alias FROM org_member WHERE id=$1`, [id]);
  const v = r.rows[0]?.harness_machine_alias as unknown;
  return (v && typeof v === "object" && !Array.isArray(v)) ? v as HarnessMachineAlias : {};
}

// 별명 지정(비우면 키 삭제 = 별명 해제).
export async function setHarnessMachineAlias(id: string, machineId: string, alias: string): Promise<void> {
  const trimmed = alias.trim();
  const sql = trimmed
    ? `UPDATE org_member SET harness_machine_alias =
         COALESCE(harness_machine_alias,'{}'::jsonb) || jsonb_build_object($2::text, $3::text)
       WHERE id=$1 RETURNING id`
    : `UPDATE org_member SET harness_machine_alias =
         COALESCE(harness_machine_alias,'{}'::jsonb) - $2::text
       WHERE id=$1 RETURNING id`;
  const r = await itemsPool.query(sql, trimmed ? [id, machineId, trimmed] : [id, machineId]);
  if (!r.rows[0]) throw new Error("구성원 정보를 찾을 수 없습니다");
}

// ── 로컬 파일 토글 지시(#891 슬라이스 2) — 머신별. 세션훅이 자기 machine_id 지시를 pull 해 .disabled rename ──
//  라이블리 스킬 opt-out(me_asset_pref)과 다르다: 그건 멤버 단위(모든 머신 배포분), 이건 그 머신의 로컬 파일만.
export type HarnessLocalPref = Record<string, Record<string, boolean>>; // machine_id → { "<kind>:<id>": disabled }

export async function getHarnessLocalPref(id: string): Promise<HarnessLocalPref> {
  const r = await itemsPool.query(`SELECT harness_local_pref FROM org_member WHERE id=$1`, [id]);
  const v = r.rows[0]?.harness_local_pref as unknown;
  return (v && typeof v === "object" && !Array.isArray(v)) ? v as HarnessLocalPref : {};
}

// 한 머신의 한 자산 지시만 갱신(disabled=true) 또는 제거(false=다시 켜기 → 키 삭제).
export async function setHarnessLocalPref(id: string, machineId: string, assetKey: string, disabled: boolean): Promise<void> {
  const sql = disabled
    ? `UPDATE org_member SET harness_local_pref =
         jsonb_set(COALESCE(harness_local_pref,'{}'::jsonb), ARRAY[$2::text],
           COALESCE(harness_local_pref->$2::text,'{}'::jsonb) || jsonb_build_object($3::text, true), true)
       WHERE id=$1 RETURNING id`
    : `UPDATE org_member SET harness_local_pref =
         jsonb_set(COALESCE(harness_local_pref,'{}'::jsonb), ARRAY[$2::text],
           COALESCE(harness_local_pref->$2::text,'{}'::jsonb) - $3::text, true)
       WHERE id=$1 RETURNING id`;
  const r = await itemsPool.query(sql, [id, machineId, assetKey]);
  if (!r.rows[0]) throw new Error("구성원 정보를 찾을 수 없습니다");
}

// ── 로컬 세션 기본 연결 상태(#1869) — 머신별. 웹이 저장하고 `lively run` preflight 가 pull ──
//  세션훅으로 당기지 않는다: incognito 는 LIVELY_OFF 로 그 훅 자체가 멈추므로, 그 길에 두면 웹에서 다시 켤 수 없다.
export interface LocalModePreference { mode: LocalSessionMode; updated_at: string }
export type LocalModePreferences = Record<string, LocalModePreference>;

export async function getLocalModePreferences(id: string): Promise<LocalModePreferences> {
  const r = await itemsPool.query(`SELECT local_mode_pref FROM org_member WHERE id=$1`, [id]);
  const v = r.rows[0]?.local_mode_pref as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: LocalModePreferences = {};
  for (const [machineId, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    if (row.mode !== "normal" && row.mode !== "readonly" && row.mode !== "incognito") continue;
    out[machineId] = { mode: row.mode, updated_at: typeof row.updated_at === "string" ? row.updated_at : "" };
  }
  return out;
}

export async function setLocalModePreference(id: string, machineId: string, mode: LocalSessionMode): Promise<LocalModePreference> {
  const pref = { mode, updated_at: new Date().toISOString() };
  const r = await itemsPool.query(
    `UPDATE org_member SET local_mode_pref =
       COALESCE(local_mode_pref,'{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb)
     WHERE id=$1 RETURNING id`, [id, machineId, JSON.stringify(pref)]);
  if (!r.rows[0]) throw new Error("구성원 정보를 찾을 수 없습니다");
  return pref;
}

// 주어진 id 중 **실재하는 활성 구성원**만 골라낸다(#1313 R45) — 공개범위 대상(audience) 검증 공용.
//  오타 id 로 잠그면 아무도 못 여는 리스트/폴더가 되므로, 잠그기 전에 대상이 실재하는지 이걸로 확인한다.
export async function activeMemberIdsAmong(ids: string[]): Promise<string[]> {
  const r = await itemsPool.query<{ id: string }>(
    `SELECT id FROM org_member WHERE id = ANY($1::text[]) AND state='active'`, [ids]);
  return r.rows.map((row) => String(row.id));
}

// 이메일로 멤버 id 조회(대소문자 무시) — 이메일=로그인 키라 유일성 검증용. 없으면 null.
export async function memberIdByEmail(email: string): Promise<string | null> {
  const r = await itemsPool.query(
    `SELECT id FROM org_member WHERE email IS NOT NULL AND email <> '' AND lower(email)=lower($1) LIMIT 1`, [email]);
  return r.rows[0] ? (r.rows[0] as { id: string }).id : null;
}

export interface MemberInput {
  id: string;
  kind?: "human" | "agent" | "system";
  display_name?: string | null;
  nickname?: string | null; // undefined=보존, null/''=닉네임 지움(→display_name 폴백).
  use_nickname?: boolean;   // undefined=보존. 「이 닉네임을 내 이름으로 사용」(#1813).
  email?: string | null;
  identities?: MemberIdentity[];
  body_md?: string;
  avatar?: string | null; // 프로필 이미지 data URL. undefined=보존, null/''=이니셜로 되돌림.
  avatar_char?: string | null; // 커스텀 글자. undefined=보존, null/''=이니셜 자동으로 되돌림.
  avatar_color?: string | null; // 커스텀 배경색(#rrggbb). undefined=보존, null/''=해시색 자동으로 되돌림.
  state?: "active" | "inactive";
  scopes?: string[];
  sort?: number;
}

export async function upsertMember(m: MemberInput, actor?: string, source?: string): Promise<OrgMember> {
  const before = await getMember(m.id);
  const kind = m.kind ?? before?.kind ?? "human";
  const identities = m.identities ?? before?.identities ?? [];
  const scopes = m.scopes ?? before?.scopes ?? ["items", "context", "memory"];
  // avatar: undefined=보존, 그 외(null/''/문자열)=그대로 적용(빈값이면 null 로 정규화 → 이니셜 폴백).
  const avatar = m.avatar === undefined ? (before?.avatar ?? null) : (m.avatar || null);
  // 커스텀 글자(최대 3자)·배경색 — undefined=보존, 그 외=정규화. 색은 클라이언트 style 에 주입되므로 #rrggbb 형식만 허용(그 외 무시=null).
  const avatarChar = m.avatar_char === undefined ? (before?.avatar_char ?? null) : ((m.avatar_char || "").trim().slice(0, 3) || null);
  const avatarColor = m.avatar_color === undefined ? (before?.avatar_color ?? null)
    : (/^#[0-9a-fA-F]{6}$/.test((m.avatar_color || "").trim()) ? (m.avatar_color as string).trim() : null);
  // nickname — undefined=보존, 그 외=trim 후 빈값이면 null(→ display_name 폴백).
  const nickname = m.nickname === undefined ? (before?.nickname ?? null) : ((m.nickname || "").trim() || null);
  // use_nickname — undefined=보존. 닉네임이 비면 **끈다**: 켜 둔 채 닉네임만 지우면 이름이 사라진 것처럼 보인다(#1813).
  const useNick = nickname ? (m.use_nickname === undefined ? (before?.use_nickname ?? false) : !!m.use_nickname) : false;
  await itemsPool.query(
    `INSERT INTO org_member(id, kind, display_name, nickname, use_nickname, email, identities, body_md, avatar, avatar_char, avatar_color, state, scopes, sort, version, updated_at, updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13::jsonb,$14,1,now(),$15)
     ON CONFLICT (tenant_id, id) DO UPDATE SET
       kind=EXCLUDED.kind, display_name=EXCLUDED.display_name, nickname=EXCLUDED.nickname, use_nickname=EXCLUDED.use_nickname, email=EXCLUDED.email,
       identities=EXCLUDED.identities, body_md=EXCLUDED.body_md, avatar=EXCLUDED.avatar,
       avatar_char=EXCLUDED.avatar_char, avatar_color=EXCLUDED.avatar_color, state=EXCLUDED.state, scopes=EXCLUDED.scopes, sort=EXCLUDED.sort,
       version=org_member.version + 1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [m.id, kind, m.display_name ?? before?.display_name ?? null, nickname, useNick, m.email ?? before?.email ?? null,
     JSON.stringify(identities), m.body_md ?? before?.body_md ?? "", avatar, avatarChar, avatarColor,
     m.state ?? before?.state ?? "active", JSON.stringify(scopes), m.sort ?? before?.sort ?? 0, actor ?? null],
  );
  const after = await getMember(m.id);
  await audit("org_member", m.id, before ? "update" : "insert", before, after, actor, source);
  // person/person_identity 동기화 — UI 편집이 즉시 게이트웨이 신원 매칭에 반영(load-bindings 와 동일 계약).
  if (after) await syncMemberToPerson(after);
  // (권한 토큰 전파 폐기 — P1) 유효 권한은 verifyDbToken 이 매 인증 시 intersection(토큰,멤버)로 계산한다.
  //  멤버 권한 하향은 즉시 모든 토큰에 반영(보안), 상향은 토큰 재발급으로(최소권한 보존) — 전파 함수 불필요.
  //  단, 앱 동의·앱 세션은 토큰 축이 아니라 별도 회수가 필요하다(위 훅).
  if (after && isMemberDeactivation(before?.state, after.state)) await fireMemberDeactivated(m.id, "inactive", actor ?? null);
  return after as OrgMember;
}

export async function removeMember(id: string, actor?: string, source?: string): Promise<void> {
  const before = await getMember(id);
  if (!before) return;
  await itemsPool.query(`DELETE FROM org_member WHERE id=$1`, [id]);
  await audit("org_member", id, "delete", before, null, actor, source);
  if (isMemberDeactivation(before.state, null)) await fireMemberDeactivated(id, "removed", actor ?? null);
  // person 행은 보존(아이템 actor 참조 무결성) — 멤버 제거는 org_member 에서만. 신원 정리는 별도 큐레이션.
}

// 신원 '해제' 동기(#541) — identities 에서 뺀 행은 person_identity 에서도 지워야 커넥터 액터/어사이니
//  해소(person_identity JOIN org_member)에 실제 반영된다(syncMemberToPerson 은 upsert-only 라 잔존).
//  가드: 이 멤버 소유(person_id=id) + origin IN (manual, email-join) — 수동 매핑과 그로부터 파생된 이메일
//  자동조인 행까지 함께 제거(email-join 잔존 시 해제가 무효 — 다음 싱크가 재매핑). observed 신원은 보존.
//  before/after = 저장 전/후의 identities. 실제로 지워진 행만 person_identity_audit 에 남긴다.
export async function unbindMemberIdentities(
  id: string, before: MemberIdentity[], after: MemberIdentity[], actor: string | null,
): Promise<void> {
  const keep = new Set(after.map((i) => `${i.system}\u0000${i.external_id}`));
  for (const prev of before) {
    if (keep.has(`${prev.system}\u0000${prev.external_id}`)) continue;
    const del = await itemsPool.query(
      `DELETE FROM person_identity WHERE system=$1 AND external_id=$2 AND person_id=$3 AND origin IN ('manual','email-join')`,
      [prev.system, prev.external_id, id]);
    if ((del.rowCount ?? 0) > 0) {
      await itemsPool.query(
        `INSERT INTO person_identity_audit(action, person_id, system, external_id, detail, source)
         VALUES('identity-unbound',$1,$2,$3,$4::jsonb,'web')`,
        [id, prev.system, prev.external_id, JSON.stringify({ email: prev.email ?? null, actor })]);
    }
  }
}

// person/person_identity 동기화 — load-bindings.ts loadBindings() 의 upsert 계약을 그대로 미러.
async function syncMemberToPerson(m: OrgMember): Promise<void> {
  const dn = m.display_name ?? m.id;
  await itemsPool.query(
    `INSERT INTO person(id, display_name, kind) VALUES($1,$2,$3)
       ON CONFLICT (tenant_id, id) DO UPDATE SET display_name=EXCLUDED.display_name, kind=EXCLUDED.kind`,
    [m.id, dn, m.kind],
  );
  for (const idn of m.identities) {
    if (!idn.system || !idn.external_id) continue;
    await itemsPool.query(
      `INSERT INTO person_identity(person_id, system, instance, external_id, email, display_name, origin, state)
         VALUES($1,$2,$3,$4,$5,$6,'manual','confirmed')
       ON CONFLICT (tenant_id, system, external_id) DO UPDATE SET
         person_id=EXCLUDED.person_id,
         instance=COALESCE(EXCLUDED.instance, person_identity.instance),
         email=COALESCE(EXCLUDED.email, person_identity.email),
         display_name=COALESCE(EXCLUDED.display_name, person_identity.display_name),
         origin='manual', state='confirmed', updated_at=now()`,
      [m.id, idn.system, idn.instance ?? null, idn.external_id, idn.email ?? null, idn.display_name ?? null],
    );
  }
}
