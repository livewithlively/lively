// 브라우저 중계 (#4993) — AI 의 브라우저 명령을 **그 사람의 데스크톱 앱 안 브라우저**로 실어 나른다.
//
// ── 무엇을 하나 ───────────────────────────────────────────────────────────────
//  AI(세션의 하네스)가 `browser_*` 툴을 부르면 게이트웨이가 받는다. 그런데 브라우저는 게이트웨이에 없다 —
//  그 사람의 **데스크톱 앱 화면(웹 UI) 안 `<webview>`** 에 있다(#1829 브라우저 서피스). 그래서 게이트웨이는
//  명령을 그 화면으로 밀고(SSE), 화면이 실행한 결과를 받아(POST) 툴의 답으로 돌려준다. 그 사이를 잇는 것이 이 모듈이다.
//   AI ──MCP──▶ 게이트웨이(이 모듈) ──SSE cmd──▶ 데스크톱 앱 화면(web/v2/browser-host.ts) ──▶ <webview>
//                                  ◀──POST reply──
//
// ── 왜 화면으로 미나 (메인 프로세스가 아니라) ─────────────────────────────────
//  실측(Electron 43.8.3, 2026-10-25): 화면 코드(렌더러)에서 `<webview>` 의 capturePage·sendInputEvent·insertText·
//  executeJavaScript 가 전부 된다(클릭 isTrusted=true · 한글 입력 · 스크롤). 그래서 **데스크톱 앱을 다시 배포하지 않고**
//  웹 UI 배포만으로 이 기능이 선다 — 이미 깔린 앱이 그대로 받는다. 지식: lively-browser-ai-control-design-4993.
//
// ── 주소 = «워크스페이스 + 사람» ──────────────────────────────────────────────
//  매니지드는 게이트웨이 한 프로세스가 모든 워크스페이스를 서비스하고, 구성원 아이디는 워크스페이스마다 따로다
//  (notify-bus.ts 머리말 ①②와 같은 사정). 그래서 열쇠는 `<테넌트 slug>|<구성원>` 이다 — 아이디만 쓰면 다른
//  워크스페이스의 같은 아이디(john@a · john@b)가 서로의 브라우저를 부린다.
//
// ── 범위 — 한 프로세스 안(인메모리) ──────────────────────────────────────────
//  알림 버스(v6/notify-bus.ts)와 같은 전제다. SSE 를 물고 있는 것도 MCP 를 받는 것도 같은 프로세스다.
//  여러 인스턴스로 늘면 그때 외부 버스가 필요해진다.
//
// ⚠ 이 모듈은 **명령의 뜻을 모른다.** op·args 는 그대로 나르고, 판정(무엇을 할 수 있나)은 화면이 한다.
//  여기가 지키는 것은 셋뿐이다 — 주소(남의 브라우저로 가지 않는다) · 시간(답이 안 오면 끝낸다) · 끊김(기다리던 것을 깨운다).

/** 화면과 주고받는 규약 판 — 화면이 hello 의 이 값으로 자기가 아는 판인지 본다. */
export const BROWSER_PROTOCOL = 1;

/** 한 사람이 동시에 물 수 있는 화면 수 — 데스크톱 앱 창·여러 컴퓨터. 넘으면 가장 오래된 것을 끊는다. */
export const MAX_HOSTS_PER_KEY = 8;
/** 한 사람 앞으로 동시에 기다릴 수 있는 명령 수 — AI 가 폭주해 화면을 묻어 버리지 않게. */
export const MAX_PENDING_PER_KEY = 24;
/** 화면 id 형식 — 화면이 부팅 때 지은 난수. 열쇠·로그에 쓰이는 값이라 모양을 좁힌다. */
export const HOST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export interface HostInfo {
  /** 화면을 띄운 앱 판(데스크톱 앱 버전) — 진단용. */
  app?: string;
  platform?: string;
}

export interface HostState {
  /** 사람이 마지막으로 이 화면을 만진(보거나 누른) 시각(ms). 여러 화면 중 하나를 고를 때 쓴다. */
  active_at?: number;
  /** 지금 창이 앞에 있나 — 고를 때 1순위. */
  focused?: boolean;
  /** 이 화면이 탭을 쥐고 있는 세션들 — 같은 세션의 명령은 그 탭이 있는 화면으로 간다. */
  sessions?: string[];
}

export interface HostSummary {
  id: string;
  connected_at: number;
  active_at: number;
  focused: boolean;
  sessions: string[];
  app: string | null;
  platform: string | null;
}

/** 화면에 미는 명령 한 건. */
export interface BrowserCmd {
  id: string;
  op: string;
  /** 명령을 낸 세션(x-lively-session) — 화면이 그 세션의 탭을 고른다. 세션 밖 호출이면 null. */
  session: string | null;
  args: Record<string, unknown>;
  /** 이 명령의 시간 한도(ms) — 화면은 받은 때부터 이만큼 지난 명령을 **실행하지 않는다**(AI 는 이미 시간 초과로 들었다 —
   *  늦게 실행하면 AI 가 다시 보낸 것과 겹쳐 두 번 누른다). 절대 시각이 아니라 길이라 두 기계의 시계가 달라도 된다. */
  ttl_ms: number;
}

/** 화면이 돌려준 답. */
export interface BrowserReply {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface Host {
  id: string;
  key: string;
  push: (event: string, data: unknown) => boolean;
  end: () => void;
  connectedAt: number;
  activeAt: number;
  focused: boolean;
  sessions: Set<string>;
  info: HostInfo;
}

interface Pending {
  host: string;
  key: string;
  op: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 사람의 브라우저를 물 수 없는 주체 — 앱 토큰 · 앱 서버(그 사람의 로그인으로 남의 사이트를 부리는 통로가 된다). 라우트(routes.ts)와
 *  툴(capabilities/browser.ts)이 **같은 판정 · 같은 문구**를 쓴다(두 벌이면 한쪽만 고쳐져 갈라진다 — #4993 격리 리뷰). */
export const APP_PRINCIPAL_REFUSAL = "앱 토큰으로는 사람의 브라우저를 부릴 수 없습니다";
export function isAppPrincipal(u: { appId?: unknown; appServer?: unknown } | null | undefined): boolean {
  return !!(u && (u.appId || u.appServer));
}

/** 사람이 읽을 오류 — 무엇이 안 됐고 무엇을 하면 되는지까지 말한다(이 문구가 곧 AI 의 다음 행동이다). */
export class BrowserRelayError extends Error {
  constructor(public code: "no_host" | "timeout" | "disconnected" | "busy" | "host_error", message: string) {
    super(message);
    this.name = "BrowserRelayError";
  }
}

export const NO_HOST_MESSAGE =
  "이 계정으로 연결된 라이블리 데스크톱 앱이 없습니다. 데스크톱 앱을 켜고 로그인해 두면 AI가 그 앱 안의 브라우저를 씁니다 " +
  "(창을 닫아도 트레이에 떠 있으면 됩니다). 웹 브라우저로 연 라이블리 화면에는 이 기능이 없습니다 — 사람에게 데스크톱 앱을 켜 달라고 요청하세요.";

export interface RelayOpts {
  now?: () => number;
  newId?: () => string;
}

export class BrowserRelay {
  private hosts = new Map<string, Host>();
  private pending = new Map<string, Pending>();
  private seq = 0;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(opts: RelayOpts = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.newId = opts.newId ?? (() => `c${Date.now().toString(36)}${(++this.seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  }

  /**
   * 화면 하나를 붙인다. 같은 id 가 이미 있으면(재접속) **옛 연결을 끊고** 새 것으로 갈아 끼운다 —
   *  재접속 직전의 반쯤 죽은 연결로 명령을 밀면 아무도 안 받는다.
   *  ⚠ 같은 id 가 **다른 열쇠**로 오면 옛 것을 건드리지 않고 거절한다(남의 화면 id 를 주워 가로채는 길을 막는다).
   * @returns 떼는 함수(연결이 닫힐 때 라우트가 부른다)
   */
  attach(h: { id: string; key: string; push: Host["push"]; end: Host["end"]; info?: HostInfo }): () => void {
    const prev = this.hosts.get(h.id);
    if (prev && prev.key !== h.key) throw new Error("이 화면 id 는 다른 사람이 쓰고 있습니다");
    if (prev) this.detach(prev.id, "replaced");
    const mine = this.keyHosts(h.key);
    if (mine.length >= MAX_HOSTS_PER_KEY) {
      const oldest = mine.sort((a, b) => a.connectedAt - b.connectedAt)[0];
      this.detach(oldest.id, "evicted");
    }
    const at = this.now();
    const host: Host = {
      id: h.id, key: h.key, push: h.push, end: h.end,
      connectedAt: at, activeAt: at, focused: false, sessions: new Set(), info: h.info ?? {},
    };
    this.hosts.set(h.id, host);
    return () => { if (this.hosts.get(h.id) === host) this.detach(h.id, "closed"); };
  }

  /** 화면을 뗀다 — 그 화면 앞으로 기다리던 명령을 전부 깨운다(조용히 시간 초과까지 매달리지 않게). */
  detach(id: string, reason: "closed" | "replaced" | "evicted"): void {
    const h = this.hosts.get(id);
    if (!h) return;
    this.hosts.delete(id);
    if (reason !== "closed") { try { h.end(); } catch { /* 이미 닫혔다 */ } }
    for (const [cid, p] of this.pending) {
      if (p.host !== id) continue;
      clearTimeout(p.timer);
      this.pending.delete(cid);
      p.reject(new BrowserRelayError("disconnected",
        "브라우저 연결이 끊겼습니다 — 데스크톱 앱 화면이 다시 실렸거나 꺼졌습니다. 잠시 뒤 다시 시도하세요(열려 있던 페이지는 다시 열어야 할 수 있습니다)."));
    }
  }

  /** 화면이 보낸 상태(사람이 만진 시각 · 창이 앞에 있나 · 쥔 세션). 내 열쇠의 화면이 아니면 false. */
  setState(key: string, id: string, st: HostState): boolean {
    const h = this.hosts.get(id);
    if (!h || h.key !== key) return false;
    if (typeof st.active_at === "number" && Number.isFinite(st.active_at)) h.activeAt = Math.min(this.now(), Math.max(h.activeAt, st.active_at));
    if (typeof st.focused === "boolean") { h.focused = st.focused; if (st.focused) h.activeAt = this.now(); }
    if (Array.isArray(st.sessions)) h.sessions = new Set(st.sessions.filter((s) => typeof s === "string" && s.length <= 128).slice(0, 200));
    return true;
  }

  /** 이 사람의 화면들 — 진단·browser_status 용. */
  hostsFor(key: string): HostSummary[] {
    return this.keyHosts(key)
      .sort((a, b) => this.rank(b, null) - this.rank(a, null))
      .map((h) => ({
        id: h.id, connected_at: h.connectedAt, active_at: h.activeAt, focused: h.focused,
        sessions: Array.from(h.sessions), app: h.info.app ?? null, platform: h.info.platform ?? null,
      }));
  }

  /**
   * 명령을 받을 화면을 고른다.
   *  ① 그 세션의 탭을 이미 쥔 화면 — 같은 탭을 이어 써야 한다(다른 화면에 새 탭을 열면 사람이 보던 페이지와 갈라진다).
   *  ② 지금 앞에 있는 창 ③ 사람이 가장 최근에 만진 화면 ④ 가장 최근에 붙은 화면.
   */
  pick(key: string, session: string | null): HostSummary | null {
    const best = this.ranked(key, session)[0];
    return best ? this.hostsFor(key).find((s) => s.id === best.id) ?? null : null;
  }

  /** 그 사람의 화면들을 고를 순서대로(pick 과 call 이 같은 순서를 쓴다). */
  private ranked(key: string, session: string | null): Host[] {
    return this.keyHosts(key).sort((a, b) => this.rank(b, session) - this.rank(a, session));
  }

  /**
   * 명령 한 건을 화면으로 밀고 답을 기다린다.
   * @param timeoutMs 이 안에 답이 없으면 끝낸다(화면이 멈췄거나 페이지가 응답하지 않는 것).
   */
  call(key: string, cmd: { op: string; session: string | null; args?: Record<string, unknown> }, timeoutMs: number): Promise<unknown> {
    const hs = this.keyHosts(key);
    if (!hs.length) return Promise.reject(new BrowserRelayError("no_host", NO_HOST_MESSAGE));
    let mine = 0;
    for (const p of this.pending.values()) if (p.key === key) mine++;
    if (mine >= MAX_PENDING_PER_KEY) {
      return Promise.reject(new BrowserRelayError("busy", `브라우저 명령이 ${mine}건 밀려 있습니다 — 앞의 명령이 끝난 뒤 다시 시도하세요.`));
    }
    const order = this.ranked(key, cmd.session);
    const id = this.newId();
    const ms = Math.max(1_000, Math.min(Number(timeoutMs) || 30_000, 15 * 60_000));
    const frame: BrowserCmd = { id, op: cmd.op, session: cmd.session, args: cmd.args ?? {}, ttl_ms: ms };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new BrowserRelayError("timeout",
          `브라우저가 ${Math.round(ms / 1000)}초 안에 답하지 않았습니다(${cmd.op}) — 페이지가 응답하지 않거나 데스크톱 앱이 멈췄습니다. 상태를 browser_screenshot 으로 확인하세요.`));
      }, ms);
      // unref 하지 않는다 — 기다리는 명령이 있는 동안은 그 기다림이 곧 할 일이다(끝나면 위 콜백·reply·detach 가 지운다).
      //  밀기가 실패한 화면은 끊긴 것이다 — 떼어 내고 **다음 순서의 화면**에 민다(같은 사람의 다른 화면이 살아 있으면 첫 시도가 헛되지 않게).
      for (const host of order) {
        this.pending.set(id, { host: host.id, key, op: cmd.op, resolve, reject, timer });
        let ok = false;
        try { ok = host.push("cmd", frame); } catch { ok = false; }
        if (ok) return;
        this.pending.delete(id);
        this.detach(host.id, "closed");
      }
      clearTimeout(timer);
      reject(new BrowserRelayError("disconnected", "브라우저 연결이 방금 끊겼습니다 — 잠시 뒤 다시 시도하세요."));
    });
  }

  /**
   * 화면이 돌려준 답을 기다리던 명령에 건넨다. **보낸 화면과 받은 화면이 같아야 한다** — 다른 화면(같은 사람이라도)이
   *  남의 명령 id 를 주워 답하면 거절한다. 모르는 id(이미 시간 초과로 끝난 것 포함)면 false.
   */
  reply(key: string, hostId: string, r: BrowserReply): boolean {
    const p = this.pending.get(String(r?.id || ""));
    if (!p || p.key !== key || p.host !== hostId) return false;
    clearTimeout(p.timer);
    this.pending.delete(r.id);
    if (r.ok) p.resolve(r.result ?? null);
    else p.reject(new BrowserRelayError("host_error", String(r.error || "브라우저가 명령을 실행하지 못했습니다").slice(0, 2_000)));
    return true;
  }

  /** 붙어 있는 화면 수(시험·진단). */
  hostCount(): number { return this.hosts.size; }
  /** 기다리는 명령 수(시험·진단). */
  pendingCount(): number { return this.pending.size; }

  private keyHosts(key: string): Host[] {
    const out: Host[] = [];
    for (const h of this.hosts.values()) if (h.key === key) out.push(h);
    return out;
  }

  /** 고르기 점수 — 큰 쪽이 이긴다. 세션 적중 ≫ 앞에 있는 창 ≫ 최근에 만짐 ≫ 최근에 붙음. */
  private rank(h: Host, session: string | null): number {
    const hit = session && h.sessions.has(session) ? 4e15 : 0;
    const front = h.focused ? 2e15 : 0;
    return hit + front + h.activeAt + h.connectedAt / 1e6;
  }
}

/** 프로세스 하나에 하나 — 라우트(화면 쪽)와 능력(AI 쪽)이 같은 인스턴스를 본다. */
export const browserRelay = new BrowserRelay();

/** 중계 열쇠 — `<테넌트 slug | ->|<구성원>`. 단일 테넌트 배포는 slug 가 없으므로 '-'. */
export function relayKey(tenantSlug: string | null | undefined, member: string): string {
  return `${String(tenantSlug || "-")}|${String(member || "")}`;
}
