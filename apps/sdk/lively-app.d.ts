// 라이블리 앱 SDK 타입 — 앱 UI 안에서 쓰는 `window.lively` (#1780).
//  런타임은 **호스트가 iframe 에 자동 주입**한다(설치·번들 불요 — 앱 UI 는 CSP 로 외부 스크립트가 막혀 있다).
//  이 파일은 타입만 준다: 앱을 TypeScript 로 쓸 때 `/// <reference path="./lively-app.d.ts" />` 하거나 tsconfig include.
declare global {
  interface Window { lively: LivelyApp }
}

/** 앱 UI ↔ 라이블리 호스트 다리. 모든 호출은 **그 앱의 grant 범위 안에서만** 서버가 재판정해 실행한다. */
export interface LivelyApp {
  readonly version: 1;
  /** 이 UI 를 띄운 앱 id (ready 이후 채워진다). */
  readonly app: string | null;
  /** 지금 페이지 key (ui.pages[].key). */
  readonly page: string | null;
  /** 핸드셰이크 완료 — 앱 시작 시 한 번 await 하면 app/page 가 채워져 있다. */
  readonly ready: Promise<{ host: string; app: string; page: string | null; capabilities: { tools: boolean } }>;

  tools: {
    /** 라이블리 도구 호출. 매니페스트 permissions.tools 안 + 사용자 grant 안이어야 한다(아니면 code -32001 로 reject). */
    call<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
  };

  /** 이 앱 전용 데이터 테이블(app.<앱id>__<표>) — 매니페스트 data.tables 로 선언한 것만. 테넌트 격리는 서버가 한다. */
  store: {
    tables(): Promise<Array<{ name: string; columns: Array<{ name: string; type: string }> }>>;
    query<T = Record<string, unknown>>(table: string, opts?: { match?: Record<string, unknown>; limit?: number }): Promise<T[]>;
    insert(table: string, row: Record<string, unknown>): Promise<{ id: string | number | null }>;
    update(table: string, match: Record<string, unknown>, set: Record<string, unknown>): Promise<{ changed: number }>;
    /** ⚠ match 는 필수다(전량 삭제 방지). */
    delete(table: string, match: Record<string, unknown>): Promise<{ deleted: number }>;
  };

  ui: {
    /** 새 탭으로 연다 — 샌드박스 안에선 앱이 직접 못 하는 일을 호스트가 대신한다(http/https 만). */
    openExternal(url: string): Promise<{ opened: boolean }>;
  };
}

export {};
