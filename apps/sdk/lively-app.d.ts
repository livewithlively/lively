// 라이블리 앱 SDK 타입 — 앱 UI 안에서 쓰는 `window.lively` (#1780).
//  런타임은 **호스트가 iframe 에 자동 주입**한다(설치·번들 불요 — 앱 UI 는 CSP 로 외부 스크립트가 막혀 있다).
//  이 파일은 타입만 준다: 앱을 TypeScript 로 쓸 때 `/// <reference path="./lively-app.d.ts" />` 하거나 tsconfig include.
//  ⚠ 앱 화면은 `sandbox="allow-scripts"` 라 **폼 제출이 막힌다** — submit 이벤트조차 안 온다(onsubmit 핸들러가 안 불린다).
//   입력은 버튼 click · 입력칸 keydown(Enter — 한글 조합 중 e.isComposing 이면 넘긴다)으로 받는다(#4225 실측).
declare global {
  interface Window { lively: LivelyApp }
}

/** 앱 UI ↔ 라이블리 호스트 다리. 모든 호출은 **그 앱의 grant 범위 안에서만** 서버가 재판정해 실행한다. */
export interface LivelyApp {
  readonly version: 1;
  /** 이 UI 를 띄운 앱 id (ready 이후 채워진다). */
  readonly app: string | null;
  /** 이 UI를 띄운 실행 인스턴스 id. 구 호스트/모달이면 null. */
  readonly instance: string | null;
  /** 지금 페이지 key (ui.pages[].key). */
  readonly page: string | null;
  /** 이 화면이 붙은 세션 id — 세션 오른쪽 앱 칸에서 열렸을 때(#4225). 그 세션의 AI 도 이 앱의 데이터를 쓴다. 아니면 null. */
  readonly session: string | null;
  /** 핸드셰이크 완료 — 앱 시작 시 한 번 await 하면 app/page/session 이 채워져 있다. */
  readonly ready: Promise<{ host: string; app: string; instance: string | null; page: string | null; session: string | null; capabilities: { tools: boolean } }>;

  tools: {
    /** 라이블리 도구 호출. 매니페스트 permissions.tools 안 + 사용자 grant 안이어야 한다(아니면 code -32001 로 reject). */
    call<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
  };

  /** 이 앱 전용 데이터 테이블(app.<앱id>__<표>) — 매니페스트 data.tables 로 선언한 것만. 테넌트 격리는 서버가 한다. */
  store: {
    tables(): Promise<Array<{ name: string; columns: Array<{ name: string; type: string }>; indexes?: Array<{ columns: string[]; unique?: boolean }> }>>;
    query<T = Record<string, unknown>>(table: string, opts?: { match?: Record<string, unknown>; limit?: number }): Promise<T[]>;
    insert(table: string, row: Record<string, unknown>): Promise<{ id: string | number | null }>;
    /** match 에는 선언한 칸과 시스템 칸 `id` · `created_at` 을 쓸 수 있다 — 한 행만 고치려면 `{ id }`(insert 가 돌려준 값). set 에는 선언한 칸만. */
    update(table: string, match: Record<string, unknown>, set: Record<string, unknown>): Promise<{ changed: number }>;
    /** ⚠ match 는 필수다(전량 삭제 방지). */
    delete(table: string, match: Record<string, unknown>): Promise<{ deleted: number }>;
    /**
     * SQL 한 문장(#4226) — SELECT·INSERT·UPDATE·DELETE. 테이블은 매니페스트에 선언한 이름 그대로(`FROM contacts`),
     *  값은 `$1`·`$2` … 자리에 params 로 넘긴다(문자열을 이어 붙이지 마라). 매니페스트 permissions.tools 에 `store_sql` 이 있어야 한다.
     *  받지 않는 것: 표·칸 만들기(매니페스트로) · 조건 없는 UPDATE/DELETE · 주석 · 세미콜론 · 백슬래시 · 스키마 붙인 이름.
     *  결과는 최대 5,000행·5MB(넘으면 truncated), 문장 5초. 워크스페이스가 만든 앱에서만(기본 앱은 안 된다).
     */
    sql<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{
      kind: "select" | "insert" | "update" | "delete";
      columns: string[];
      rows: T[];
      row_count: number;
      truncated: boolean;
      /** 쓰기가 바꾼 행 수(SELECT 는 null). */
      changed: number | null;
      ms: number;
    }>;
    /**
     * 이 앱의 데이터가 바뀌었다(#4225) — 세션에 붙은 AI 가 썼거나 다른 화면에서 썼다. 받으면 필요한 표를 다시 읽는다.
     *  source 는 누가 썼나의 표면(mcp = 세션의 AI · app-ui = 앱 화면 · web = 스크립트). 돌려주는 함수를 부르면 끊는다.
     *  ⚠ 이걸 걸지 않은 앱은 바깥에서 데이터가 바뀌면 호스트가 화면을 **다시 불러온다**(입력 중인 글·스크롤이 처음으로 돌아간다).
     *   화면 상태를 지키려면 걸고 스스로 다시 읽어라.
     */
    onChange(cb: (ev: { table: string | null; op: "insert" | "update" | "delete" | null; source: string | null; session: string | null }) => void): () => void;
  };

  ui: {
    /** 새 탭으로 연다 — 샌드박스 안에선 앱이 직접 못 하는 일을 호스트가 대신한다(http/https 만). */
    openExternal(url: string): Promise<{ opened: boolean }>;
    /**
     * 사람이 앱 탭의 ⋯ 메뉴에서 「표시 설정」을 눌렀다(#4601) — 앱이 설정 패널을 연다. 돌려주는 함수를 부르면 끊는다.
     *  설정 값 자체는 lively.prefs 에 두면 다른 기기에서 열어도 그대로다.
     */
    onPrefsOpen(cb: () => void): () => void;
    /**
     * 호스트가 이 화면의 가장자리를 가리는 폭(px) — 지금은 세션 사이드바 아래의 독이 바닥을 가릴 때 bottom 이 선다(#4592).
     *  같은 값이 CSS 변수 `--lively-inset-top` · `-right` · `-bottom` · `-left` 로도 심긴다. 바닥에 붙인 단추와 스크롤의 끝을 그만큼 올리면
     *  가려지지 않는다: `padding-bottom: calc(12px + var(--lively-inset-bottom, 0px))`. 호스트가 알린 적이 없으면 전부 0.
     */
    insets: { top: number; right: number; bottom: number; left: number };
    /** 가려진 폭이 바뀌었다(독을 옮겼다 · 크기를 바꿨다). 돌려주는 함수를 부르면 끊는다. CSS 변수만 쓰면 구독하지 않아도 된다. */
    onInsets(cb: (i: { top: number; right: number; bottom: number; left: number }) => void): () => void;
  };

  /**
   * 이 화면이 붙은 세션의 **프로젝트 자료**(사이드바 「자료」 — 프로젝트 공유 폴더)에서 파일 읽기(#4592). 읽기뿐이다(쓰기는 앱 표 store_* 로).
   *  · 매니페스트에 읽을 확장자를 선언한다: `permissions.project_files: ["html"]`(점 없이 소문자 · 동의 창에 「프로젝트 자료 읽기」로 보인다).
   *  · 세션에 붙어 열린 화면에서만 된다(lively.session 이 있을 때). 붙은 세션이 없으면 reject(code -32602).
   *  · 세션이 프로젝트에 속해 있지 않거나 그 사람이 그 프로젝트를 볼 수 없으면 빈 목록 — 오류가 아니다.
   *  · 숨김 파일(점으로 시작)과 git 레포 폴더 안은 목록에 없다.
   */
  files: {
    /** 선언한 확장자의 파일들, **최신순**. ext 로 선언한 것 가운데 고르고(생략 = 전부), limit 기본 200 · 최대 500. */
    list(opts?: { ext?: string[]; limit?: number }): Promise<{ project_id: number | null; files: Array<{ path: string; name: string; size: number; mtime: string }>; truncated: boolean }>;
    /** 한 파일의 글 내용(UTF-8). path 는 list 가 준 상대경로. 선언하지 않은 확장자는 reject(-32001), 8MB 초과 · 없는 파일도 reject. */
    read(path: string): Promise<{ path: string; content: string; size: number; mtime: string }>;
  };

  /** 이 화면이 붙은 세션과 말하기(#4594). 세션 오른쪽 앱 칸에서 열렸을 때만(lively.session 이 있을 때) 된다. */
  chat: {
    /**
     * 붙은 세션에 글을 **바로 보낸다**(채우기가 아니다 — 사람이 Enter 를 치지 않는다). 서버가 글 앞에 「(앱 「제목」에서 보냄)」 한 줄을 붙여
     *  대화 기록에서 사람이 친 말과 구별되고, 세션의 AI 는 그 표식으로 이 앱의 지침을 다시 받는다.
     *  · 긴 내용은 앱 표(store_*)에 두고 **한 줄**만 보낸다(4,000자 · 앱마다 분당 20회).
     *  · 앱은 매니페스트에 `permissions.chat_send: true` 를 선언해야 하고(동의 창에 「세션에 글 보내기」로 보인다), 사람이 그 범위에 동의해야 한다.
     *  · **사람이 누른 동작(click·keydown) 안에서만** 보낼 수 있다 — 타이머나 데이터 변경 콜백에서 부르면 reject(code -32001).
     *  · 세션이 멈춰 있으면 reject 하지 않고 `{ sent:false, draft }` — draft=true 면 호스트가 그 세션 화면의 입력칸에 글을 넣어 두었다
     *    (사람이 보내면 세션이 깨어난다), false 면 그 세션 화면이 떠 있지 않아 못 넣었다(앱이 「세션 화면을 열고 다시」 라고 말하면 된다).
     *  · 붙은 세션이 없으면 reject(code -32602).
     */
    send(text: string): Promise<{ sent: boolean; session: string; transport?: string | null; draft?: boolean }>;
  };

  /**
   * 이 앱 × **보는 사람**의 작은 설정(#4601 — 배치 2열/2행 · 글자 크기 · 접기 · 마지막으로 보던 장). 다른 사람은 자기 설정을 본다.
   *  왜 여기인가: 앱 화면은 불투명 오리진이라 localStorage 가 SecurityError 로 막히고, 앱 표에 두자니 SDK 에 보는 사람 신원이 없다.
   *  16KB 상한 — 설정이지 데이터가 아니다(문서·행은 store_* 에).
   */
  prefs: {
    /** 없으면 {}. */
    get<T extends Record<string, unknown> = Record<string, unknown>>(): Promise<T>;
    /** 얕은 병합 — patch 의 키만 바뀐다. 값이 null 인 키는 지운다(「기본값으로」). 병합 뒤 전체를 돌려준다. 16KB 초과면 reject. */
    set<T extends Record<string, unknown> = Record<string, unknown>>(patch: Record<string, unknown>): Promise<T>;
  };
}

export {};
