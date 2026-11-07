// lib/screen-lang.ts — 화면 영어 보기(#5141). 켜면 지금 화면에 보이는 한국어 글을 영어로 바꿔 보여 주고, 끄면 원래 글로 되돌린다.
//  왜: 화면(버튼 · 메뉴 · 지식 제목 · 대화)이 전부 한국어라 영어권 사람에게 보여 줄 수가 없다(영어권 동료 · 투자자 · 데모 영상 —
//   «화면에 보이는 것만 영어로 바꾸는 버튼, 자동 번역처럼»). 서버가 내려 주는 글을 바꾸지 않고
//   **그려진 글자만** 바꾼다 — 저장된 데이터 · 입력칸 안의 글은 그대로다.
//  어떻게:
//   · 글 노드(텍스트)와 placeholder · title · aria-label 중 한글이 든 것을 모은다(입력칸 · 코드 · 터미널 · translate="no" 는 건너뛴다).
//   · 브라우저에 남긴 번역은 화면이 바뀐 그 순간(그리기 전) 바로 바꾸고, 없는 글만 묶어서 서버(POST /api/ui/translate)에 묻는다.
//   · 상태는 localStorage 하나(lv:screen-lang) — 셸과 그 안의 액자(iframe, 같은 출처)가 storage 이벤트로 함께 켜지고 꺼진다.
//  ★ 번역이 데이터로 새지 않게(격리 리뷰 blocking 1): 편집기는 체크박스 · 아이콘 · 속성 바꾸기 같은 입력 없는 길로도 **화면 글을 통째로
//   읽어** 저장한다. 그래서 편집 칸을 잠그는 것으로는 모자라다 — 켜져 있는 동안 **쓰기 요청 본문에 화면에 보여 준 영어가 들어 있으면
//   보내지 않는다**(net.setRequestGuard). 수집기 켜기처럼 번역 글이 안 든 쓰기는 그대로 간다. 편집 칸 잠금은 «치다가 막히는» 일을 줄이는 겉 칸막이다.
//  ★ 요청 폭주를 막는다(blocking 2): 모르는 글은 곧바로 묻지 않는다 — 두 번 잇따라 훑었을 때 **그대로 있는 글만** 묻는다(흐르는 답 ·
//   «3분 전» · 치는 중인 검색어는 그 사이 바뀌어 빠진다). 1분 예산을 넘으면 미룬다. 실패는 영구가 아니다 — 물러났다 다시 묻는다.
import { api, setRequestGuard } from './net.js';

export const SCREEN_LANG_KEY = 'lv:screen-lang';
const CACHE_KEY = 'lv:screen-lang-cache:en';
/** 브라우저에 남기는 번역 수 — 넘으면 오래된 것부터 버린다. 4천 줄이면 화면 대부분을 덮고 저장소(몇백 KB)를 넘지 않는다. */
const CACHE_MAX = 4000;
/** 한 번에 서버에 보내는 묶음(서버 상한 120개 · 24,000자 안). 작게 쪼개 한꺼번에 보낸다 — 화면 전체가 가장 느린 묶음 하나만큼만 기다리게
 *  (실측: 60개 묶음을 둘씩 차례로 보냈더니 문서 하나에 수십 초). */
const BATCH_TEXTS = 20;
const BATCH_CHARS = 1200;
/** 동시에 보내는 묶음 수. */
const CONCURRENCY = 6;
/** 이 문서가 1분에 보내는 묶음 수 — 서버 상한(사람당 120)보다 낮게. 셸과 액자가 따로 세니 둘이 합쳐도 넘지 않게 절반. */
const BATCHES_PER_MIN = 60;
/** 훑기 간격 — 모르는 글은 이 간격으로 두 번 보여야 묻는다. */
const SCAN_MS = 600;
/** 실패한 글을 다시 묻기까지(처음 · 거듭될 때마다 두 배 · 상한). */
const RETRY_MS = 15_000, RETRY_MAX_MS = 5 * 60_000;
/** 서버가 받는 글 하나의 상한 — 넘는 글은 번역하지 않고 한글 그대로 둔다. */
const TEXT_MAX = 2000;
/** 쓰기 본문에서 찾는 «보여 준 영어» 의 최소 길이 — 너무 짧으면(«OK») 아무 본문에나 걸린다. */
const GUARD_MIN = 4;
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;
const ATTRS = ['placeholder', 'title', 'aria-label'] as const;
/** 이 아래는 글을 바꾸지 않는다 — 사람이 쓰는 칸 · 코드 · 터미널 · 바꾸지 말라는 표시. */
const SKIP_SEL = 'script,style,noscript,textarea,input,code,pre,kbd,samp,.xterm,[translate="no"],.notranslate';
/** 편집 칸 — 켜져 있는 동안 읽기 전용(치다가 막히는 일을 줄인다 · 저장 막기는 요청 검사가 한다). 끄면 원래 값으로. */
const EDITABLE_SEL = '[contenteditable]:not([contenteditable="false"])';

type Listener = (s: { on: boolean; busy: boolean; error: string | null }) => void;

let on = false;
let busy = 0;
let lastError: string | null = null;
let observer: MutationObserver | null = null;
let scanTimer: ReturnType<typeof setTimeout> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

/** 원문 → 번역(브라우저 기억). 넣은 차례 = 오래된 차례. */
let cache: Map<string, string> | null = null;
/** 바꿔 둔 글 노드 · 속성 · 잠근 편집 칸 — 끌 때 되돌리려고. 화면에서 빠진 것은 훑을 때 지운다(새는 기억 방지). */
const textOrig = new Map<Text, { orig: string; shown: string }>();
const attrOrig = new Map<Element, Map<string, { orig: string; shown: string }>>();
const editOrig = new Map<Element, string>();
/** 서버에 물어 둔(답을 기다리는) 원문. */
const inflight = new Set<string>();
/** 실패한 원문 → 다시 물어도 되는 때 · 물러남 간격. */
const retryAt = new Map<string, { at: number; wait: number }>();
/** 지난 훑기에서 본 «모르는 글» — 이번에도 그대로면 묻는다. */
let seenLast = new Set<string>();
/** 최근 1분 동안 보낸 묶음 시각. */
const sentAt: number[] = [];

function emit(): void { const s = { on, busy: busy > 0, error: lastError }; for (const f of listeners) { try { f(s); } catch (_) { /* 듣는 쪽 오류는 무시 */ } } }
export function onScreenLang(f: Listener): () => void { listeners.add(f); f({ on, busy: busy > 0, error: lastError }); return () => { listeners.delete(f); }; }
export function screenLangOn(): boolean { try { return localStorage.getItem(SCREEN_LANG_KEY) === 'en'; } catch (_) { return false; } }

function parseStored(raw: string | null): Map<string, string> {
  const m = new Map<string, string>();
  try {
    const arr = raw ? JSON.parse(raw) : null;
    if (Array.isArray(arr)) for (const p of arr) if (Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string') m.set(p[0], p[1]);
  } catch (_) { /* 깨진 기억 — 빈 채로 */ }
  return m;
}
function readStored(): Map<string, string> { try { return parseStored(localStorage.getItem(CACHE_KEY)); } catch (_) { return new Map(); } }
function loadCache(): Map<string, string> {
  if (!cache) cache = readStored();
  return cache;
}
function saveCacheSoon(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    //  셸과 액자가 같은 칸에 쓴다 — 덮지 말고 합친다(저장된 것 위에 이 문서가 받은 것을 얹는다 · 이 문서 것이 더 새것).
    const merged = readStored();
    for (const [k, v] of loadCache()) { merged.delete(k); merged.set(k, v); }
    while (merged.size > CACHE_MAX) { const k = merged.keys().next().value; if (k === undefined) break; merged.delete(k); }
    cache = merged;
    try { localStorage.setItem(CACHE_KEY, JSON.stringify([...merged.entries()])); } catch (_) { /* 저장소가 꽉 찼다 — 이번 판 기억으로만 */ }
  }, 800);
}

/** 앞뒤 공백을 떼고 안쪽만 번역한다 — 줄바꿈 · 들여쓰기가 화면 배치를 쥐고 있어서. */
function splitWs(s: string): [string, string, string] {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
  return m ? [m[1], m[2], m[3]] : ['', s, ''];
}
function wanted(core: string): boolean { return !!core && core.length <= TEXT_MAX && HANGUL.test(core); }
function skipped(el: Element | null): boolean { return !!el && !!el.closest(SKIP_SEL); }
function mayAsk(core: string, now: number): boolean {
  if (inflight.has(core)) return false;
  const r = retryAt.get(core);
  return !r || now >= r.at;
}

/** 글 노드 하나 — 기억에 있으면 바로 바꾸고, 없으면 모르는 글로 적는다. */
function doText(t: Text, c: Map<string, string>, unknown: Set<string>): void {
  const v = t.nodeValue || '';
  const prev = textOrig.get(t);
  if (prev && v === prev.shown) return;              // 이미 바꿔 둔 글
  if (!HANGUL.test(v)) { if (prev) textOrig.delete(t); return; }
  const parent = t.parentElement;
  if (!parent || skipped(parent)) return;
  const [a, core, b] = splitWs(v);
  if (!wanted(core)) return;
  const hit = c.get(core);
  if (hit === undefined) { unknown.add(core); return; }
  //  값(value)이 없는 선택지는 글이 곧 값이다 — 글만 바꾸면 고른 값이 영어로 바뀌어 거르기가 깨진다. 원래 값을 먼저 박는다.
  if (parent.tagName === 'OPTION' && !parent.hasAttribute('value')) parent.setAttribute('value', (parent as HTMLOptionElement).value);
  textOrig.set(t, { orig: v, shown: a + hit + b });
  t.nodeValue = a + hit + b;
}
function doAttrs(el: Element, c: Map<string, string>, unknown: Set<string>): void {
  if (el.closest('script,style,.xterm,[translate="no"],.notranslate')) return;
  for (const at of ATTRS) {
    const v = el.getAttribute(at);
    if (!v) continue;
    const prev = attrOrig.get(el)?.get(at);
    if (prev && v === prev.shown) continue;
    const core = v.trim();
    if (!wanted(core)) continue;
    const hit = c.get(core);
    if (hit === undefined) { unknown.add(core); continue; }
    let m = attrOrig.get(el); if (!m) { m = new Map(); attrOrig.set(el, m); }
    m.set(at, { orig: v, shown: hit });
    el.setAttribute(at, hit);
  }
}
function lockEditable(el: Element): void {
  if (!el.matches(EDITABLE_SEL)) return;
  if (!editOrig.has(el)) editOrig.set(el, el.getAttribute('contenteditable') ?? '');
  el.setAttribute('contenteditable', 'false');
}
/** 한 갈래(노드와 그 아래)를 훑는다. 건너뛸 갈래(터미널 · 코드 …)는 안을 들여다보지도 않는다. */
function scanRoot(root: Node, c: Map<string, string>, unknown: Set<string>): void {
  if (root.nodeType === Node.TEXT_NODE) { doText(root as Text, c, unknown); return; }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  if (el.closest(SKIP_SEL)) {
    //  입력칸 자신의 placeholder 는 바꾼다(그 안에 글 노드는 없다).
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !el.closest('.xterm,[translate="no"],.notranslate')) doAttrs(el, c, unknown);
    return;
  }
  lockEditable(el);
  for (const e of Array.from(el.querySelectorAll(EDITABLE_SEL))) lockEditable(e);
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = w.nextNode())) doText(n as Text, c, unknown);
  if (el.hasAttribute('placeholder') || el.hasAttribute('title') || el.hasAttribute('aria-label')) doAttrs(el, c, unknown);
  for (const e of Array.from(el.querySelectorAll('[placeholder],[title],[aria-label]'))) doAttrs(e, c, unknown);
}

/** 화면에서 빠진 노드를 기억에서 지운다 — 사이드바 · 목록이 다시 그려질 때마다 쌓이면 밤새 켜 둔 탭이 끝없이 불어난다. */
function prune(): void {
  for (const t of textOrig.keys()) if (!t.isConnected) textOrig.delete(t);
  for (const el of attrOrig.keys()) if (!el.isConnected) attrOrig.delete(el);
  for (const el of editOrig.keys()) if (!el.isConnected) editOrig.delete(el);
}

/** 화면 전체를 훑는다 — 모르는 글 중 지난 훑기에도 그대로 있던 것만 묻는다. */
function scan(): void {
  if (!on || !document.body) return;
  prune();
  const unknown = new Set<string>();
  scanRoot(document.body, loadCache(), unknown);
  const now = Date.now();
  const ask: string[] = [];
  for (const s of unknown) if (seenLast.has(s) && mayAsk(s, now)) ask.push(s);
  seenLast = unknown;
  if (ask.length) void fetchAll(ask);
  //  아직 모르는 글이 남았으면 다음 훑기를 잡는다(두 번째 봄 · 물러남이 끝난 글).
  if (unknown.size) scheduleScan(SCAN_MS);
}

/** 화면이 바뀐 그 자리만 **곧바로**(그려지기 전에) — 기억에 있는 번역은 여기서 붙는다(한글이 한 번 비쳤다 바뀌지 않게).
 *  모르는 글은 여기서 묻지 않는다 — 다음 훑기가 «그대로 있나» 를 보고 묻는다. */
function onMutations(records: MutationRecord[]): void {
  if (!on) return;
  const c = loadCache();
  const unknown = new Set<string>();
  for (const r of records) {
    if (r.type === 'childList') r.addedNodes.forEach((n) => scanRoot(n, c, unknown));
    else if (r.type === 'characterData') doText(r.target as Text, c, unknown);
    else if (r.type === 'attributes' && r.target.nodeType === Node.ELEMENT_NODE) {
      const el = r.target as Element;
      if (r.attributeName === 'contenteditable') lockEditable(el); else doAttrs(el, c, unknown);
    }
  }
  if (unknown.size) scheduleScan(SCAN_MS);
}

function budgetLeft(now: number): number {
  while (sentAt.length && now - sentAt[0] > 60_000) sentAt.shift();
  return BATCHES_PER_MIN - sentAt.length;
}

async function fetchAll(texts: string[]): Promise<void> {
  const now = Date.now();
  const room = budgetLeft(now);
  if (room <= 0) return;   // 예산이 찼다 — 다음 훑기가 다시 본다(그때까지 그 글은 한글)
  //  화면 위쪽(먼저 읽히는 글)부터 묻는다 — 훑은 차례가 문서 차례라 이미 위에서 아래다.
  const batches: string[][] = [];
  let cur: string[] = [], chars = 0;
  for (const s of texts) {
    if (cur.length && (cur.length >= BATCH_TEXTS || chars + s.length > BATCH_CHARS)) { batches.push(cur); cur = []; chars = 0; }
    cur.push(s); chars += s.length;
  }
  if (cur.length) batches.push(cur);
  const take = batches.slice(0, room);
  for (const b of take) { sentAt.push(now); for (const s of b) inflight.add(s); }
  busy++; emit();
  try {
    //  여럿을 동시에 — 묶음마다 받는 대로 화면에 붙인다(다 끝날 때까지 기다리지 않는다).
    let i = 0;
    const worker = async (): Promise<void> => { while (i < take.length) { const b = take[i++]; await fetchBatch(b); if (on) scheduleScan(0); } };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, take.length) }, worker));
  } finally {
    for (const b of take) for (const s of b) inflight.delete(s);
    busy--; emit();
  }
  if (on) scheduleScan(0);   // 받은 번역을 화면에 붙인다(그 사이 다시 그려진 노드까지)
}

function backoff(s: string, now: number): void {
  const prev = retryAt.get(s);
  const wait = prev ? Math.min(prev.wait * 2, RETRY_MAX_MS) : RETRY_MS;
  retryAt.set(s, { at: now + wait, wait });
}

async function fetchBatch(texts: string[]): Promise<void> {
  try {
    const r = await api('/api/ui/translate', { method: 'POST', body: JSON.stringify({ texts, to: 'en' }), headers: { 'Content-Type': 'application/json' } });
    const out: Array<string | null> = Array.isArray(r?.translations) ? r.translations : [];
    const c = loadCache();
    const now = Date.now();
    texts.forEach((s, k) => {
      const v = out[k];
      if (typeof v === 'string' && v.trim()) { c.delete(s); c.set(s, v); retryAt.delete(s); } else backoff(s, now);
    });
    lastError = r?.error ? String(r.error) : null;
    saveCacheSoon();
  } catch (e) {
    //  429 · 5xx · 끊김 — 영구 실패로 두지 않는다. 물러났다 다시 묻는다(메뉴가 세션 내내 한글로 굳지 않게).
    const now = Date.now();
    for (const s of texts) backoff(s, now);
    lastError = String((e as Error)?.message || e);
  }
}

/** 훑기는 **스로틀**이다(미루기가 아니다) — 쉬지 않고 다시 그리는 화면(세션 이력 · 목록 폴링)에서 미루기만 하면 한 번도 못 돈다. */
function scheduleScan(ms = 250): void {
  if (scanTimer) return;
  scanTimer = setTimeout(() => { scanTimer = null; scan(); }, ms);
}

/** 쓰기 요청 검사 — 화면에 보여 준 영어가 본문에 들어 있으면 문장을 돌려준다(그 요청은 net 이 보내지 않는다). */
function guard(path: string, method: string, body: unknown): string | null {
  if (!on || method === 'GET' || method === 'HEAD') return null;
  if (path.indexOf('/api/ui/translate') === 0) return null;
  if (typeof body !== 'string' || !body) return null;
  const shown = new Set<string>();
  for (const [t, r] of textOrig) if (t.isConnected) shown.add(r.shown.trim());
  for (const [el, m] of attrOrig) if (el.isConnected) for (const r of m.values()) shown.add(r.shown.trim());
  for (const s of shown) {
    if (s.length < GUARD_MIN || !/[A-Za-z]/.test(s)) continue;
    const esc = JSON.stringify(s).slice(1, -1);
    if (body.includes(s) || body.includes(esc)) {
      return `영어 보기(EN)가 켜져 있어 저장하지 않았습니다 — 화면에 보여 준 번역(«${s.slice(0, 40)}»)이 함께 저장될 뻔했습니다. EN 을 끄고 다시 하세요.`;
    }
  }
  return null;
}

function start(): void {
  if (on) return;
  on = true;
  retryAt.clear();
  seenLast = new Set();
  setRequestGuard(guard);
  document.documentElement.setAttribute('lang', 'en');
  document.documentElement.dataset.screenLang = 'en';
  if (!observer && document.body) {
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS, 'contenteditable'] });
  }
  //  켜는 순간엔 두 번 잇따라 훑는다 — 처음 본 글은 두 번째 훑기에서 묻는다(안정 확인 규칙을 그대로 지키면서 빨리).
  scan();
  setTimeout(() => { if (on) scan(); }, 150);
  emit();
}

function stop(): void {
  if (!on) return;
  on = false;
  observer?.disconnect(); observer = null;
  if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
  //  우리가 바꾼 글만 되돌린다 — 그 사이 화면이 새로 쓴 글(값이 보여 준 글과 다르다)은 건드리지 않는다.
  for (const [t, r] of textOrig) if (t.isConnected && t.nodeValue === r.shown) t.nodeValue = r.orig;
  textOrig.clear();
  for (const [el, m] of attrOrig) for (const [at, r] of m) if (el.isConnected && el.getAttribute(at) === r.shown) el.setAttribute(at, r.orig);
  attrOrig.clear();
  for (const [el, v] of editOrig) if (el.isConnected && el.getAttribute('contenteditable') === 'false') el.setAttribute('contenteditable', v || 'true');
  editOrig.clear();
  setRequestGuard(null);
  document.documentElement.setAttribute('lang', 'ko');
  delete document.documentElement.dataset.screenLang;
  lastError = null;
  emit();
}

/** 켜고 끈다 — 이 문서와, storage 이벤트로 같은 출처의 다른 문서(액자 · 다른 탭)가 함께 따른다. */
export function setScreenLang(en: boolean): void {
  try { if (en) localStorage.setItem(SCREEN_LANG_KEY, 'en'); else localStorage.removeItem(SCREEN_LANG_KEY); } catch (_) { /* 저장 못 해도 이 화면은 따른다 */ }
  if (en) start(); else stop();
}
export function toggleScreenLang(): void { setScreenLang(!on); }

let inited = false;
/** 앱이 뜰 때 한 번 — 켜져 있었으면 바로 시작하고, 다른 문서가 바꾸면 따라간다. */
export function initScreenLang(): void {
  if (inited) return;
  inited = true;
  addEventListener('storage', (e) => {
    if (e.key === SCREEN_LANG_KEY) { if (e.newValue === 'en') start(); else stop(); }
    if (e.key === CACHE_KEY) {   // 다른 문서가 받은 번역 — 이 문서 기억에 합친다(이 문서가 받은 것은 남긴다)
      const theirs = parseStored(e.newValue);
      const mine = loadCache();
      for (const [k, v] of theirs) if (!mine.has(k)) mine.set(k, v);
      if (on) scheduleScan(0);
    }
  });
  if (screenLangOn()) start();
}
