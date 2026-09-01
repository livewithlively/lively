// v2/shell-prefs.ts — 새 셸 개인화의 **정본은 서버**(#2460).
//
// ── 무엇이 문제였나 (상민님 2026-08-31) ─────────────────────────────────────
//  *"좌측 사이드바에 보이는 세션 및 앱 인스턴스 목록이 브라우저 저장된 값이니? 정본으로 뿌려주는 게 맞는
//   듯싶은데. […] 브라우저 여러 개 혹은 앱/브라우저 함께 사용 시 싱크도 안 되니까."*
//
//  목록의 **내용**은 이미 서버 정본이다(main.ts sideInstances ①② — 세션·app_instance). 브라우저에만
//   있던 것은 **사람이 그 목록을 어떻게 정리해 뒀는가**였다 — 고정·치움·묶는 축·접힘·레일 순서·최근 앱.
//   그래서 브라우저를 바꾸거나 앱↔브라우저를 오가면 같은 계정인데 화면이 달랐고, 브라우저 데이터를
//   지우면 통째로 사라졌다. #2402(복원으로 박스 id 가 바뀌면 핀이 풀린 것처럼 보이던 것)도 뿌리가 같다.
//
// ── 방식 — 대시보드(#1129)·구 셸 사이드바(#1227)와 같다 ─────────────────────
//  · **서버가 정본**(member_shell_pref), localStorage 는 **첫 페인트용 캐시**로 남는다.
//    캐시를 없애지 않는 이유: 서버 왕복 전에도 화면이 사람이 정리해 둔 대로 떠야 한다(느리거나 실패해도).
//  · 변경은 **디바운스 write-through** — 캐시는 즉시, 서버는 400ms 뒤 한 번(연쇄 조작을 한 판으로).
//  · 첫 진입에 `saved` 로 **1회 이관** — 서버에 이력이 없고 이 브라우저에 정리가 있으면 그걸 올린다.
//    (기존 사용자가 업그레이드하며 자기 정리를 잃지 않는다.)
//
// ── ⚠ 무엇을 올리고 무엇은 안 올리나 — «이 사람의 결정인가, 이 창의 사실인가» ──
//  결정(핀·치움·묶는 축·접힘·레일 순서·최근 앱)은 계정에 묶여야 어디서 들어와도 같다 → shellPrefStore.
//  창의 사실(열린 탭·곁칸 배치·이름 캐시·홈 착지)은 그 기기의 것이라 올리면 안 된다 → deviceStore.
//   노트북에서 연 탭이 사무실 데스크톱에서 되살아나면 그게 더 이상하다.
//
// ── 왜 «등록»인가(wsKey 를 직접 부르지 않는다) ──────────────────────────────
//  키 문자열은 **선언한 파일에 한 벌만** 있어야 한다(#1875 E7 — 두 파일이 각자 적으면 한쪽에만 접미사가
//   붙어 그 화면만 남의 워크스페이스 기록을 본다). 그래서 여기서 목록을 다시 적지 않고, 선언 자리가
//   자기를 등록한다. 덤으로 «이 저장소는 워크스페이스의 내용이다»와 «정본이 어디냐»가 선언 한 줄에 함께 선다.
import { api, wsKey } from '../core.js';

/** 저장소의 모양 — list=순서 있는 문자열 목록 · map=문자열→문자열 · str=문자열 하나. */
export type ShellPrefKind = 'list' | 'map' | 'str';
type Store = { base: string; key: string; kind: ShellPrefKind; sync: boolean };

const stores: Store[] = [];
const byKey = new Map<string, Store>();

function register(base: string, kind: ShellPrefKind, sync: boolean): string {
  const key = wsKey(base);
  const st: Store = { base, key, kind, sync };
  stores.push(st);
  byKey.set(key, st);
  return key;
}

/**
 * **서버가 정본인** 저장소를 선언한다 — 사람이 고른 것(핀·치움·묶는 축·접힘·순서).
 * @returns 이 브라우저에서 쓸 캐시 키(워크스페이스별).
 */
export function shellPrefStore(base: string, kind: ShellPrefKind): string { return register(base, kind, true); }

/**
 * **이 기기가 정본인** 저장소를 선언한다 — 그 창의 사실(열린 탭·배치·캐시).
 *  서버로 올리지 않지만 워크스페이스별로 갈리는 것은 같다(#1875), 그리고 사람이 바뀌면 함께 지워진다.
 */
export function deviceStore(base: string): string { return register(base, 'list', false); }

// ── 캐시 읽기·쓰기 ───────────────────────────────────────────────────────────
function readStore(st: Store): unknown {
  try {
    const raw = localStorage.getItem(st.key);
    if (raw == null) return null;
    if (st.kind === 'str') return raw;
    const v = JSON.parse(raw);
    if (st.kind === 'list') return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (_) { return null; }
}

function writeStore(st: Store, v: unknown): void {
  try {
    if (st.kind === 'str') { if (typeof v === 'string' && v) localStorage.setItem(st.key, v); else localStorage.removeItem(st.key); return; }
    const empty = st.kind === 'list' ? !Array.isArray(v) || !v.length : !v || typeof v !== 'object' || !Object.keys(v as object).length;
    if (empty) localStorage.removeItem(st.key); else localStorage.setItem(st.key, JSON.stringify(v));
  } catch (_) { /* 못 남겨도 이번 화면은 된다 */ }
}

/** 지금 이 브라우저의 «사람이 고른 것» — 서버로 보낼 몸통(빈 저장소는 싣지 않는다). */
export function shellPrefsBody(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const st of stores) {
    if (!st.sync) continue;
    const v = readStore(st);
    if (v == null) continue;
    if (st.kind === 'list' && !(v as string[]).length) continue;
    if (st.kind === 'map' && !Object.keys(v as object).length) continue;
    if (st.kind === 'str' && !v) continue;
    out[st.base] = v;
  }
  return out;
}

/** 서버가 준 정본을 캐시에 얹는다 — **서버에 없는 저장소는 비운다**(그게 «그 계정엔 없다»의 뜻이다). */
export function shellPrefsApply(prefs: Record<string, unknown> | null | undefined): void {
  const src = prefs && typeof prefs === 'object' ? prefs : {};
  for (const st of stores) { if (st.sync) writeStore(st, (src as Record<string, unknown>)[st.base]); }
}

// ── 서버 왕복 ────────────────────────────────────────────────────────────────
const API = '/api/ui/v6/shell-prefs';
let timer: any = null;
let ready = false;   // 첫 동기가 끝나기 전에는 올리지 않는다(아래 shellPrefsPush 주석)

function post(): Promise<void> {
  return api(API, { method: 'POST', body: JSON.stringify({ prefs: shellPrefsBody() }) })
    .then(() => undefined)
    .catch(() => { /* 서버 저장 실패는 조용히 — 캐시엔 이미 반영됐고 다음 조작이 다시 올린다 */ });
}

/**
 * 사람이 무언가를 정했다 — 캐시는 이미 호출부가 적었고, 서버는 400ms 뒤 한 번.
 *
 * ⚠ **첫 동기 전에는 안 올린다.** 부팅 중엔 여러 자리가 저장소를 손대는데(레일 4차→5차 이관,
 *  접힘 기본값 정리), 그때 올리면 **서버 정본을 받기도 전에 이 브라우저의 옛 값으로 덮는다** —
 *  다른 기기에서 해 둔 정리가 그 순간 사라진다. 동기가 끝난 뒤부터가 사람의 조작이다.
 */
export function shellPrefsPush(): void {
  if (!ready) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void post(); }, 400);
}

/** 캐시를 적는 자리에서 부른다 — 그 키가 서버 정본인 저장소일 때만 밀어 올린다. */
export function shellPrefsTouch(key: string): void {
  const st = byKey.get(key);
  if (st && st.sync) shellPrefsPush();
}

/**
 * 부팅 1회 — 서버 정본을 받아 캐시에 얹는다.
 * @returns 캐시가 **바뀌었나**(호출부가 다시 읽어 그릴지 판단한다).
 *
 * 실패하면 캐시 그대로 간다(무해 — 종전 동작). 서버에 이력이 없고 이 브라우저에 정리가 있으면
 *  그걸 1회 이관한다 — 기존 사용자가 업그레이드하며 자기 정리를 잃지 않는다.
 */
export async function shellPrefsSync(): Promise<boolean> {
  let server: any = null;
  try { server = await api(API); }
  catch (_) { ready = true; return false; }
  ready = true;
  if (server && server.saved) {
    const before = JSON.stringify(shellPrefsBody());
    shellPrefsApply(server.prefs);
    return JSON.stringify(shellPrefsBody()) !== before;
  }
  if (Object.keys(shellPrefsBody()).length) void post();   // 1회 이관(디바운스 없이)
  return false;
}
