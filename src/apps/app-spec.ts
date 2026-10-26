// 앱 「개발 정보」 명세(#4632, 원준 2026-10-26 «앱의 코드를 SSOT로 해서 코드 내용을 자연어로 번역해준 시트 … 앱마다 하나씩 …
//  내가 그 앱의 코드를 다른 세션을 시켜서 바꿔도 자동으로 그 페이지의 명세가 바뀌도록») — 순수 규칙.
//
//  명세는 두 층이다:
//   A. 코드에서 바로 읽은 것(specFacts) — 매니페스트와 파일을 기계로 읽는다. AI 가 없고 열 때마다 계산하니 늘 코드와 같다.
//      화면 · 표와 칸 · 권한 · 바깥 호출(라이블리 API 경로 · 도구 이름 · 바깥 주소 · AI 모델 이름)과 그 자리(파일:줄).
//   B. 쉬운 말 설명(AppSpecDoc) — AI 가 코드를 읽고 쓴 글. 판의 코드 지문(content_hash)마다 하나(org_app_spec · apps/app-spec-run.ts).
//      새 판이 저장되면 다시 쓰고(insertVersion 한 자리 — 어느 세션이 저장했든), 같은 지문이면 다시 쓰지 않는다.
//  이 파일은 DB · 네트워크를 모른다 — 읽기 · 판정 · 프롬프트 · 답 읽기만.
import { isTextPath } from "./app-versions.js";

export interface SpecFile { path: string; content: string; encoding?: "utf8" | "base64" }

/** 코드 속 한 자리 — 파일 경로와 줄(1부터). */
export interface SpecWhere { file: string; line: number }
/**
 * 바깥과 주고받는 호출 하나 — 같은 이름은 한 줄로 모으고 자리는 SPEC_WHERE_MAX 까지만 싣는다(count 는 전부).
 *  kind: lively = 같은 주소 API(/_lively/…) · sdk = 화면 SDK(lively.store.query 등) · tool = 라이블리 도구(tools.call) · host = 바깥 주소 · model = AI 모델 이름.
 */
export interface SpecCall { kind: "lively" | "sdk" | "tool" | "host" | "model"; name: string; label: string; count: number; where: SpecWhere[] }
export interface SpecFacts {
  pages: Array<{ key: string; title: string; entry: string; places: string[] }>;
  tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }>;
  perms: Array<{ key: string; label: string }>;
  calls: SpecCall[];
  files: Array<{ path: string; size: number; text: boolean }>;
  server: { start: string | null; dir: string | null } | null;
  instructions: boolean;
}

export const SPEC_WHERE_MAX = 5;

const PLACE_LABEL: Record<string, string> = { inline: "세션 옆", fullscreen: "앱 화면", side: "세션 옆", full: "앱 화면" };
const PERM_LABEL: Record<string, string> = {
  chat_send: "붙은 세션에 글 보내기",
  notifications: "알림 보내기",
  ai_runs: "AI 실행(워크스페이스 AI 계정)",
  app_folder: "앱 폴더에 파일 올리고 받기",
  project_files: "세션 프로젝트 자료 읽기",
  workspace_files: "모든 프로젝트 자료 읽기",
};
//  같은 주소 API 의 첫 마디 → 쉬운 이름(app-front-api.ts — store · tools · prefs · ai · me).
const LIVELY_LABEL: Record<string, string> = {
  "ai/runs": "AI 실행 요청과 결과 받기", ai: "AI 실행", store: "앱 표 읽고 쓰기", tools: "라이블리 도구 부르기", prefs: "보는 사람의 표시 설정",
  me: "보는 사람과 붙은 세션 정보", jobs: "백그라운드 작업", sdk: "화면 SDK 불러오기",
};
const SDK_LABEL: Record<string, string> = {
  "store.query": "앱 표 읽기", "store.insert": "앱 표에 행 더하기", "store.update": "앱 표 행 고치기", "store.delete": "앱 표 행 지우기",
  "store.sql": "앱 표에 SQL 보내기", "store.onChange": "앱 표가 바뀌면 다시 읽기", "chat.send": "붙은 세션에 글 보내기",
  "files.list": "프로젝트 자료 목록 읽기", "files.read": "프로젝트 자료 내용 읽기", "prefs.get": "표시 설정 읽기", "prefs.set": "표시 설정 저장",
  "ai.run": "AI 실행", "tools.call": "라이블리 도구 부르기", "requestConsent": "동의 창 띄우기",
};
//  표준 이름공간 · 문서 주소 — 앱이 실제로 부르는 곳이 아니다.
const HOST_IGNORE = /(^|\.)(w3\.org|xmlsoap\.org|schemas\.microsoft\.com|purl\.org|ogp\.me|schema\.org|example\.com|example\.org)$/i;

/** (순수) 매니페스트 + 판의 파일 → 코드에서 바로 읽은 사실. 모양이 틀린 칸은 건너뛴다(던지지 않는다). */
export function specFacts(manifest: unknown, files: ReadonlyArray<SpecFile>): SpecFacts {
  const m = (manifest && typeof manifest === "object" ? manifest : {}) as Record<string, any>;
  const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const pages = [...arr(m.ui?.pages), ...arr(m.ui?.widgets)].filter((p) => p && typeof p === "object").map((p) => ({
    key: str(p.key), title: str(p.title), entry: str(p.entry),
    places: arr(p.display).map((d) => PLACE_LABEL[str(d)] || str(d)).filter(Boolean),
  }));
  const tables = arr(m.data?.tables).filter((t) => t && typeof t === "object" && str(t.name)).map((t) => ({
    name: str(t.name),
    columns: arr(t.columns).filter((c) => c && typeof c === "object" && str(c.name)).map((c) => ({ name: str(c.name), type: str(c.type) || "text" })),
  }));
  const p = (m.permissions && typeof m.permissions === "object" ? m.permissions : {}) as Record<string, unknown>;
  const perms: SpecFacts["perms"] = [];
  for (const t of arr(p.tools)) if (str(t)) perms.push({ key: "tool:" + str(t), label: "도구 " + str(t) });
  for (const k of Object.keys(PERM_LABEL)) {
    const v = p[k];
    if (v === true) perms.push({ key: k, label: PERM_LABEL[k] });
    else if (Array.isArray(v) && v.length) perms.push({ key: k, label: PERM_LABEL[k] + " (" + v.map(String).join(", ") + ")" });
  }
  const devices = arr(m.web?.devices).map(str).filter(Boolean);
  if (devices.length) perms.push({ key: "devices", label: "기기 쓰기 (" + devices.join(", ") + ")" });
  const s = m.web?.server;
  const server = s === true ? { start: null, dir: null } : s && typeof s === "object" && !Array.isArray(s) ? { start: str(s.start) || null, dir: str(s.dir) || null } : null;

  const calls = new Map<string, SpecCall>();
  const hit = (kind: SpecCall["kind"], name: string, label: string, file: string, line: number): void => {
    const k = kind + ":" + name;
    let c = calls.get(k);
    if (!c) { c = { kind, name, label, count: 0, where: [] }; calls.set(k, c); }
    c.count++;
    if (c.where.length < SPEC_WHERE_MAX && !c.where.some((w) => w.file === file && w.line === line)) c.where.push({ file, line });
  };
  const fileRows: SpecFacts["files"] = [];
  for (const f of files) {
    const text = f.encoding !== "base64" && isTextPath(f.path);
    fileRows.push({ path: f.path, size: Buffer.byteLength(f.content ?? "", f.encoding === "base64" ? "base64" : "utf8"), text });
    if (!text || f.path === "lively-app.json") continue;
    scanText(f.path, f.content ?? "", hit);
  }
  const order: Record<SpecCall["kind"], number> = { lively: 0, sdk: 1, tool: 2, model: 3, host: 4 };
  return {
    pages, tables, perms,
    calls: [...calls.values()].sort((a, b) => order[a.kind] - order[b.kind] || b.count - a.count || a.name.localeCompare(b.name)),
    files: fileRows.sort((a, b) => a.path.localeCompare(b.path)),
    server, instructions: !!str(m.agent?.instructions).trim(),
  };
}

function scanText(file: string, text: string, hit: (kind: SpecCall["kind"], name: string, label: string, file: string, line: number) => void): void {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.length > 20000) continue;   // 한 줄로 뭉친 큰 덩어리(base64 · 축소된 라이브러리)는 건너뛴다
    const at = i + 1;
    for (const x of ln.matchAll(/\/_lively\/([a-z][a-z0-9_]*)(?:\/([a-z][a-z0-9_]*))?/g)) {
      const two = x[2] ? x[1] + "/" + x[2] : "";
      const name = two && LIVELY_LABEL[two] ? two : x[1];
      hit("lively", "/_lively/" + name, LIVELY_LABEL[name] || "라이블리 API", file, at);
    }
    for (const x of ln.matchAll(/\.(store|chat|files|prefs|ai)\s*(?:\.\s*([a-zA-Z]+)|\[\s*['"]([a-zA-Z]+)['"]\s*\])\s*\(/g)) {
      const name = x[1] + "." + (x[2] || x[3]);
      if (SDK_LABEL[name]) hit("sdk", name, SDK_LABEL[name], file, at);
    }
    for (const x of ln.matchAll(/\.requestConsent\s*\(/g)) { void x; hit("sdk", "requestConsent", SDK_LABEL.requestConsent, file, at); }
    for (const x of ln.matchAll(/tools\s*\.\s*call\s*\(\s*['"`]([a-z][a-z0-9_]*)['"`]/g)) hit("tool", x[1], "라이블리 도구", file, at);
    for (const x of ln.matchAll(/\b(claude-[a-z0-9][a-z0-9.-]*[a-z0-9]|gpt-[0-9][a-z0-9.-]*|whisper(?:-[a-z0-9.-]+)?|gemini-[0-9][a-z0-9.-]*)\b/gi)) {
      hit("model", x[1].toLowerCase(), "AI 모델 이름", file, at);
    }
    for (const x of ln.matchAll(/\b(?:https?|wss?):\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?/gi)) {
      const host = x[1].toLowerCase();
      if (HOST_IGNORE.test(host)) continue;
      hit("host", host, "바깥 주소", file, at);
    }
  }
}

// ── AI 에 실을 코드 ──
export const SPEC_INPUT_MAX_CHARS = 240_000;
/**
 * (순수) 판의 글 파일을 AI 에 실을 한 덩어리로 — 매니페스트 먼저, 그다음 코드(서버 · 화면), 만들기 기록(studio/)은 맨 뒤.
 *  상한을 넘으면 거기서 자르고 잘린 파일을 알린다. 바이너리는 이름만(skipped).
 */
export function specInput(files: ReadonlyArray<SpecFile>, max = SPEC_INPUT_MAX_CHARS): { text: string; included: string[]; truncated: string[]; skipped: string[] } {
  const rank = (p: string): number => (p === "lively-app.json" ? 0 : p.startsWith("studio/") ? 3 : /\.(md|txt|csv)$/i.test(p) ? 2 : 1);
  const sorted = [...files].sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
  const parts: string[] = []; const included: string[] = []; const truncated: string[] = []; const skipped: string[] = [];
  let left = max;
  for (const f of sorted) {
    if (f.encoding === "base64" || !isTextPath(f.path)) { skipped.push(f.path); continue; }
    const head = `\n===== 파일: ${f.path} =====\n`;
    if (left <= head.length + 200) { truncated.push(f.path); continue; }
    const body = f.content ?? "";
    const room = left - head.length;
    if (body.length > room) { parts.push(head + body.slice(0, room) + "\n…(여기서 잘림)"); truncated.push(f.path); left = 0; }
    else { parts.push(head + body); left -= head.length + body.length; }
    included.push(f.path);
  }
  return { text: parts.join(""), included, truncated, skipped };
}

// ── 쉬운 말 설명(AI 가 쓴 것) ──
export interface AppSpecDoc {
  summary: string;
  screens: Array<{ name: string; where: string; what: string }>;
  data: Array<{ name: string; what: string; fields: Array<{ name: string; what: string }> }>;
  features: Array<{ name: string; steps: string[]; code: string }>;
  external: Array<{ what: string; how: string; data: string; code: string }>;
  permissions: Array<{ name: string; why: string }>;
  limits: string[];
  changes: string[];
}
const TXT_MAX = 800;
const LIST_MAX = 40;

/** (순수) AI 의 답 → 설명. 앞뒤 말 · ```json 울타리를 견디고, 칸이 빠지면 빈 목록으로, 문자열 아닌 항목은 버린다. summary 가 없으면 null(실패). */
export function parseSpecOutput(text: string): AppSpecDoc | null {
  const raw = String(text ?? "");
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  let body = fence ? fence[1] : raw;
  if (!fence) { const a = raw.indexOf("{"); const b = raw.lastIndexOf("}"); if (a < 0 || b <= a) return null; body = raw.slice(a, b + 1); }
  let j: any;
  try { j = JSON.parse(body); } catch { return null; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const s = (v: unknown): string => (typeof v === "string" ? v.trim().slice(0, TXT_MAX) : typeof v === "number" ? String(v) : "");
  const list = <T>(v: unknown, f: (x: any) => T | null): T[] => (Array.isArray(v) ? v.map((x) => (x && typeof x === "object" ? f(x) : null)).filter((x): x is T => x !== null).slice(0, LIST_MAX) : []);
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(s).filter(Boolean).slice(0, LIST_MAX) : []);
  const summary = s(j.summary);
  if (!summary) return null;
  return {
    summary,
    screens: list(j.screens, (x) => (s(x.name) ? { name: s(x.name), where: s(x.where), what: s(x.what) } : null)),
    data: list(j.data, (x) => (s(x.name) ? { name: s(x.name), what: s(x.what), fields: list(x.fields, (y) => (s(y.name) ? { name: s(y.name), what: s(y.what) } : null)) } : null)),
    features: list(j.features, (x) => (s(x.name) ? { name: s(x.name), steps: strs(x.steps), code: s(x.code) } : null)),
    external: list(j.external, (x) => (s(x.what) ? { what: s(x.what), how: s(x.how), data: s(x.data), code: s(x.code) } : null)),
    permissions: list(j.permissions, (x) => (s(x.name) ? { name: s(x.name), why: s(x.why) } : null)),
    limits: strs(j.limits),
    changes: strs(j.changes),
  };
}

export const SPEC_SYSTEM = [
  "너는 워크스페이스 앱의 코드를 읽고, 그 앱이 실제로 어떻게 돌아가는지 한국어 명세로 옮기는 사람이다.",
  "읽는 사람은 앱을 만든 비개발자와 팀원이다. 고등학생도 이해할 쉬운 말로 쓰되, 무엇을 쓰는지는 정확한 이름(API 경로 · 함수 · 표 · 칸 · 모델 이름)을 code 칸에 남긴다.",
  "코드가 정본이다. 코드에 있는 것만 쓴다. 코드로 알 수 없는 것(예: 바깥 AI 가 속에서 무엇을 쓰는지)은 «코드로는 알 수 없어요» 라고 쓰고 지시문에 적힌 내용은 그렇게 적혀 있다고 쓴다.",
  "라이블리 앱 화면은 같은 주소 API(/_lively/store · /_lively/tools · /_lively/ai/runs · /_lively/me · /_lively/prefs)와 화면 SDK(lively.store · lively.tools.call · lively.chat.send · lively.ai)로 라이블리를 부른다. /_lively/ai/runs 는 워크스페이스 AI 계정으로 AI 를 돌리는 입구다(agent:true 면 작업 컨테이너의 AI 에이전트, 아니면 한 번 묻고 답 받기).",
  "글 규칙: 문장은 짧게. 줄표(—)를 쓰지 않는다. 가운뎃점(·)으로 여러 절을 잇지 않는다. 존댓말 «~해요» 체.",
  "답은 JSON 하나만 낸다. 앞뒤에 다른 말을 붙이지 않는다.",
].join("\n");

const SHAPE = `{
  "summary": "이 앱이 무엇을 하는지 두세 문장",
  "screens": [{"name": "화면 이름", "where": "세션 옆 / 앱 화면", "what": "그 화면에서 보이는 것과 할 수 있는 것"}],
  "data": [{"name": "표 이름(코드 그대로)", "what": "무엇을 담는 표인지", "fields": [{"name": "칸 이름(코드 그대로)", "what": "그 칸의 뜻과 값의 꼴"}]}],
  "features": [{"name": "기능 이름", "steps": ["사람이 누르면 일어나는 일을 차례로 한 줄씩"], "code": "그 기능이 있는 파일과 함수 이름"}],
  "external": [{"what": "바깥과 주고받는 일(예: 음성 받아쓰기)", "how": "무엇을 써서 하는지(API 경로 · 서비스 · 모델 · 방식)", "data": "무엇이 나가고 무엇이 돌아오는지", "code": "그 호출이 있는 파일과 함수"}],
  "permissions": [{"name": "권한 이름", "why": "이 앱이 그 권한으로 하는 일"}],
  "limits": ["코드에서 보이는 한계나 주의할 점"],
  "changes": ["직전 명세와 비교해 이번 코드에서 달라진 점(직전 명세가 없으면 빈 목록)"]
}`;

/** (순수) 설명을 쓰라는 글. 직전 설명이 있으면 같이 실어 바뀌지 않은 부분은 같은 말로 두고 달라진 점을 따로 적게 한다. */
export function specPrompt(o: {
  title: string; appId: string; versionNo: number | null; facts: SpecFacts; input: ReturnType<typeof specInput>;
  prev: { versionNo: number | null; doc: AppSpecDoc } | null;
}): string {
  const out: string[] = [];
  out.push(`앱 「${o.title}」(id ${o.appId})${o.versionNo != null ? ` ${o.versionNo}버전` : ""}의 코드를 읽고 명세를 써 줘.`);
  out.push("");
  out.push("코드에서 기계로 찾은 바깥 호출(참고용 · 빠진 것이 있으면 코드를 따른다):");
  out.push(o.facts.calls.length ? o.facts.calls.map((c) => `- ${c.kind} ${c.name} (${c.count}곳, 예: ${c.where.map((w) => w.file + ":" + w.line).join(", ")})`).join("\n") : "- 없음");
  if (o.input.truncated.length) out.push(`\n길이 상한 때문에 다음 파일은 일부만 실었어(뒤쪽을 모르면 모른다고 써): ${o.input.truncated.join(", ")}`);
  if (o.input.skipped.length) out.push(`\n글이 아닌 파일(내용 없음): ${o.input.skipped.join(", ")}`);
  if (o.prev) {
    out.push("");
    out.push(`직전 명세(${o.prev.versionNo != null ? o.prev.versionNo + "버전 기준" : "이전 코드 기준"}). 코드가 그대로인 부분은 이 말을 그대로 두고, 달라진 부분만 고쳐. 달라진 점은 changes 에 적어:`);
    out.push(JSON.stringify(o.prev.doc));
  }
  out.push("");
  out.push("답의 꼴(JSON 하나, 칸 이름 그대로):");
  out.push(SHAPE);
  out.push("");
  out.push("코드:");
  out.push(o.input.text);
  return out.join("\n");
}

/** 명세 행의 열쇠 — 판의 코드 지문. 지문이 없는 옛 판은 판 번호로. */
export function specKeyOf(contentHash: string | null | undefined, versionNo: number | null | undefined): string {
  const h = String(contentHash ?? "").trim();
  return h ? h : "v" + String(versionNo ?? 0);
}

export interface SpecRow {
  content_hash: string; version_no: number | null; status: "running" | "ok" | "failed";
  /** 설명이 있나 — 목록은 설명 본문 없이 읽는다(화면이 6초마다 묻는다). 보일 한 줄만 본문을 따로 읽는다(app-spec-store.getAppSpecDoc). */
  has_spec: boolean; error: string | null; started_at: number; made_at: number | null; model: string | null;
}
export const SPEC_RUNNING_STALE_MS = 10 * 60_000;

/**
 * (순수) 보는 판의 명세를 어떻게 보일까. rows = 이 앱의 명세 행(아무 순서).
 *  show = 보일 설명 · stale = 보는 판 것이 아니라 그 앞 판의 것 · kick = 지금 새로 쓰기 시작할까 · writing = 쓰는 중 · failed = 보는 판의 실패 까닭.
 *  보는 판 것이 없을 때 대신 보이는 설명은 **보는 사람이 볼 수 있는 판(visible)이고 보는 판보다 앞선 판**의 것만이다 — 남의 공개 전 판(isOthersPendingVersion ·
 *   격리 리뷰 NB-6)을 읽고 쓴 설명이 새지 않게(격리 리뷰 #4632). 실패는 저절로 다시 쓰지 않는다(열 때마다 돈이 나가지 않게) — 사람이 「다시 만들기」 를 누른다.
 *  쓰는 중이 10분을 넘으면 죽은 것으로 보고 다시 쓴다. 오늘 쓸 수 있는 몫을 다 썼으면(o.budget false) 새로 쓰지 않는다(limit).
 */
export function decideSpec(key: string, versionNo: number | null, rows: ReadonlyArray<SpecRow>, o: { now: number; available: boolean; visible: ReadonlySet<number>; budget: boolean }): {
  show: SpecRow | null; stale: boolean; kick: boolean; writing: boolean; failed: string | null; unavailable: boolean; limit: boolean;
} {
  const mine = rows.find((r) => r.content_hash === key) || null;
  const before = (r: SpecRow): boolean => r.version_no != null && o.visible.has(r.version_no) && (versionNo == null || r.version_no < versionNo);
  const lastOk = rows.filter((r) => r.status === "ok" && r.has_spec && r.content_hash !== key && before(r)).sort((a, b) => (b.version_no ?? 0) - (a.version_no ?? 0))[0] || null;
  const none = { stale: !!lastOk, kick: false, writing: false, failed: null, unavailable: false, limit: false };
  if (mine && mine.status === "ok" && mine.has_spec) return { ...none, show: mine, stale: false };
  if (!o.available) return { ...none, show: lastOk, unavailable: true };
  const deadRun = !!mine && mine.status === "running" && o.now - mine.started_at > SPEC_RUNNING_STALE_MS;
  const failed = mine && mine.status === "failed" ? (mine.error || "설명을 쓰지 못했어요") : null;
  if (failed) return { ...none, show: lastOk, failed };
  const kick = !mine || deadRun;
  if (kick && !o.budget) return { ...none, show: lastOk, limit: true };
  return { ...none, show: lastOk, kick, writing: true };
}
