// lib/screen-lang.ts — 화면 영어 보기(#5141). 켜면 지금 화면에 보이는 한국어 글을 영어로 바꿔 보여 주고, 끄면 원래 글로 되돌린다.
//  왜: 화면(버튼 · 메뉴 · 지식 제목 · 대화)이 전부 한국어라 영어권 사람에게 보여 줄 수가 없다(영어권 동료 · 투자자 · 데모 영상 —
//   «화면에 보이는 것만 영어로 바꾸는 버튼, 자동 번역처럼»). 서버가 내려 주는 글을 바꾸지 않고
//   **그려진 글자만** 바꾼다 — 저장된 데이터 · 보내는 값 · 입력칸 안의 글은 그대로다.
//  어떻게:
//   · 글 노드(텍스트)와 placeholder · title · aria-label 중 한글이 든 것을 모은다(입력칸 · 코드 · 터미널 · translate="no" 는 건너뛴다).
//   · 브라우저에 남긴 번역은 바로 바꾸고, 없는 글만 묶어서 서버(POST /api/ui/translate)에 묻는다.
//   · 화면이 다시 그려지면(MutationObserver) 새 글을 같은 방법으로 바꾼다. 우리가 바꾼 글은 다시 묻지 않는다.
//   · 상태는 localStorage 하나(lv:screen-lang) — 셸과 그 안의 액자(iframe, 같은 출처)가 storage 이벤트로 함께 켜지고 꺼진다.
import { api } from './net.js';

export const SCREEN_LANG_KEY = 'lv:screen-lang';
const CACHE_KEY = 'lv:screen-lang-cache:en';
/** 브라우저에 남기는 번역 수 — 넘으면 오래된 것부터 버린다. 4천 줄이면 화면 대부분을 덮고 저장소(몇백 KB)를 넘지 않는다. */
const CACHE_MAX = 4000;
/** 한 번에 서버에 보내는 묶음(서버 상한 120개 · 24,000자 안). */
const BATCH_TEXTS = 60;
const BATCH_CHARS = 9000;
/** 서버가 받는 글 하나의 상한 — 넘는 글은 번역하지 않고 한글 그대로 둔다. */
const TEXT_MAX = 2000;
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;
const ATTRS = ['placeholder', 'title', 'aria-label'] as const;
/** 이 아래는 글을 바꾸지 않는다 — 사람이 쓰는 칸 · 코드 · 터미널 · 바꾸지 말라는 표시. */
const SKIP_SEL = 'script,style,noscript,textarea,input,code,pre,kbd,samp,.xterm,[translate="no"],.notranslate';
/** 편집 칸(지식 본문 · 제목 등) — 글은 번역해 보여 주되 **켜져 있는 동안 읽기 전용**으로 둔다.
 *  왜: 편집기는 사람이 친 입력(input)에만 «고쳐짐» 을 달고 그때 화면 글을 통째로 저장한다. 영어 화면에서 한 글자만 쳐도
 *   보여 준 영어가 지식에 저장된다 — 그 길을 아예 닫는다. 끄면 원래 값(true · plaintext-only …)으로 돌린다. */
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
/** 바꿔 둔 글 노드 — 끌 때 되돌리려고. 값: 원문 · 보여 준 글. */
const textOrig = new Map<Text, { orig: string; shown: string }>();
const attrOrig = new Map<Element, Map<string, { orig: string; shown: string }>>();
/** 잠가 둔 편집 칸 — 원래 contenteditable 값. */
const editOrig = new Map<Element, string>();
/** 서버에 물어 둔(답을 기다리는) 원문 — 같은 글을 겹쳐 묻지 않는다. */
const inflight = new Set<string>();
/** 이번 판에서 서버가 못 준 원문 — 다시 그려질 때마다 거듭 묻지 않는다(새로고침하면 다시 시도). */
const failed = new Set<string>();

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
    const c = loadCache();
    const merged = readStored();
    for (const [k, v] of c) { merged.delete(k); merged.set(k, v); }
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

/** 글 노드 하나 — 기억에 있으면 바로 바꾸고, 없으면 물을 목록에 넣는다. */
function doText(t: Text, c: Map<string, string>, ask: Set<string>): void {
  const v = t.nodeValue || '';
  const prev = textOrig.get(t);
  if (prev && v === prev.shown) return;              // 이미 바꿔 둔 글
  if (!HANGUL.test(v)) { if (prev) textOrig.delete(t); return; }
  const parent = t.parentElement;
  if (!parent || skipped(parent)) return;
  const [a, core, b] = splitWs(v);
  if (!wanted(core)) return;
  const hit = c.get(core);
  if (hit === undefined) { if (!inflight.has(core) && !failed.has(core)) ask.add(core); return; }
  //  값(value)이 없는 선택지는 글이 곧 값이다 — 글만 바꾸면 고른 값이 영어로 바뀌어 거르기가 깨진다. 원래 값을 먼저 박는다.
  if (parent.tagName === 'OPTION' && !parent.hasAttribute('value')) parent.setAttribute('value', (parent as HTMLOptionElement).value);
  textOrig.set(t, { orig: v, shown: a + hit + b });
  t.nodeValue = a + hit + b;
}
function doAttrs(el: Element, c: Map<string, string>, ask: Set<string>): void {
  if (el.closest('script,style,.xterm,[translate="no"],.notranslate')) return;
  for (const at of ATTRS) {
    const v = el.getAttribute(at);
    if (!v) continue;
    const prev = attrOrig.get(el)?.get(at);
    if (prev && v === prev.shown) continue;
    const core = v.trim();
    if (!wanted(core)) continue;
    const hit = c.get(core);
    if (hit === undefined) { if (!inflight.has(core) && !failed.has(core)) ask.add(core); continue; }
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
/** 한 갈래(노드와 그 아래)를 훑는다. */
function scanRoot(root: Node, c: Map<string, string>, ask: Set<string>): void {
  if (root.nodeType === Node.TEXT_NODE) { doText(root as Text, c, ask); return; }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  lockEditable(el);
  for (const e of Array.from(el.querySelectorAll(EDITABLE_SEL))) lockEditable(e);
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = w.nextNode())) doText(n as Text, c, ask);
  if (el.hasAttribute('placeholder') || el.hasAttribute('title') || el.hasAttribute('aria-label')) doAttrs(el, c, ask);
  for (const e of Array.from(el.querySelectorAll('[placeholder],[title],[aria-label]'))) doAttrs(e, c, ask);
}

/** 화면 전체를 훑는다 — 켤 때 · 번역을 받았을 때 · 놓친 것을 줍는 뒷정리. */
function scan(): void {
  if (!on || !document.body) return;
  const ask = new Set<string>();
  scanRoot(document.body, loadCache(), ask);
  if (ask.size) void fetchAll([...ask]);
}

/** 화면이 바뀐 그 자리만 **곧바로**(그려지기 전에) — 사이드바가 다시 그려질 때 한글이 한 번 비쳤다 바뀌지 않게.
 *  MutationObserver 콜백은 그 작업이 끝난 뒤 · 화면을 그리기 전에 돈다. 기억에 있는 번역은 여기서 붙고, 모르는 글만 서버에 묻는다. */
function onMutations(records: MutationRecord[]): void {
  if (!on) return;
  const c = loadCache();
  const ask = new Set<string>();
  for (const r of records) {
    if (r.type === 'childList') r.addedNodes.forEach((n) => scanRoot(n, c, ask));
    else if (r.type === 'characterData') doText(r.target as Text, c, ask);
    else if (r.type === 'attributes' && r.target.nodeType === Node.ELEMENT_NODE) {
      const el = r.target as Element;
      if (r.attributeName === 'contenteditable') lockEditable(el); else doAttrs(el, c, ask);
    }
  }
  if (ask.size) void fetchAll([...ask]);
}

async function fetchAll(texts: string[]): Promise<void> {
  //  화면 위쪽(먼저 읽히는 글)부터 묻는다 — 훑은 차례가 문서 차례라 이미 위에서 아래다.
  const batches: string[][] = [];
  let cur: string[] = [], chars = 0;
  for (const s of texts) {
    if (cur.length && (cur.length >= BATCH_TEXTS || chars + s.length > BATCH_CHARS)) { batches.push(cur); cur = []; chars = 0; }
    cur.push(s); chars += s.length;
  }
  if (cur.length) batches.push(cur);
  for (const s of texts) inflight.add(s);
  busy++; emit();
  try {
    //  둘씩 동시에 — 한 화면이 몇 묶음이라 둘이면 충분하고, 한 사람이 키를 몰아 쓰지 않게.
    let i = 0;
    const worker = async (): Promise<void> => { while (i < batches.length) { const b = batches[i++]; await fetchBatch(b); } };
    await Promise.all([worker(), worker()]);
  } finally {
    for (const s of texts) inflight.delete(s);
    busy--; emit();
  }
  if (on) scheduleScan(0);   // 받은 번역을 화면에 붙인다(그 사이 다시 그려진 노드까지)
}

async function fetchBatch(texts: string[]): Promise<void> {
  try {
    const r = await api('/api/ui/translate', { method: 'POST', body: JSON.stringify({ texts, to: 'en' }), headers: { 'Content-Type': 'application/json' } });
    const out: Array<string | null> = Array.isArray(r?.translations) ? r.translations : [];
    const c = loadCache();
    texts.forEach((s, k) => {
      const v = out[k];
      if (typeof v === 'string' && v.trim()) { c.delete(s); c.set(s, v); } else failed.add(s);
    });
    lastError = r?.error ? String(r.error) : null;
    saveCacheSoon();
  } catch (e) {
    for (const s of texts) failed.add(s);
    lastError = String((e as Error)?.message || e);
  }
}

/** 훑기는 **스로틀**이다(미루기가 아니다) — 쉬지 않고 다시 그리는 화면(세션 이력 · 목록 폴링)에서 미루기만 하면 한 번도 못 돈다. */
function scheduleScan(ms = 250): void {
  if (scanTimer) return;
  scanTimer = setTimeout(() => { scanTimer = null; scan(); }, ms);
}

function start(): void {
  if (on) return;
  on = true;
  failed.clear();
  document.documentElement.setAttribute('lang', 'en');
  document.documentElement.dataset.screenLang = 'en';
  if (!observer && document.body) {
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS, 'contenteditable'] });
  }
  scan();
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
