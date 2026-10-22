// lib/idb-cache.ts — 화면이 «지난번에 받은 것» 을 먼저 그리게 하는 작은 보관함(#4865).
//  프로젝트 보드는 들어올 때마다 목록(1,300건 · 0.9MB)과 세션을 다시 받느라 「프로젝트를 불러오는 중」 이 서 있었다
//  (실측 2026-10-19 맥 크롬: 셸에서 [프로젝트] 누름 → 0.34초 불러오는 중 → 1.07초 보드). 지난 판을 여기서 꺼내 먼저 그리고,
//  새 판은 뒤에서 받아 달라졌을 때만 다시 그린다.
//  · localStorage 가 아니라 IndexedDB 인 이유: 값이 크고(수백 KB~MB) 구조째 넣고 꺼낸다(JSON 문자열화 · 5MB 한도 없음).
//  · 열쇠는 부르는 쪽이 사람 · 워크스페이스로 가른다. 로그아웃은 cacheClear 로 통째로 비운다(core.ts logout).
//  · 어떤 실패도 «없음» 으로 접는다 — 사생활 모드 · 막힌 저장소 · 깨진 DB 여도 화면은 종전처럼 서버에서 받아 그린다.
//  ⚠ 공용층(lib/)이다 — 페이지 모듈을 들이지 않는다(check-imports R28).
const DB = 'lively-view-cache';
const STORE = 'kv';
//  여는 데 이보다 오래 걸리면 기다리지 않는다 — 보관함 때문에 첫 그림이 늦어지면 본말전도다.
const OPEN_BUDGET_MS = 400;

let dbP: Promise<IDBDatabase | null> | null = null;
function openDb(): Promise<IDBDatabase | null> {
  if (dbP) return dbP;
  dbP = new Promise<IDBDatabase | null>((resolve) => {
    let done = false;
    const finish = (db: IDBDatabase | null): void => { if (!done) { done = true; resolve(db); } };
    setTimeout(() => finish(null), OPEN_BUDGET_MS);
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { try { req.result.createObjectStore(STORE); } catch (_) { /* 이미 있다 */ } };
      req.onsuccess = () => finish(req.result);
      req.onerror = () => finish(null);
      req.onblocked = () => finish(null);
    } catch (_) { finish(null); }
  });
  //  못 열었으면 다음 호출이 다시 시도하게 둔다(일시적인 막힘일 수 있다).
  void dbP.then((db) => { if (!db) dbP = null; });
  return dbP;
}

export interface Cached<T> { at: number; v: T }

/** 꺼낸다 — 없거나 못 읽으면 null. */
export async function cacheGet<T>(key: string): Promise<Cached<T> | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => { const r = req.result; resolve(r && typeof r === 'object' && 'v' in r ? (r as Cached<T>) : null); };
      req.onerror = () => resolve(null);
    } catch (_) { resolve(null); }
  });
}

/** 넣는다 — 실패는 조용히 버린다(다음 진입이 서버에서 받으면 그만이다). */
export async function cacheSet<T>(key: string, v: T): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ at: Date.now(), v } as Cached<T>, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch (_) { resolve(); }
  });
}

/** 통째로 비운다 — 로그아웃. 다음 사람이 이 브라우저에서 앞사람의 목록을 «지난 판» 으로 보지 않게. */
export async function cacheClear(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch (_) { resolve(); }
  });
}
