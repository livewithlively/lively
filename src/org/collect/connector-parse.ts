// claude.ai 커넥터 결과(원문 캡처) → 자료 항목 · 단위 목록 (#4213 T11 저장 단계) — **순수**(DB·네트워크 없음).
//
//  왜 서버가 푸나: 수집 실행의 모델은 도구를 부르기만 한다. 자료는 훅(cap.cjs)이 남긴 원문에서 서버가 만든다 —
//   · 좌표가 기존 수집기와 **똑같아야** 같은 글이 한 행으로 합쳐진다(슬랙 `채널:ts` — connectors/slack.ts · 지메일 메시지 id —
//     connectors/gmail.ts · 노션 페이지 id(하이픈 UUID) — connectors/notion/emit.ts). 모델이 옮겨 적은 id 는 틀릴 수 있다.
//   · 본문은 원문 그대로 둔다(모델이 고쳐 쓴 문장은 자료가 아니다).
//   · 목록(«무엇이 있나»)도 그 사람 커넥터가 실제로 돌려준 목록 도구 결과에서만 나온다 — 그래야 «볼 수 있는 구성원» 의 근거가 된다.
//
//  형식 근거(맥 실측 2026-10-16, Claude Code 2.1.301 · claude.ai 커넥터):
//   · 슬랙 — 결과는 [{type:"text", text:"<JSON 문자열>"}]. 안쪽 JSON 의 result/messages 가 사람 읽는 글이다.
//     채널 목록: `### #이름` · `- **ID:** C…` · `- **Type:** Public Channel` · 끝에 `Use cursor: "…"`.
//     채널 읽기: `Channel: #이름 (C…)` · `=== Message from 이름 <메일> (U…) at 2026-08-20 11:45:38 KST ===` · `Message TS: 1787193938.792269`
//     · 본문 · 꼬리 `Thread: N replies (latest: …)` / `Reactions: …` / `Files: …`. 다음 쪽은 pagination_info 의 «use cursor: `…`».
//     스레드 읽기: `=== THREAD PARENT MESSAGE ===` · `--- Reply i of N ---` · `From: 이름 <메일> (U…)` · `Time: …` · `Message TS: …`.
//     검색(#4744, 2026-10-19): 결과는 {results, pagination_info} — 꼴은 parseSlackSearch 머리말.
//   · 지메일 — 결과는 JSON 문자열. search_threads {resultCountEstimate, threads:[{id, messageCount, messages:[…], viewUrl}], nextPageToken} ·
//     **빈 검색은 {}** (칸이 하나도 없다) · get_thread {id, messageCount, messages, viewUrl} · get_message {id, …}.
//     메시지: id · threadId · subject · sender · date · internalDate · plaintextBody · htmlBody · snippet · labelIds · viewUrl(authuser=메일함).
//     검색어의 after:<epoch 초> 는 분 단위로 내림된다(after:T+1 은 T 의 메일을 주고 after:T+59 는 안 준다) · before: 는 정확하다 —
//     그래서 «after:a before:b» · «after:b before:c» 로 이어 붙인 구간 사이에 빈틈이 없다(맥 실측 2026-10-16).
//   · 노션 — 결과는 [{type:"text", text:"<JSON>"}]. notion-fetch {metadata:{type}, title, url, text(<content>…</content>), page_last_edited_at} ·
//     list-recent/shared/private · search {results:[{type, url, title}]}.
//  형식이 바뀌면 빈 결과가 된다(던지지 않는다). 호출부(collect-plan)는 **제 모양 표시**(wellFormed · end · isGmailSearch …)가 있는
//   결과만 «다 읽었다» 의 증거로 쓴다 — 표시가 없는 결과는 «풀지 못함» 으로 세고 읽은 위치를 옮기지 않는다.
import type { RawItem } from "../../items/store.js";

// ── 캡처 한 건 ───────────────────────────────────────────────────────────────

/** cap/<n>.json 의 모양(훅이 받은 그대로 + 큰 결과면 saved_text · 실패한 호출이면 failed + error). */
export interface CaptureFile { tool_name?: unknown; tool_input?: unknown; tool_response?: unknown; saved_text?: unknown; failed?: unknown; error?: unknown }

export interface Capture {
  /** claude.ai 커넥터 이름(«claude.ai » 뒤 — Slack · Notion · Gmail · Google Drive). 도구 이름에서 읽는다. */
  connector: string | null;
  /** 도구의 짧은 이름(slack_read_channel · get_thread · notion-fetch …). */
  tool: string;
  input: Record<string, unknown>;
  /** 결과 글 — 큰 결과는 saved_text(원문 파일), 아니면 tool_response 를 글 하나로. */
  text: string;
  /** 글이 JSON 이면 그 값. 슬랙·노션처럼 바깥이 [{text}] 이고 안쪽이 JSON 문자열이면 안쪽까지 푼 값. */
  json: unknown;
  /**
   * #4744 실패한 호출(PostToolUseFailure 훅이 남긴 것)이면 그 오류 글(예 «execution_failed: thread_not_found») — 결과 글은 비어 있다.
   *  저장 단계는 실패한 호출을 결과와 섞지 않는다(run-ingest 가 갈라 «없는 스레드» 판정에만 넘긴다).
   */
  error?: string;
}

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const tryJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };

/** tool_response 를 글 하나로 — [{type:"text", text}] 는 text 를 이어 붙이고, 문자열은 그대로, 그 밖은 JSON 으로. */
function responseText(resp: unknown): string {
  if (typeof resp === "string") return resp;
  if (Array.isArray(resp)) {
    const texts = resp.map((c) => (isRec(c) && typeof c.text === "string" ? c.text : null));
    if (texts.every((t) => t != null)) return texts.join("\n");
  }
  return resp == null ? "" : JSON.stringify(resp);
}

export function readCapture(c: CaptureFile): Capture | null {
  if (!isRec(c)) return null;
  const name = str(c.tool_name) ?? "";
  const m = /^mcp__claude_ai_([A-Za-z0-9_]+?)__(.+)$/.exec(name);
  if (!m) return null;
  const connector = m[1].replace(/_/g, " ");
  const input = isRec(c.tool_input) ? c.tool_input : {};
  if (c.failed === true) return { connector, tool: m[2], input, text: "", json: null, error: String(c.error ?? "").slice(0, 500) };
  const text = str(c.saved_text) ?? responseText(c.tool_response);
  return { connector, tool: m[2], input, text, json: tryJson(text) };
}

/** 슬랙·노션은 안쪽 JSON 의 글 칸(result · messages · text)을 본다. */
function innerText(cap: Capture, keys: readonly string[]): string {
  if (isRec(cap.json)) {
    for (const k of keys) { const v = cap.json[k]; if (typeof v === "string") return v; }
  }
  return cap.text;
}

// ── 공통 ─────────────────────────────────────────────────────────────────────

export interface ListedUnit { ref: string; name: string | null; kind: string }

/** Postgres 글 칸은 NUL(\u0000)을 받지 않는다 — 그대로 넣으면 그 글의 저장이 매번 실패해 단위가 멈춘다. 다른 저장 경로처럼 걷어 낸다. */
const clean = (s: string | null | undefined): string | undefined => (s == null ? undefined : s.replace(/\u0000/g, ""));

/** 제목 보조 — 본문 첫 줄을 짧게(connectors/slack.ts deriveTitle 와 같은 결: 메시지에는 제목이 없다). */
export function firstLineTitle(body: string, max = 80): string | undefined {
  const line = String(body ?? "").split("\n").map((l) => l.trim()).find(Boolean);
  if (!line) return undefined;
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

// ── 슬랙 ─────────────────────────────────────────────────────────────────────

const SLACK_TS = /^\d{9,11}\.\d{1,6}$/;

/** «Public Channel» 같은 표기 → 단위 종류(unit-plan UNIT_KINDS). */
function slackKind(type: string | null): string {
  const t = String(type ?? "").toLowerCase();
  if (/private/.test(t)) return "private_channel";
  if (/(group|mpim|multi)/.test(t)) return "group_dm";
  if (/(direct|\bdm\b|\bim\b)/.test(t)) return "dm";
  if (/(public|channel)/.test(t)) return "channel";
  return "other";
}

/** slack_list_user_channels 결과 → 채널 목록 · 다음 쪽. */
export function parseSlackChannelList(cap: Capture): { units: ListedUnit[]; more: boolean; cursor: string | null; archived: string[] } {
  const text = innerText(cap, ["result", "channels"]);
  const units: ListedUnit[] = [];
  const archived: string[] = [];
  const blocks = text.split(/^###\s+/m).slice(1);
  for (const b of blocks) {
    const head = b.split("\n")[0].trim();
    const id = /^-\s*\*\*ID:\*\*\s*([CDG][A-Z0-9]{6,})\s*$/m.exec(b)?.[1] ?? null;
    if (!id) continue;
    const type = /^-\s*\*\*Type:\*\*\s*(.+?)\s*$/m.exec(b)?.[1] ?? null;
    const isArchived = /^-\s*\*\*Archived:\*\*\s*Yes\b/im.test(b);
    const name = head.replace(/^#/, "").trim() || null;
    units.push({ ref: id, name, kind: slackKind(type) });
    if (isArchived) archived.push(id);
  }
  //  다음 쪽은 cursor 가 있으면 있다고 본다(문구가 바뀌어도) — «전부» 판정은 볼 수 있는 구성원을 지우므로 의심스러우면 «더 있음» 쪽이다.
  const cursor = /Use cursor:\s*"([^"]+)"/i.exec(text)?.[1] ?? null;
  return { units, more: !!cursor, cursor, archived };
}

export interface SlackMsg {
  ts: string;
  user_id: string | null;
  user_name: string | null;
  email: string | null;
  /** 원문의 시각 글(예 «2026-08-20 11:45:38 KST») — 시각의 정본은 ts 다. */
  at: string | null;
  body: string;
  reply_count: number | null;
}

/** «이름 <메일> (U…)» · «이름 (B…)» → 작성자. 모르는 모양이면 이름만. */
function slackAuthor(s: string): { user_id: string | null; user_name: string | null; email: string | null } {
  const m = /^(.*?)(?:\s*<([^<>\s]+@[^<>\s]+)>)?\s*\(([UBW][A-Z0-9]{6,})\)\s*$/.exec(s.trim());
  if (!m) return { user_id: null, user_name: s.trim() || null, email: null };
  return { user_id: m[3], user_name: m[1].trim() || null, email: m[2] ? m[2].toLowerCase() : null };
}

/** 메시지 몸통(«Message TS:» 다음 줄부터) — 꼬리의 메타 줄(답글 수 · 반응 · 파일)을 떼어 낸다. 본문 중간의 같은 낱말은 남는다. */
function slackBody(lines: string[]): { body: string; reply_count: number | null } {
  const rest = [...lines];
  let replies: number | null = null;
  while (rest.length) {
    const last = rest[rest.length - 1].trim();
    if (last === "") { rest.pop(); continue; }
    const t = /^Thread:\s*(\d+)\s+repl(?:y|ies)\b/.exec(last);
    if (t) { replies = Number(t[1]); rest.pop(); continue; }
    if (/^(Reactions|Files):\s/.test(last)) { rest.pop(); continue; }
    break;
  }
  while (rest.length && rest[0].trim() === "") rest.shift();
  return { body: rest.join("\n"), reply_count: replies };
}

function slackBlock(head: { user_id: string | null; user_name: string | null; email: string | null; at: string | null }, lines: string[]): SlackMsg | null {
  const i = lines.findIndex((l) => /^Message TS:\s*/.test(l.trim()));
  if (i < 0) return null;
  const ts = lines[i].trim().replace(/^Message TS:\s*/, "").trim();
  if (!SLACK_TS.test(ts)) return null;
  const { body, reply_count } = slackBody(lines.slice(i + 1));
  return { ts, ...head, body, reply_count };
}

/** 슬랙 ts·epoch 를 숫자로(빈 값·모양 밖은 null). */
const tsNum = (v: unknown): number | null => {
  const s = typeof v === "number" ? String(v) : str(v);
  if (!s || !/^\d{9,11}(\.\d{1,6})?$/.test(s.trim())) return null;
  return Number(s);
};

/**
 * slack_read_channel 결과 → 채널 · 메시지들 · 다음 쪽.
 *  · 채널은 **첫 줄** 머리(`Channel: #이름 (C…)`)에서만 읽는다 — 본문 속 같은 모양의 줄이 채널을 정하지 못하게. 머리가 없으면 null.
 *  · wellFormed — 머리가 있고 쪽 안내(pagination_info)가 «더 있음» 이나 «더 없음» 둘 중 하나다. 아니면 이 결과는 증거가 못 된다
 *    (오류 문구 · 형식이 바뀐 글). end — «더 없음» 이 분명히 적혀 있고 cursor 가 없다.
 *  · 요청한 구간(입력 oldest~latest) 밖의 ts 는 버린다(dropped) — 커넥터는 구간 안만 돌려준다. 밖의 것은 본문이 머리 모양을
 *    흉내 낸 것이거나 잘못 푼 것이다. ⚠ 구간 **안**의 가짜 머리는 글 모양만으로는 못 가린다 — 이 경로의 작성자(actor)는 확인된 신원이 아니다.
 */
export function parseSlackChannelMessages(cap: Capture): {
  channel: { id: string; name: string | null } | null; messages: SlackMsg[]; more: boolean; end: boolean; cursor: string | null;
  wellFormed: boolean; dropped: number;
} {
  const text = innerText(cap, ["messages"]);
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  const ch = /^Channel:\s*#?(.*?)\s*\(([CDG][A-Z0-9]{6,})\)\s*$/.exec(first.trim());
  const channel = ch ? { id: ch[2], name: ch[1].trim() || null } : null;
  const lo = tsNum(cap.input.oldest), hi = tsNum(cap.input.latest);
  const messages: SlackMsg[] = [];
  let dropped = 0;
  const parts = text.split(/^=== Message from (.+?) ===[ \t]*$/m);
  //  split 이 잡은 머리글이 홀수 칸에 온다: [앞, 머리1, 몸1, 머리2, 몸2, …]
  for (let k = 1; k + 1 < parts.length; k += 2) {
    const h = /^(.*) at (.+)$/.exec(parts[k].trim());
    const author = slackAuthor(h ? h[1] : parts[k]);
    const msg = slackBlock({ ...author, at: h ? h[2].trim() : null }, parts[k + 1].split("\n"));
    if (!msg) continue;
    const t = Number(msg.ts);
    if ((lo != null && t < lo) || (hi != null && t > hi)) { dropped++; continue; }
    messages.push(msg);
  }
  const pag = isRec(cap.json) && typeof cap.json.pagination_info === "string" ? cap.json.pagination_info : "";
  const cursor = /use cursor:\s*`([^`]+)`/i.exec(pag)?.[1] ?? null;
  const end = !cursor && /no more messages/i.test(pag);
  return { channel, messages, more: !!cursor, end, cursor, wellFormed: !!channel && (end || !!cursor), dropped };
}

/** slack_read_thread 결과 → 부모 · 답글들. 채널 id 는 결과 글에 없어 도구 입력에서 읽는다. */
export function parseSlackThread(cap: Capture): {
  channelId: string | null; parent: SlackMsg | null; replies: SlackMsg[]; more: boolean; end: boolean; cursor: string | null; wellFormed: boolean;
} {
  const text = innerText(cap, ["messages"]);
  const channelId = str(cap.input.channel_id);
  const blockOf = (chunk: string): SlackMsg | null => {
    const lines = chunk.split("\n");
    const from = lines.find((l) => /^From:\s*/.test(l.trim()));
    const time = lines.find((l) => /^Time:\s*/.test(l.trim()));
    const author = slackAuthor(from ? from.trim().replace(/^From:\s*/, "") : "");
    return slackBlock({ ...author, at: time ? time.trim().replace(/^Time:\s*/, "") : null }, lines);
  };
  const [beforeReplies, ...afterSplit] = text.split(/^=== THREAD REPLIES\b.*===[ \t]*$/m);
  const parentChunk = beforeReplies.split(/^=== THREAD PARENT MESSAGE ===[ \t]*$/m)[1] ?? "";
  const parent = parentChunk ? blockOf(parentChunk) : null;
  const replies: SlackMsg[] = [];
  //  이어 읽은 쪽(cursor)은 부모·«THREAD REPLIES» 머리 없이 답글만 올 수 있다 — 그때는 글 전체에서 답글을 찾는다.
  const replyText = afterSplit.length ? afterSplit.join("\n") : parent ? "" : text;
  for (const chunk of replyText.split(/^--- Reply \d+ of \d+ ---[ \t]*$/m).slice(1)) {
    const m = blockOf(chunk);
    if (m) replies.push(m);
  }
  const pag = isRec(cap.json) && typeof cap.json.pagination_info === "string" ? cap.json.pagination_info : "";
  const cursor = /use cursor:\s*`([^`]+)`/i.exec(pag)?.[1] ?? null;
  const end = !cursor && /no more (messages|replies)/i.test(pag);
  return {
    channelId: channelId && /^[CDG][A-Z0-9]{6,}$/.test(channelId) ? channelId : null, parent, replies, more: !!cursor, end, cursor,
    //  부모 머리가 있고 쪽 안내가 분명할 때만 증거가 된다(«스레드를 끝까지 읽었다»).
    wellFormed: !!parent && (end || !!cursor),
  };
}

/** 검색 결과의 글 하나 — 채널 · 그 글의 ts · 그 글이 속한 스레드의 부모 ts(Permalink 의 thread_ts — 부모 글이면 자기 ts) · 답글 수. */
export interface SlackSearchHit { channel: string | null; ts: string; thread_ts: string | null; reply_count: number | null }

/**
 * slack_search_public · slack_search_public_and_private 결과 → 맞은 글들 · 다음 쪽 (#4744 옛 스레드의 새 답글).
 *  맥 실측(2026-10-19, response_format detailed): `# Search Results for: …` · `### Result i of N` 다음에
 *   `Channel: #이름 (ID: C…)`(DM 은 `Channel: DM (ID: D…)` + `Participants:`) · `From:` · `Time:` · `Message_ts:` · (`Reply count:`) ·
 *   `Permalink: [link](…/archives/C…/p…?thread_ts=<부모 ts>&cid=C…)` · `Text:` 뒤가 본문. 맞은 것이 없으면 `No results found.`
 *   쪽 안내(pagination_info)는 «For the next page of results use cursor `…`» · 끝은 «End of results - No more pages available.».
 *   include_context 의 앞뒤 글(`Context before:`)은 본문 **뒤**에 들여 써서 붙는다.
 *  · 글마다 머리 칸은 `Text:` **앞**에서만 읽는다 — 본문·앞뒤 글 속 같은 모양의 줄이 머리를 정하지 못하게.
 *  · 쪽이 밝힌 결과 수(`## Messages (N results)` — 그 쪽의 글 수다. 맥 실측: 꽉 찬 쪽 = 쪽 크기 · 마지막 쪽 = 나머지 · 없으면
 *    `No results found.` = 0)와 맞춘다: 머리 칸을 다 읽은 글이 N 이상이면 머리 없는 조각(본문 속 `### Result N of M` 줄에서 갈라진 것)은
 *    본문 조각으로 버리고, 모자랄 때만 모자란 만큼 센다. 결과 수 줄을 못 읽으면(꼴이 바뀜) 머리 없는 조각을 그대로 센다.
 *    머리 칸이 다 맞는 조각은 결과로 센다 — 그 스레드 읽기가 «없는 스레드»(thread_not_found)면 읽을 것이 없는 스레드로 센다(collect-plan harvestUnits).
 *  · 검색 본문은 꾸밈(*굵게* · `코드` · 앱 서명)이 빠진 글이라 스레드 읽기 본문과 다르다 — **자료로 넣지 않는다**(어느 스레드를 읽을지만 정한다).
 *  · wellFormed — 머리글이 있고 쪽 안내가 «다음 쪽 cursor» 나 «끝» 둘 중 하나다. end — «끝» 이 분명하고 cursor 가 없다.
 */
export function parseSlackSearch(cap: Capture): {
  hits: SlackSearchHit[]; more: boolean; end: boolean; cursor: string | null; wellFormed: boolean;
  /**
   * 머리 칸(채널 · Message_ts · Permalink 의 thread_ts)을 다 읽은 글이 쪽이 밝힌 결과 수보다 모자란 만큼 — 있으면 형식이 바뀐 것이다(그 글을
   *  조용히 빠뜨리지 않게 호출부가 증거에서 뺀다). 결과 수를 못 읽으면 머리 칸이 없는 조각 수.
   */
  unparsed: number;
} {
  const text = innerText(cap, ["results"]);
  const head = /^#\s*Search Results\b/.test((text.split("\n").find((l) => l.trim()) ?? "").trim());
  //  쪽이 밝힌 결과 수 — 첫 «## Messages (N results)» 줄(본문보다 앞이다) · 맞은 것이 없다는 줄이면 0 · 못 읽으면 null.
  const declaredM = /^## Messages \((\d+) results?\)[ \t]*$/m.exec(text);
  const firstResult = text.search(/^### Result \d+ of \d+[ \t]*$/m);
  const declared = declaredM && (firstResult < 0 || declaredM.index < firstResult) ? Number(declaredM[1])
    : firstResult < 0 && /^No results found\.?[ \t]*$/m.test(text) ? 0 : null;
  const hits: SlackSearchHit[] = [];
  let headless = 0;
  for (const chunk of text.split(/^### Result \d+ of \d+[ \t]*$/m).slice(1)) {
    const lines = chunk.split("\n");
    const stop = lines.findIndex((l) => /^Text:/.test(l.trim()));
    const hdr = (stop >= 0 ? lines.slice(0, stop) : lines).map((l) => l.trim());
    const get = (re: RegExp): RegExpExecArray | null => { for (const l of hdr) { const m = re.exec(l); if (m) return m; } return null; };
    const ts = get(/^Message_ts:\s*(\d{9,11}\.\d{1,6})$/)?.[1] ?? null;
    const channel = get(/^Channel:.*\(ID:\s*([CDG][A-Z0-9]{6,})\)$/)?.[1] ?? null;
    const link = get(/^Permalink:\s*\[[^\]]*\]\((\S+)\)$/)?.[1] ?? "";
    //  is:thread 로 찾은 글은 부모든 답글이든 Permalink 에 thread_ts 가 있다(부모는 자기 ts) — 없으면 꼴이 바뀐 것이다.
    const thread = /[?&]thread_ts=(\d{9,11}\.\d{1,6})(?:[&#]|$)/.exec(link.replace(/\\\//g, "/"))?.[1] ?? null;
    if (!ts || !channel || !thread) { headless++; continue; }
    const rc = get(/^Reply count:\s*(\d+)$/)?.[1];
    hits.push({ channel, ts, thread_ts: thread, reply_count: rc != null ? Number(rc) : null });
  }
  const unparsed = declared != null ? Math.max(0, declared - hits.length) : headless;
  const pag = isRec(cap.json) && typeof cap.json.pagination_info === "string" ? cap.json.pagination_info : "";
  const cursor = /use cursor:?\s*`([^`]+)`/i.exec(pag)?.[1] ?? null;
  const end = !cursor && /end of results|no more pages/i.test(pag);
  return { hits, more: !!cursor, end, cursor, wellFormed: head && (end || !!cursor), unparsed };
}

/** 슬랙 ts → ISO(초.마이크로초 — 밀리초까지). */
export function slackTsIso(ts: string): string | undefined {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(Math.floor(n * 1000)).toISOString() : undefined;
}

/** 메시지 → RawItem(connectors/slack.ts toRawItem 과 같은 좌표·칸). threadParentTs 가 있고 자기 ts 와 다르면 답글. */
export function slackItem(m: SlackMsg, ctx: { instance: string; channel: string; channelName?: string | null; threadParentTs?: string | null }): RawItem {
  const parent = ctx.threadParentTs && ctx.threadParentTs !== m.ts ? ctx.threadParentTs : null;
  return {
    type: "message",
    provenance: { category: "messenger", system: "slack", instance: ctx.instance, external_id: `${ctx.channel}:${m.ts}` },
    actor: m.user_id || m.user_name ? {
      external_id: m.user_id ?? undefined, display_name: m.user_name ?? undefined, email: m.email ?? undefined,
      is_bot: !!m.user_id && m.user_id.startsWith("B"),
    } : undefined,
    container_ref: ctx.channel,
    container_name: ctx.channelName ?? undefined,
    parent_external_id: parent ? `${ctx.channel}:${parent}` : undefined,
    title: firstLineTitle(clean(m.body) ?? ""),
    body: clean(m.body) || undefined,
    occurred_at: slackTsIso(m.ts),
    fields: {
      ts: m.ts,
      thread_ts: parent ?? (m.reply_count ? m.ts : undefined),
      reply_count: m.reply_count ?? undefined,
      via: "claude_connector",
    },
  };
}

// ── 지메일 ───────────────────────────────────────────────────────────────────

export interface GmailMsg {
  /** 시각 — 구글이 받은 시각(internalDate)이 먼저, 없으면 보낸 쪽이 적은 Date 머리. 머리는 보낸 쪽 마음대로라 위치·정렬에 쓰지 않는다. */
  id: string; threadId: string | null; subject: string | null; sender: string | null; date: string | null; dateHeader: string | null;
  body: string | null; snippet: string | null; labelIds: string[]; viewUrl: string | null;
  /** 본문(plaintextBody)을 받은 결과인가 — 목록(search)의 한 줄 요약과 가른다(같은 id 면 본문 쪽이 이긴다). */
  full: boolean;
}

const GMAIL_ID = /^[0-9a-f]{10,24}$/i;

function gmailMsg(v: unknown): GmailMsg | null {
  if (!isRec(v)) return null;
  const id = str(v.id);
  if (!id || !GMAIL_ID.test(id)) return null;
  const body = str(v.plaintextBody);
  const internal = str(v.internalDate) ?? (typeof v.internalDate === "number" ? String(v.internalDate) : null);
  const header = str(v.date);
  const headerIso = header && Number.isFinite(Date.parse(header)) ? new Date(header).toISOString() : null;
  const date = internal && /^\d{12,14}$/.test(internal) ? new Date(Number(internal)).toISOString() : headerIso;
  return {
    id, threadId: str(v.threadId), subject: str(v.subject), sender: str(v.sender), date, dateHeader: header,
    body, snippet: str(v.snippet), labelIds: Array.isArray(v.labelIds) ? v.labelIds.filter((x): x is string => typeof x === "string") : [],
    viewUrl: str(v.viewUrl), full: body != null,
  };
}

/** search_threads · get_thread · get_message 결과 → 메시지들(같은 id 는 본문이 있는 쪽). */
export function parseGmailMessages(cap: Capture): GmailMsg[] {
  const j = cap.json;
  const raw: unknown[] = [];
  if (isRec(j)) {
    if (Array.isArray(j.threads)) for (const t of j.threads) if (isRec(t) && Array.isArray(t.messages)) raw.push(...t.messages);
    if (Array.isArray(j.messages)) raw.push(...j.messages);
    if (str(j.id) && (j.plaintextBody !== undefined || j.subject !== undefined || j.threadId !== undefined) && !Array.isArray(j.messages)) raw.push(j);
  }
  const out = new Map<string, GmailMsg>();
  for (const r of raw) {
    const m = gmailMsg(r);
    if (!m) continue;
    const prev = out.get(m.id);
    if (!prev || (!prev.full && m.full)) out.set(m.id, m);
  }
  return [...out.values()];
}

/**
 * search_threads 결과가 제 모양인가 — {threads:[…]} 또는 빈 검색 {}(· {resultCountEstimate: 0}). 오류 · 형식이 바뀐 글은 «검색했다» 의
 *  증거가 못 된다. 빈 검색을 제 모양으로 안 보면 한가한 메일함은 구간을 영영 못 넘긴다(실측: 빈 결과는 칸 없는 {}).
 */
export function isGmailSearch(cap: Capture): boolean {
  const j = cap.json;
  if (!isRec(j) || j.error != null) return false;
  if (Array.isArray(j.threads)) return true;
  return j.threads === undefined && Object.keys(j).every((k) => k === "resultCountEstimate" || k === "resultSizeEstimate") && !j.nextPageToken;
}

/** get_thread · get_message 결과가 제 모양인가 — {id, messages:[…]} · {id, …메시지 칸}. */
export function isGmailFetch(cap: Capture): boolean {
  const j = cap.json;
  if (!isRec(j) || typeof j.id !== "string") return false;
  return cap.tool === "get_thread" ? Array.isArray(j.messages) : (j.plaintextBody !== undefined || j.threadId !== undefined);
}

/** 메일함 주소 — viewUrl 의 authuser=… (그 사람 커넥터가 붙은 구글 계정). 없으면 null. */
export function gmailMailbox(msgs: readonly GmailMsg[]): string | null {
  for (const m of msgs) {
    const a = m.viewUrl ? /[?&]authuser=([^&#]+)/.exec(m.viewUrl)?.[1] : null;
    if (a) { try { const e = decodeURIComponent(a).trim().toLowerCase(); if (/^[^@\s]+@[^@\s]+$/.test(e)) return e; } catch { /* 다음 */ } }
  }
  return null;
}

/** «이름 <메일>» · «메일» → 메일·이름. */
function parseSender(s: string | null): { email: string | null; name: string | null } {
  if (!s) return { email: null, name: null };
  const m = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(s.trim());
  if (m) return { email: m[2].toLowerCase(), name: m[1].replace(/^"|"$/g, "").trim() || null };
  return /^[^@\s]+@[^@\s]+$/.test(s.trim()) ? { email: s.trim().toLowerCase(), name: null } : { email: null, name: s.trim() || null };
}

/** 메시지 → RawItem(connectors/gmail.ts toRawItem 과 같은 좌표). */
export function gmailItem(m: GmailMsg, ctx: { instance: string; mailbox: string }): RawItem {
  const who = parseSender(m.sender);
  const iso = m.date ?? undefined;
  return {
    type: "message",
    provenance: { category: "messenger", system: "gmail", instance: ctx.instance, external_id: m.id, external_url: `https://mail.google.com/mail/u/0/#all/${m.id}` },
    actor: who.email ? { external_id: who.email, display_name: who.name ?? undefined, email: who.email } : undefined,
    container_ref: ctx.mailbox,
    parent_external_id: m.threadId && m.threadId !== m.id ? m.threadId : undefined,
    title: clean(m.subject) || undefined,
    body: clean(m.body ?? m.snippet) || undefined,
    occurred_at: iso,
    updated_at: iso,
    fields: { threadId: m.threadId ?? undefined, labelIds: m.labelIds, snippet: clean(m.snippet), date_header: m.dateHeader ?? undefined, via: "claude_connector" },
  };
}

// ── 노션 ─────────────────────────────────────────────────────────────────────

/** URL·id 의 32자리 → 하이픈 UUID(노션 수집기의 node.id 와 같은 꼴 · unit-plan canonicalCoord 와 같은 규칙). */
export function notionId(urlOrId: string | null): string | null {
  const s = String(urlOrId ?? "");
  const hex = (/([0-9a-f]{32})(?:[?#/]|$)/i.exec(s.replace(/-/g, "")) ?? /([0-9a-f]{32})/i.exec(s.replace(/-/g, "")))?.[1]?.toLowerCase();
  return hex ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : null;
}

export interface NotionPage { id: string; title: string | null; url: string | null; body: string; edited_at: string | null; kind: "page" | "database" }

/** notion-fetch 결과 → 페이지. 본문은 <content> 안(없으면 머리말 줄을 뺀 글 전체). */
export function parseNotionFetch(cap: Capture): NotionPage | null {
  const j = cap.json;
  //  제 모양(본문 글이 있다)이 아니면 페이지가 아니다 — 오류 결과로 빈 페이지를 만들면 저장 단계가 있던 제목·본문을 지운다.
  if (!isRec(j) || j.error != null || typeof j.text !== "string" || (typeof j.url !== "string" && typeof j.title !== "string")) return null;
  const url = str(j.url);
  const id = notionId(url) ?? notionId(str(cap.input.id));
  if (!id) return null;
  const text = str(j.text) ?? "";
  const content = /<content>\n?([\s\S]*?)\n?<\/content>/.exec(text)?.[1];
  const body = content ?? text.replace(/^Here is the result of "fetch"[^\n]*\n/, "");
  const type = isRec(j.metadata) ? String(j.metadata.type ?? "") : "";
  return {
    id, title: str(j.title), url, body: body.trim(), edited_at: str(j.page_last_edited_at),
    kind: /database|data_source/.test(type) ? "database" : "page",
  };
}

/** list-recent/shared/private · search 결과 → 페이지 목록 · 다음 쪽. */
export function parseNotionList(cap: Capture): { units: ListedUnit[]; cursor: string | null } {
  const j = cap.json;
  const units: ListedUnit[] = [];
  if (isRec(j) && Array.isArray(j.results)) {
    for (const r of j.results) {
      if (!isRec(r)) continue;
      const id = notionId(str(r.url)) ?? notionId(str(r.id));
      if (!id) continue;
      const type = String(r.type ?? "page");
      if (!/^(page|database|data_source)$/.test(type)) continue;
      units.push({ ref: id, name: str(r.title)?.trim() || null, kind: type === "page" ? "page" : "database" });
    }
  }
  const cursor = isRec(j) ? (str(j.next_cursor) ?? str(j.nextCursor) ?? str(j.cursor)) : null;
  return { units, cursor };
}

/** 페이지 → RawItem(connectors/notion/emit.ts 와 같은 좌표). */
export function notionItem(p: NotionPage, ctx: { instance: string }): RawItem {
  return {
    type: "doc",
    provenance: { category: "collab_tool", system: "notion", instance: ctx.instance, external_id: p.id, external_url: p.url ?? undefined },
    title: clean(p.title) || "(제목 없음)",
    body: clean(p.body) || undefined,
    updated_at: p.edited_at ?? undefined,
    fields: { notion: { kind: p.kind, url: p.url }, via: "claude_connector" },
  };
}
