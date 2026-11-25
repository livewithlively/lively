// 세션 요청(#5713) — **세션의 AI 가 사람에게 화면으로 받는 것**(값 입력 · 고르기 · 파일 올리기 …)의 공통 표면.
//
// ── 무엇이 바뀌었나 ──────────────────────────────────────────────────────────
//  종전엔 이 요청이 리브 전용이었다(me_liv_ask_* — 리브 프로필에 «사람당 한 칸», 화면은 리브 세션 · 리브 화면에서만 그렸다).
//  리브 밖의 세션(연결 스킬 · 보통 세션 · 로컬 터미널의 AI)은 걸어도 사람이 볼 자리가 없어 대화가 섰다(#4970 조사).
//  이제 어느 세션이든 건다:
//   · 저장 — 요청마다 한 행(org_session_ask). 세션이 여럿이어도, 한 세션이 여러 개를 걸어도 서로 덮지 않는다.
//   · 자리 — 그 세션 화면 곁칸의 «요청» 칸(web/v2/session-ask-pane.ts). 요청이 생기면 서고 없으면 걷힌다.
//   · 주소 — `<게이트웨이>/ui/#/ask/<id>`. 로컬 터미널의 AI 가 사람에게 주는 링크 — 누르면 그 요청으로 바로 간다(web/v2/ask-page.ts).
//   · 종류 — 등록부(src/asks/kinds.ts). 종류마다 거는 도구 하나가 저절로 생긴다 — 아래 kindCapabilities.
//
// ── 표면 ─────────────────────────────────────────────────────────────────────
//  AI(MCP):   session_ask_<종류>(걸기 · cancel) · session_ask_status(어떻게 됐나 · 내리기)
//  화면(REST): session_ask_list · session_ask_get · session_ask_submit · session_ask_dismiss · session_ask_tell
//  옛 이름(호환): me_liv_ask_secret · me_liv_ask_choice · me_liv_ask_upload — 같은 핸들러다(kinds.ts aliases 주석).
//
// ── 경계 ─────────────────────────────────────────────────────────────────────
//  · 요청은 **건 사람 것**이다 — 조회 · 답하기 · 접기 전부 토큰의 사람 본인 것만(저장소가 member_id 를 조건에 건다).
//    같이 보는 세션이어도 남의 요청은 안 보인다(값이 요청한 사람의 금고로 가므로).
//  · 세션 id 는 접속 헤더(x-lively-session)의 자기주장이다 — 요청이 어느 세션 곁칸에 설지만 정한다. 그 세션에 **말을 넣는 것**(tell)은
//    넣기 통로(deliverPromptForMember)가 접근 판정을 다시 한다.
//  · 시크릿 값은 종류의 submit 안에서 금고로 가고, 응답 · result · say · 알림 어디에도 실리지 않는다.
import { z } from "zod";
import type { Capability, CapabilityCtx } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import { askKind, type AskKind, type AskWho } from "../asks/kinds.js";
import { registerBuiltinAskKinds, askKinds } from "../asks/kinds/index.js";
import {
  cancelOpenAsks, createAsk, getAsk, listOpenAsks, listRecentAsks, resolveAsk, claimAskTold, releaseAskTold, type AskRow,
} from "../asks/store.js";
import { publishAsk } from "../asks/notify.js";

registerBuiltinAskKinds();

/** 요청 하나의 바깥 모양 — AI(MCP)와 화면(REST)이 같은 것을 본다. payload 에 값은 없다(종류 계약). */
export interface AskView {
  id: string;
  kind: string;
  /** 종류의 사람 이름(화면이 그 종류를 모를 때의 폴백 카드가 쓴다). */
  kind_label: string;
  title: string;
  session_id: string | null;
  status: AskRow["status"];
  created_at: string;
  resolved_at: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
}

export function askView(r: AskRow): AskView {
  const k = askKind(r.kind);
  let title = "";
  try { title = k ? k.title(r.payload) : ""; } catch { /* 깨진 payload — 종류 이름으로 */ }
  return {
    id: r.id, kind: r.kind, kind_label: k?.label ?? r.kind, title: title || k?.label || r.kind,
    session_id: r.session_id, status: r.status, created_at: r.created_at, resolved_at: r.resolved_at,
    payload: r.payload, result: r.result,
  };
}

/** 요청 주소의 해시 — 화면(web/v2/ask-page.ts)과 한 벌. */
export const askHash = (id: string): string => `#/ask/${encodeURIComponent(id)}`;

/**
 * 요청 화면의 절대 주소 — 로컬 터미널의 AI 가 사람에게 «이 링크에서 넣어 주세요» 로 주는 링크. 사람에게 주는 링크라 절대 주소다
 *  (상대 주소는 사람이 못 누른다). 게이트웨이 주소를 모르면 null — 그때 AI 는 «라이블리 화면의 그 세션 오른쪽 요청 칸» 으로 안내한다.
 */
async function askUrl(id: string): Promise<string | null> {
  const { gatewayUrl } = await import("../gateway-url.js");
  const base = await gatewayUrl().catch(() => null);
  return base ? `${String(base).replace(/\/+$/, "")}/ui/${askHash(id)}` : null;
}

function whoOf(user: LivelyUser, ctx?: CapabilityCtx): AskWho {
  const userId = user?.userId;
  if (!userId) throw new HttpError(401, "인증이 필요합니다");
  const session = String(ctx?.session ?? "").trim().slice(0, 128) || null;
  return { userId, user, session };
}

const idOf = (v: unknown): string => {
  const id = String(v ?? "").trim();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) throw new HttpError(400, "요청 id 형식이 아닙니다");
  return id;
};

/** 다른 길로 이미 끝난 요청이면 닫고 true(종류의 stillOpen). 판정이 실패하면 띄워 둔다(false). */
async function closedElsewhere(r: AskRow, who: AskWho): Promise<boolean> {
  if (r.status !== "open") return false;
  const k = askKind(r.kind);
  if (!k?.stillOpen) return false;
  let open = true;
  try { open = await k.stillOpen(r, who); } catch { return false; }
  if (open) return false;
  const closed = await resolveAsk(who.userId, r.id, "done", { elsewhere: true }).catch(() => null);
  if (closed) publishAsk(who.userId, { kind: "done", id: r.id, session: r.session_id, ask_kind: r.kind });
  return true;
}

/** AI 에게 다음에 할 일 — 도구 응답에 싣는다(설명서를 다시 찾지 않게 한 문단으로). */
function nextStep(url: string | null, session: string | null): string {
  const where = session
    ? "사람이 라이블리 웹(앱)에서 이 세션 화면을 보고 있으면 오른쪽 «요청» 칸에 이미 떴습니다."
    : "이 요청은 어느 세션에서 건 것인지 알 수 없어 링크 화면에서만 보입니다.";
  const link = url
    ? ` 로컬 터미널처럼 그 화면이 안 보이는 자리면 이 링크를 사람에게 주세요(누르면 그 요청으로 바로 갑니다): ${url}`
    : " 사람에게 «라이블리 화면에서 이 세션의 오른쪽 요청 칸» 을 안내하세요.";
  return `${where}${link} 답이 오면 이 세션에 한 마디가 들어옵니다 — 이 턴은 여기서 끝내고 기다리세요. 한 마디가 안 들어오는 자리(로컬 터미널)면 사람이 끝냈다고 할 때 session_ask_status 로 확인합니다.`;
}

// ── 걸기 — 종류마다 도구 하나(등록부에서 만든다) ─────────────────────────────────────────
function openHandler(kind: AskKind): Capability["handler"] {
  return async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
    const who = whoOf(user, ctx);
    // 취소 — 더는 필요 없어졌으면 칸을 내린다(사람 화면에 죽은 입력칸을 남기지 않는다).
    if (input?.cancel === true) {
      const ids = await cancelOpenAsks(who.userId, who.session, kind.kind);
      for (const id of ids) publishAsk(who.userId, { kind: "canceled", id, session: who.session, ask_kind: kind.kind });
      return { ask: null, canceled: ids };
    }
    // ⚠ 검증(open)이 저장보다 먼저다 — 거절되면 아무것도 남지 않는다.
    const { payload, slot } = await kind.open(input ?? {}, who);
    const { ask, replaced } = await createAsk({ member: who.userId, session: who.session, kind: kind.kind, slot, payload });
    for (const id of replaced) publishAsk(who.userId, { kind: "canceled", id, session: who.session, ask_kind: kind.kind });
    publishAsk(who.userId, { kind: "open", id: ask.id, session: ask.session_id, ask_kind: ask.kind });
    const url = await askUrl(ask.id);
    //  board_url — 옛 이름(리브 화면 링크 `#/liv?board=1`)을 부르는 문서가 남아 있다. 같은 값(이 요청의 링크)을 싣는다.
    return { ask: askView(ask), url, board_url: url, next: nextStep(url, ask.session_id) };
    // ⚠ **MCP 로 노출한다**. AI 가 쓰라고 만든 도구인데 도구 목록에 없으면 못 쓴다 — 실측(#1631): 리브가 ToolSearch 를 세 번 돌리고
    //  REST 경로를 세 번 추측하느라 96초를 태웠고, 그 사이 사람에게는 "칸이 떴을 거예요"라고 먼저 말해 버렸다(아직 안 떴는데).
  };
}

function kindCapabilities(kind: AskKind): Capability[] {
  const handler = openHandler(kind);
  const cap = (name: string, title: string, description: string, path: string): Capability => ({
    name, title, description, scope: null, input: kind.tool.input,
    expose: { mcp: true, rest: [{ method: "POST", paths: [path], parse: (req) => (req.body ?? {}) as Record<string, unknown> }] },
    handler,
  });
  return [
    cap(kind.tool.name, kind.tool.title, kind.tool.description, `/api/ui/me/asks/open/${kind.kind}`),
    ...(kind.aliases ?? []).map((a) => cap(a.name, a.title,
      `(옛 이름) ${kind.tool.name} 과 같은 도구다 — 리브 세션만이 아니라 어느 세션에서든 쓴다. 새로 쓸 때는 ${kind.tool.name} 을 부른다. ` +
      "요청은 그 세션 화면 오른쪽 «요청» 칸에 뜨고, 응답의 url(= board_url)은 그 요청으로 바로 가는 링크다.", a.restPath)),
  ];
}

// ── 어떻게 됐나(AI) ──────────────────────────────────────────────────────────────────
const statusInput = {
  id: z.string().max(64).optional().describe("요청 id(걸 때 응답의 ask.id). 생략하면 이 세션에서 건 최근 요청들을 돌려준다."),
  cancel: z.boolean().optional().describe("true 면 그 요청(id)을 내린다 — 더는 필요 없어졌을 때. id 가 없으면 이 세션의 열린 요청을 모두 내린다."),
};
type StatusInput = z.infer<z.ZodObject<typeof statusInput>>;

const sessionAskStatus: Capability = {
  name: "session_ask_status",
  title: "건 요청이 어떻게 됐나",
  description:
    "session_ask_* 로 사람에게 건 요청의 상태를 본다 — open(아직 안 했다) · done(했다 — result 에 무엇을 골랐나 · 저장됐나 · 무엇을 올렸나) · " +
    "dismissed(사람이 지금은 안 하겠다고 접었다 — 곧바로 다시 묻지 마라) · canceled(내렸다). 시크릿 값은 어디에도 없다. " +
    "보통은 부를 일이 없다 — 답이 오면 이 세션에 한 마디가 들어온다. 그 한 마디가 안 들어오는 자리(로컬 터미널의 AI)에서 사람이 «넣었어» 라고 하면 이걸로 확인한다. " +
    "id 를 생략하면 이 세션에서 건 최근 요청들이다. cancel:true 로 요청을 내린다.",
  scope: null,
  input: statusInput,
  //  GET 이라 읽기로 파생된다 — 내리기(cancel)만 쓰기라 핸들러가 읽기전용 세션을 막는다.
  mutates: false,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/me/asks/status"],
      parse: (req) => ({ ...(req.query?.id ? { id: String(req.query.id) } : {}) }) }],
  },
  handler: async (input: StatusInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    const who = whoOf(user, ctx);
    if (input.cancel === true) {
      if (ctx?.readOnly) throw new HttpError(403, "읽기 전용 세션에서는 요청을 내릴 수 없습니다");
      if (input.id) {
        const closed = await resolveAsk(who.userId, idOf(input.id), "canceled", null);
        if (closed) publishAsk(who.userId, { kind: "canceled", id: closed.id, session: closed.session_id, ask_kind: closed.kind });
        const now = closed ?? await getAsk(who.userId, idOf(input.id));
        if (!now) throw new HttpError(404, "그 요청을 찾을 수 없습니다");
        return { ask: askView(now) };
      }
      const ids = await cancelOpenAsks(who.userId, who.session);
      for (const id of ids) publishAsk(who.userId, { kind: "canceled", id, session: who.session, ask_kind: "" });
      return { canceled: ids };
    }
    if (input.id) {
      const r = await getAsk(who.userId, idOf(input.id));
      if (!r) throw new HttpError(404, "그 요청을 찾을 수 없습니다");
      const now = (await closedElsewhere(r, who)) ? (await getAsk(who.userId, r.id)) ?? r : r;
      return { ask: askView(now), url: now.status === "open" ? await askUrl(now.id) : null };
    }
    const rows = await listRecentAsks(who.userId, who.session, 10);
    const out: AskView[] = [];
    for (const r of rows) out.push(askView((await closedElsewhere(r, who)) ? (await getAsk(who.userId, r.id)) ?? r : r));
    return { asks: out, session_id: who.session };
  },
};

// ── 화면(REST 전용) ──────────────────────────────────────────────────────────────────
const sessionAskList: Capability = {
  name: "session_ask_list",
  title: "내 열린 요청",
  description:
    "AI 가 나에게 걸어 둔 **열린** 요청들(건 순서) — 세션 화면 곁칸의 «요청» 칸이 session 으로 그 세션 것만, 요청 화면(#/ask)이 전부를 읽는다. " +
    "다른 길로 이미 끝난 요청(자격을 관리 화면에서 직접 넣었다 등)은 여기서 닫히고 빠진다. (화면이 쓰는 자리다.)",
  scope: null,
  input: { session: z.string().max(128).optional().describe("이 세션에서 건 것만(세션 id). 생략하면 내 열린 요청 전부.") },
  //  읽으면서 끝난 요청을 닫지만(closedElsewhere) 사람이 시킨 쓰기가 아니다 — 읽기전용 세션의 화면도 목록은 본다.
  mutates: false,
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/me/asks"],
      parse: (req) => ({ ...(req.query?.session ? { session: String(req.query.session).slice(0, 128) } : {}) }) }],
  },
  handler: async (input: { session?: string }, user: LivelyUser, ctx?: CapabilityCtx) => {
    const who = whoOf(user, ctx);
    const rows = await listOpenAsks(who.userId, input.session ? input.session : undefined);
    const asks: AskView[] = [];
    for (const r of rows) if (!(await closedElsewhere(r, who))) asks.push(askView(r));
    return { asks };
  },
};

const sessionAskGet: Capability = {
  name: "session_ask_get",
  title: "요청 하나",
  description: "요청 하나(상태 무관) — 요청 주소 화면(#/ask/<id>)이 읽는다. 내가 받은 요청만 보인다. (화면이 쓰는 자리다.)",
  scope: null,
  input: { id: z.string().max(64).describe("요청 id") },
  mutates: false,
  expose: { mcp: false, rest: [{ method: "GET", paths: ["/api/ui/me/asks/item/:id"], parse: (req) => ({ id: String(req.params?.id ?? "") }) }] },
  handler: async (input: { id: string }, user: LivelyUser, ctx?: CapabilityCtx) => {
    const who = whoOf(user, ctx);
    const r = await getAsk(who.userId, idOf(input.id));
    if (!r) throw new HttpError(404, "그 요청을 찾을 수 없습니다 — 이미 지워졌거나, 다른 사람에게 온 요청입니다");
    const now = (await closedElsewhere(r, who)) ? (await getAsk(who.userId, r.id)) ?? r : r;
    return { ask: askView(now) };
  },
};

const sessionAskSubmit: Capability = {
  name: "session_ask_submit",
  title: "요청에 답하기(화면 전용)",
  description:
    "화면의 요청 카드가 사람의 답(입력한 값 · 고른 것 · 올린 파일)을 보낸다. **넣을 자리는 서버에 저장된 요청에서만 온다** — 화면이 보낸 대상은 읽지 않는다. " +
    "시크릿 값은 곧바로 금고로 가고 응답 · 로그 · 대화에 남지 않는다. 응답의 say 는 요청을 건 세션에 넣을 한 마디다. (사람이 쓰는 자리다. AI 가 부를 일이 없다.)",
  scope: null,
  //  몸통은 종류가 읽는다(값 · choices · other · files …) — 종류가 늘어도 이 선언은 그대로라 넓게 받는다(passthrough 는 평평한 shape 로 못 쓴다).
  input: {
    id: z.string().max(64).describe("요청 id"),
    value: z.string().optional().describe("(값 입력) 사람이 입력한 값. 서버가 즉시 암호화해 저장하고 버린다."),
    choices: z.array(z.string()).optional().describe("(고르기) 고른 선택지 id 들."),
    other: z.string().optional().describe("(고르기) '그 외'로 직접 적은 것."),
    files: z.array(z.object({ name: z.string(), source_id: z.number().optional() })).optional().describe("(파일 올리기) 올린 파일 이름과 자료 id."),
    failed: z.number().optional().describe("(파일 올리기) 올리다 실패한 파일 수."),
    skipped: z.number().optional().describe("(파일 올리기) 받지 않는 형식이라 건너뛴 파일 수."),
    data: z.record(z.unknown()).optional().describe("그 밖의 종류가 받는 답(종류마다 다르다)."),
  },
  expose: { mcp: false, rest: [{ method: "POST", paths: ["/api/ui/me/asks/item/:id/submit"],
    parse: (req) => ({ ...((req.body ?? {}) as Record<string, unknown>), id: String(req.params?.id ?? "") }) }] },
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
    const who = whoOf(user, ctx);
    const r = await getAsk(who.userId, idOf(input.id));
    if (!r) throw new HttpError(404, "그 요청을 찾을 수 없습니다");
    if (r.status !== "open") throw new HttpError(409, "이미 끝난 요청입니다");
    const k = askKind(r.kind);
    if (!k) throw new HttpError(400, `이 서버가 모르는 요청 종류입니다: ${r.kind}`);
    //  종류가 던지면 요청은 열린 채 남는다 — 사람이 고쳐서 다시 보낼 수 있다.
    const out = await k.submit(r, input, { ...who, session: r.session_id });
    //  say 를 결과에 같이 둔다 — «세션에 넣기»(tell)는 화면이 보낸 글이 아니라 **여기 저장된 글**만 넣는다.
    const closed = await resolveAsk(who.userId, r.id, "done", { ...out.result, ...(out.say ? { say: out.say } : {}) });
    if (closed) publishAsk(who.userId, { kind: "done", id: r.id, session: r.session_id, ask_kind: r.kind });
    const now = closed ?? (await getAsk(who.userId, r.id)) ?? r;
    return { ok: true, ask: askView(now), say: out.say ?? null };
  },
};

const sessionAskDismiss: Capability = {
  name: "session_ask_dismiss",
  title: "요청 접어두기(화면 전용)",
  description:
    "AI 가 걸어 둔 요청을 **사람이 지금은 안 하겠다**고 접는다. 상태가 dismissed 로 남아 AI 가 session_ask_status 로 «접었다» 를 안다 — " +
    "같은 것을 곧바로 다시 묻지 않게. (사람이 쓰는 자리다.)",
  scope: null,
  input: { id: z.string().max(64).describe("요청 id") },
  expose: { mcp: false, rest: [{ method: "POST", paths: ["/api/ui/me/asks/item/:id/dismiss"], parse: (req) => ({ id: String(req.params?.id ?? "") }) }] },
  handler: async (input: { id: string }, user: LivelyUser, ctx?: CapabilityCtx) => {
    const who = whoOf(user, ctx);
    const id = idOf(input.id);
    const closed = await resolveAsk(who.userId, id, "dismissed", { dismissed: true });
    if (closed) publishAsk(who.userId, { kind: "dismissed", id, session: closed.session_id, ask_kind: closed.kind });
    const now = closed ?? await getAsk(who.userId, id);
    if (!now) throw new HttpError(404, "그 요청을 찾을 수 없습니다");
    return { ask: askView(now), dismissed: !!closed };
  },
};

const sessionAskTell: Capability = {
  name: "session_ask_tell",
  title: "답했다고 세션에 알리기(화면 전용)",
  description:
    "끝난 요청의 한 마디(무엇을 골랐나 · 저장했다)를 요청을 건 세션에 사람 대신 넣는다 — 사람이 다시 타이핑하지 않아도 AI 가 이어 가게. " +
    "넣는 글은 서버에 저장된 그 요청의 것뿐이다(화면이 글을 보내지 않는다). 한 요청에 한 번만 넣는다. " +
    "못 넣는 자리(로컬 터미널의 AI · 멈춘 세션)면 delivered:false — 그때 화면은 사람에게 «AI 에게 끝났다고 말해 주세요» 를 안내한다. (화면이 쓰는 자리다.)",
  scope: null,
  input: {
    id: z.string().max(64).describe("요청 id"),
    told: z.boolean().optional().describe("true 면 넣지 않고 «이미 전했다» 만 적는다 — 화면이 그 세션 대화창으로 직접 보냈을 때(두 번 넣지 않게)."),
  },
  expose: { mcp: false, rest: [{ method: "POST", paths: ["/api/ui/me/asks/item/:id/tell"],
    parse: (req) => ({ id: String(req.params?.id ?? ""), ...((req.body as { told?: unknown } | undefined)?.told === true ? { told: true } : {}) }) }] },
  handler: async (input: { id: string; told?: boolean }, user: LivelyUser, ctx?: CapabilityCtx) => {
    const who = whoOf(user, ctx);
    const r = await getAsk(who.userId, idOf(input.id));
    if (!r) throw new HttpError(404, "그 요청을 찾을 수 없습니다");
    const say = r.status === "done" ? String((r.result as { say?: unknown } | null)?.say ?? "").trim() : "";
    if (!say) return { delivered: false, reason: "nothing-to-say" };
    //  먼저 «전했다» 를 잡는다 — 두 탭이 동시에 불러도 한 번만 넣는다. 못 넣으면 놓아 다음 시도가 다시 넣을 수 있게 한다.
    if (!(await claimAskTold(who.userId, r.id))) return { delivered: true, already: true };
    if (input.told === true) return { delivered: true };
    if (!r.session_id) { await releaseAskTold(who.userId, r.id); return { delivered: false, reason: "no-session", say }; }
    try {
      const { deliverPromptForMember } = await import("../terminal/deliver-prompt.js");
      await deliverPromptForMember(r.session_id, who.userId, say);
      return { delivered: true };
    } catch (err) {
      await releaseAskTold(who.userId, r.id).catch(() => { /* 다음 시도가 «이미 전했다» 로 읽힐 뿐이다 */ });
      logger.info({ err: (err as Error)?.message, member: who.userId, session: r.session_id, ask: r.id }, "세션 요청의 한 마디를 세션에 넣지 못함 — 화면이 사람에게 안내한다");
      return { delivered: false, reason: "undeliverable", say };
    }
  },
};

export const sessionAskCapabilities: Capability[] = [
  ...askKinds().flatMap(kindCapabilities),
  sessionAskStatus,
  sessionAskList,
  sessionAskGet,
  sessionAskSubmit,
  sessionAskDismiss,
  sessionAskTell,
];
