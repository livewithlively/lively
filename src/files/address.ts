// 파일 주소(#4670 · #4673) — 워크스페이스(테넌트) 폴더 기준 경로 하나로 파일을 가리킨다. **순수**(DB·FS 무접근).
//
// ── 주소 모양(#4671 확정 — 지식 file-address-scheme-design-4670 §12) ────────────────────────────
//   · `shared/project/<id>/<경로>` — 프로젝트 파일
//   · `shared/<경로>`              — 그 밖 공유 폴더
//   · `apps/<앱>/<경로>`           — 앱 폴더(테넌트 폴더 맨 위, 공유 폴더 옆)
//  첫 조각 = 링크의 root, 나머지 = path — `#/f?root=<root>&path=<path>`(#1436 링크 그대로 열린다).
//  개인 폴더는 주소를 주지 않는다 — #1436 의 root=personal 링크는 **여는 사람 자신의** 폴더라 남에게 건넬 수 없다.
//
// ── 점으로 시작하는 마디는 주소가 되지 않는다 ─────────────────────────────────────────────────
//  `.lively/` 는 라이블리 예약 자리다(휴지통 · 프로젝트 표식 · 세션에 붙인 앱 폴더 `.lively/apps` — #4684). 웹·API 로 거기에 쓰면
//   세션에 겹쳐 붙인 폴더에 가려지거나 휴지통 장부가 깨진다. 숨김 파일은 웹 목록·자료에도 안 선다. 주소를 지어내 그 자리에 닿는 길을
//   두지 않는다 — 예외는 하나, 세션 안 `<작업 폴더>/.lively/apps/<앱>/x` 는 그 앱 폴더의 주소 `apps/<앱>/x` 로 접힌다(아래 변환).
//
// ── 세션 안 경로 ↔ 주소 ─────────────────────────────────────────────────────────────────────
//  세션이 어디서 도느냐(SessionPlace)에 따라 같은 주소가 다른 경로로 보인다:
//   · container — 매니지드 세션 컨테이너. 작업 폴더(+ 멤버 홈)만 붙어 있다 → 그 밖의 주소는 «이 세션엔 없다»(까닭과 함께).
//   · host      — 게이트웨이와 같은 파일 시스템(셀프호스트). 자리 기준 경로(bases)가 곧 세션이 보는 경로다.
//   · node      — 사람 컴퓨터. 공유 자리를 서버가 모르니 프로젝트 세션의 작업 폴더에서 접는다(`…/project/<id>` 규약 —
//                 terminal/node-upload-coord.ts 와 같은 규칙).
//  판정(누가 무엇을 열 수 있나)은 여기서 하지 않는다 — 이 모듈은 글자만 다룬다.
import path from "node:path";

export type AddressRoot = "shared" | "apps";
export const ADDRESS_ROOTS: readonly AddressRoot[] = ["shared", "apps"];

/** 주소 한 개 — root + 그 자리 기준 상대경로(`""` = 자리 자신). rel 은 늘 `/` 구분 · 앞뒤 `/` 없음. */
export interface FileAddress { root: AddressRoot; rel: string }

/** 주소 글자 수 상한. 경로 한 개가 이보다 길 일은 없다(파일 시스템 PATH_MAX 4096 바이트의 한글 기준 여유). */
export const ADDRESS_MAX = 1024;
/** 앱 id 규칙 — apps/manifest.ts APP_ID_RE 와 같은 자(이 모듈은 순수라 manifest 를 끌어오지 않는다 · 시험이 둘을 대조한다). */
export const ADDRESS_APP_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
/** 세션 작업 폴더 안에서 앱 폴더를 붙이는 자리(#4671 §8 · #4684). */
export const SESSION_APP_FOLDER_REL = ".lively/apps";

/** 주소가 틀렸다 — 왜 틀렸는지 사람(과 AI)에게 그대로 보일 문장을 싣는다. 호출부가 400 으로 바꾼다. */
export class AddressError extends Error {
  constructor(message: string) { super(message); this.name = "AddressError"; }
}

const bad = (why: string): never => { throw new AddressError(why); };
const SHAPE_HINT = "주소는 `shared/project/<번호>/<경로>` · `shared/<경로>` · `apps/<앱>/<경로>` 꼴입니다";

/**
 * 주소 글자 → FileAddress. 틀리면 AddressError(까닭).
 *  · 앞의 `/` 하나는 떼고, 끝의 `/` 하나는 받는다(폴더를 가리킬 때).
 *  · 빈 마디(`a//b`) · `.` · `..` · 점으로 시작하는 마디 · 역슬래시 · 제어 문자는 받지 않는다.
 *  · apps 의 둘째 마디는 앱 id 여야 한다.
 *  ⚠ 유니코드 정규화(NFC)는 하지 않는다 — 예전에 NFD 로 저장된 파일을 읽을 수 있어야 한다. 새로 만드는 쪽(PUT)이 따로 NFC 로 맞춘다.
 */
export function parseAddress(raw: unknown): FileAddress {
  if (typeof raw !== "string") return bad("주소가 비었습니다 — " + SHAPE_HINT);
  let s = raw.trim();
  if (!s) return bad("주소가 비었습니다 — " + SHAPE_HINT);
  if (s.length > ADDRESS_MAX) return bad(`주소가 너무 깁니다(${ADDRESS_MAX}자까지)`);
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(s)) return bad("주소에 쓸 수 없는 글자(역슬래시 · 제어 문자)가 있습니다");
  if (s.startsWith("/")) s = s.slice(1);
  if (s.endsWith("/")) s = s.slice(0, -1);
  const segs = s.split("/");
  if (segs.some((x) => x === "")) return bad("주소에 빈 마디(`//`)가 있습니다 — " + SHAPE_HINT);
  if (segs.some((x) => x === "." || x === "..")) return bad("주소에 `.` · `..` 마디는 쓸 수 없습니다");
  if (segs.some((x) => x.startsWith("."))) return bad("점으로 시작하는 자리(숨김 · 라이블리 예약 `.lively` 등)는 주소가 없습니다");
  const [root, ...rest] = segs;
  if (root !== "shared" && root !== "apps") {
    if (root === "personal") return bad("개인 폴더는 주소가 없습니다 — 남에게 건넬 수 없는 자리라서입니다");
    return bad(`모르는 자리 '${root}' — ` + SHAPE_HINT);
  }
  if (root === "apps" && rest.length && !ADDRESS_APP_ID_RE.test(rest[0]!)) {
    return bad(`'${rest[0]}' 은(는) 앱 id 가 아닙니다(소문자 · 숫자 · '-' 2~32자)`);
  }
  return { root, rel: rest.join("/") };
}

/** FileAddress → 주소 글자. parseAddress 의 역(왕복하면 같은 값). */
export function formatAddress(a: FileAddress): string {
  return a.rel ? `${a.root}/${a.rel}` : a.root;
}

/** 링크(해시 경로) — 웹 라우터가 받는 꼴(web/lib/sharelink.ts fileLinkHash 와 같은 모양). 절대 주소는 호출부가 base 를 붙인다. */
export function addressLinkHash(a: FileAddress): string {
  return "#/f?root=" + encodeURIComponent(a.root) + "&path=" + encodeURIComponent(a.rel);
}

/** apps 주소의 앱과 그 안 경로. apps 가 아니거나 앱 마디가 없으면 null. */
export function appOfAddress(a: FileAddress): { app: string; rest: string } | null {
  if (a.root !== "apps" || !a.rel) return null;
  const i = a.rel.indexOf("/");
  return i < 0 ? { app: a.rel, rest: "" } : { app: a.rel.slice(0, i), rest: a.rel.slice(i + 1) };
}

// ── 입력 꼴 — 주소 · 링크 · 자료 좌표 · 첨부 표시를 다 받는다(#4671 §12 «도구는 두 꼴을 다 받는다») ─────────
export type AddressInput =
  | { kind: "address"; address: FileAddress }
  /** 자료 좌표 `project:<id>/<경로>` — 프로젝트 폴더를 DB 에서 찾아야 주소가 된다(호출부 몫). */
  | { kind: "project-ref"; projectId: number; rel: string }
  /** 개인 폴더(자료 좌표 `personal:<멤버>/…` · 링크 root=personal) — 주소가 없다. */
  | { kind: "personal" };

/**
 * 사람·AI 가 건넨 «파일을 가리키는 글자» 를 가린다. 받는 꼴:
 *  · 주소 `shared/…` · `apps/…`
 *  · 링크 `#/f?root=…&path=…`(앞에 웹 주소가 붙어 있어도 된다)
 *  · 자료 좌표 `project:12/a.png` · `personal:<멤버>/x` · `shared/x`(local-file-core localExternalId 꼴)
 *  · 첨부 표시 `[lively:project:12/a.png]`(#3787 컴포저가 지시문에 적는 꼴)
 */
export function parseAddressInput(raw: unknown): AddressInput {
  if (typeof raw !== "string") return parseAsAddress(raw);
  let s = raw.trim();
  const mark = /^\[?lively:([^\]]+)\]?$/.exec(s);
  if (mark) s = mark[1]!.trim();
  const hashAt = s.indexOf("#/f?");
  if (hashAt >= 0) {
    const q = new URLSearchParams(s.slice(hashAt + 4).split("#")[0]);
    const root = q.get("root") ?? "";
    if (root === "personal") return { kind: "personal" };
    return parseAsAddress(`${root}/${q.get("path") ?? ""}`);
  }
  const pm = /^project:(\d{1,9})\/(.+)$/.exec(s);
  if (pm) {
    const rel = parseAddress(`shared/${pm[2]}`).rel;   // 같은 마디 규칙(점 · .. · 빈 마디)을 태운다
    return { kind: "project-ref", projectId: Number(pm[1]), rel };
  }
  if (/^personal:[^/]*\//.test(s)) return { kind: "personal" };
  return parseAsAddress(s);
}

function parseAsAddress(s: unknown): AddressInput {
  return { kind: "address", address: parseAddress(s) };
}

// ── 세션 안 경로 ↔ 주소 ─────────────────────────────────────────────────────────────────────

export type SessionPlace = "container" | "host" | "node";

/** 변환에 쓰는 세션의 모습 — 호출부(capabilities/files.ts)가 세션 행·자리 해석에서 채운다. */
export interface SessionView {
  place: SessionPlace;
  /** 세션 작업 폴더(세션 안 절대경로). node 면 그 컴퓨터의 경로(윈도우면 `C:\…`). */
  dir: string;
  /** container · host: 자리마다 **세션이 보는** 기준 경로(resolveRootPath 와 같은 값). node 는 비운다. */
  bases?: Partial<Record<"shared" | "personal" | "apps", string>>;
  /** node: 이 세션의 프로젝트(작업 폴더가 그 프로젝트 폴더일 때만 공유 자리를 접을 수 있다). */
  projectId?: number | null;
  /** 이 세션에 지금 붙은 앱(org_session_app). */
  attachedApps?: readonly string[];
}

export type PathToAddress = { address: FileAddress; reason?: undefined } | { address: null; reason: string };
export type AddressToPath = { path: string; reason?: undefined } | { path: null; reason: string };

/** 경로를 `/` 구분 · 정규화된 절대경로로(윈도우 드라이브 경로 포함). 절대경로가 아니면 null. */
function normAbs(p: string): string | null {
  const s = String(p ?? "").trim().replace(/\\/g, "/");
  const isWin = /^[A-Za-z]:\//.test(s);
  if (!isWin && !s.startsWith("/")) return null;
  const n = path.posix.normalize(s);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

/** base 안이면 base 기준 상대경로(`""` = base 자신), 밖이면 null. 형제 디렉터리(`<base>-x`)를 안으로 오검출하지 않는다. */
function relUnder(base: string, abs: string): string | null {
  const b = base === "/" ? "" : base;
  if (abs === base) return "";
  return abs.startsWith(b + "/") ? abs.slice(b.length + 1) : null;
}

/** 노드 세션의 공유 자리 — 작업 폴더가 `<공유 자리>/project/<id>[/하위]` 일 때만(terminal/node-upload-coord 와 같은 규약). */
function nodeSharedRoot(view: SessionView): string | null {
  const dir = normAbs(view.dir);
  const pid = Number(view.projectId ?? 0);
  if (!dir || !Number.isInteger(pid) || pid <= 0) return null;
  const m = /\/(?:project|legacy-project)\/(\d+)(?:\/.*)?$/.exec(dir);
  if (!m || Number(m[1]) !== pid) return null;
  return dir.slice(0, m.index) || "/";
}

/** 상대경로 마디에 점 마디가 있나(주소가 될 수 없다). */
const hasDotSeg = (rel: string): boolean => rel !== "" && rel.split("/").some((x) => x.startsWith("."));

/**
 * 세션 안 경로 → 주소. 주소가 없으면 까닭.
 *  · 붙인 앱 폴더 `<작업 폴더>/.lively/apps/<앱>/x` → `apps/<앱>/x`(그 앱이 지금 붙어 있을 때만 — 안 붙었으면 그 자리는 앱 폴더가 아니다)
 *  · container · host: 자리 기준 경로 중 **가장 깊은** 것이 이긴다(profiles.pickRootCoord 와 같은 까닭 — 중첩 설정에서 개인 파일이
 *    공유 주소로 새지 않게).
 *  · node: 공유 자리(`…/project/<id>` 앞부분) 아래면 `shared/…`.
 */
export function sessionPathToAddress(view: SessionView, rawPath: string): PathToAddress {
  const abs = normAbs(rawPath);
  if (!abs) return { address: null, reason: "절대경로가 아닙니다 — 세션 안 경로를 `/` 부터 적어 주세요" };
  const dir = normAbs(view.dir);
  if (dir) {
    const inApps = relUnder(`${dir}/${SESSION_APP_FOLDER_REL}`, abs);
    if (inApps !== null && inApps !== "") {
      const [app, ...rest] = inApps.split("/");
      if (!ADDRESS_APP_ID_RE.test(app!) || !(view.attachedApps ?? []).includes(app!)) {
        return { address: null, reason: `이 세션에 붙지 않은 앱 자리입니다(${SESSION_APP_FOLDER_REL}/${app}) — 앱을 붙이면 그 앱 폴더가 이 자리에 보입니다` };
      }
      const r = rest.join("/");
      if (hasDotSeg(r)) return { address: null, reason: "점으로 시작하는 자리(숨김 · 예약)는 주소가 없습니다" };
      return { address: { root: "apps", rel: r ? `${app}/${r}` : app! } };
    }
  }
  if (view.place === "node") {
    const root = nodeSharedRoot(view);
    if (!root) return { address: null, reason: "이 컴퓨터의 공유 자리를 알 수 없습니다 — 프로젝트 폴더에서 연 세션에서만 주소로 바꿀 수 있습니다" };
    const rel = relUnder(root, abs);
    if (rel === null) return { address: null, reason: `공유 자리(${root}) 밖의 경로입니다 — 주소가 없습니다` };
    if (hasDotSeg(rel)) return { address: null, reason: "점으로 시작하는 자리(숨김 · 예약)는 주소가 없습니다" };
    return { address: { root: "shared", rel } };
  }
  let best: { key: string; rel: string; depth: number } | null = null;
  for (const [key, base] of Object.entries(view.bases ?? {})) {
    const b = base ? normAbs(base) : null;
    if (!b) continue;
    const rel = relUnder(b, abs);
    if (rel === null || (best && b.length <= best.depth)) continue;
    best = { key, rel, depth: b.length };
  }
  if (!best) return { address: null, reason: "공유 폴더 · 앱 폴더 밖의 경로입니다 — 주소가 없습니다" };
  if (best.key === "personal") return { address: null, reason: "개인 폴더의 파일은 주소가 없습니다 — 남에게 건넬 수 없는 자리라서입니다" };
  if (hasDotSeg(best.rel)) return { address: null, reason: "점으로 시작하는 자리(숨김 · 예약)는 주소가 없습니다" };
  if (best.key === "apps" && best.rel && !ADDRESS_APP_ID_RE.test(best.rel.split("/")[0]!)) {
    return { address: null, reason: "앱 폴더 자리 안이지만 앱 id 가 아닌 폴더입니다 — 주소가 없습니다" };
  }
  return { address: { root: best.key as AddressRoot, rel: best.rel } };
}

/**
 * 주소 → 이 세션 안 경로. 이 세션에서 파일로 안 보이면 까닭(«file_url 로 받으세요» 등 다음 할 일 포함).
 *  · apps: 그 앱이 붙어 있으면 `<작업 폴더>/.lively/apps/<앱>/…` · host 면 앱 폴더 자리 그대로 · 그 밖은 없음.
 *  · shared: container 는 작업 폴더 아래일 때만(컨테이너엔 작업 폴더만 붙는다) · host 는 공유 자리 그대로 · node 는 공유 자리를 접어서.
 */
export function addressToSessionPath(view: SessionView, a: FileAddress): AddressToPath {
  const dir = normAbs(view.dir);
  const app = appOfAddress(a);
  if (a.root === "apps") {
    if (!app) return { path: null, reason: "앱 폴더 전체는 세션에 붙지 않습니다 — `apps/<앱>/…` 로 앱을 골라 주세요" };
    if (dir && (view.attachedApps ?? []).includes(app.app) && view.place !== "node") {
      return { path: joinSep(`${dir}/${SESSION_APP_FOLDER_REL}/${app.app}`, app.rest) };
    }
    if (view.place === "host" && view.bases?.apps) {
      return { path: joinSep(`${normAbs(view.bases.apps)}/${app.app}`, app.rest) };
    }
    if (view.place === "node") return { path: null, reason: "사람 컴퓨터에서 도는 세션엔 앱 폴더가 붙지 않습니다 — file_url 로 받으세요" };
    return { path: null, reason: `이 세션에 앱 '${app.app}' 이(가) 붙어 있지 않습니다 — 세션에 앱을 붙이거나 file_url 로 받으세요` };
  }
  if (view.place === "node") {
    const root = nodeSharedRoot(view);
    if (!root) return { path: null, reason: "이 컴퓨터의 공유 자리를 알 수 없습니다 — 프로젝트 폴더에서 연 세션에서만 경로로 바꿀 수 있습니다" };
    return { path: nodeSep(view.dir, joinSep(root, a.rel)) };
  }
  const base = view.bases?.shared ? normAbs(view.bases.shared) : null;
  if (!base) return { path: null, reason: "이 세션에선 공유 폴더 자리를 알 수 없습니다 — file_url 로 받으세요" };
  const p = joinSep(base, a.rel);
  if (view.place === "container" && dir && relUnder(dir, p) === null) {
    return { path: null, reason: `이 세션에는 작업 폴더(${dir})만 붙어 있어 그 밖의 파일은 보이지 않습니다 — file_url 로 받거나 그 폴더에서 세션을 여세요` };
  }
  return { path: p };
}

const joinSep = (base: string, rel: string): string => (rel ? `${base === "/" ? "" : base}/${rel}` : base);
/** 노드 작업 폴더가 윈도우 꼴이면 그 구분자로 되돌린다(그 컴퓨터에서 바로 쓰는 경로). */
const nodeSep = (dir: string, p: string): string => (/\\/.test(dir) && !/\//.test(dir) ? p.replace(/\//g, "\\") : p);
