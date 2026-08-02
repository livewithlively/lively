// dash/resize.ts — 대시보드 열 폭·행 높이 드래그 저장층(#1313 R41 · dashboard-home.ts 에서 verbatim 분리).
//  저장 키는 '어떤 배치에서 잰 값인지'(cols=sig / rows=그 열의 위젯 구성)에 매여 있고, 구버전 키(dash_cols_v2·
//  dash_rows_left_v1·dash_rows_mid_v1)를 이어받는 이관표가 여기 있다 — 문자열이 바뀌면 사용자가 맞춰 둔 폭이 날아간다.
//  ⚠ dashInitColResize 는 열 기본 가중치를 위젯 레지스트리(DASH_W.col/.wide)에서 읽어야 해서 dash/shell.ts 가 갖는다
//   (여기서 import 하면 shell ↔ resize 순환). 그 저장 헬퍼는 여기 있고 그쪽이 import 한다.
import { el } from '../core.js';

// ── 열 폭 사용자화(#req) — .dash-zones 열 사이 드래그 핸들(fr 비율 기기별 저장). 반응형 스택 시 CSS 가 인라인 grid 무시. ──
// v3(#1232) — 열 구성이 사람마다 달라졌으므로 fr 만으론 부족하다: 어떤 배치에서 잰 값인지(sig)를 함께 저장하고,
//  배치가 바뀌면 그 저장값을 조용히 버리고 새 기본으로 돌아간다(예전 폭이 엉뚱한 열에 붙는 것 방지).
//  v2(3열 프리셋 시절의 fr 배열)는 배치가 기본 그대로일 때만 이어받는다.
const DASH_COLS_KEY = 'dash_cols_v3';
const DASH_COLS_KEY_V2 = 'dash_cols_v2';
const DASH_COLS_SIG_V2 = 'proj.fold|notif.sess|log'; // v2 저장값이 유효한 유일한 배치 = 기본 프리셋
function dashColsSig(colKeys: string[][]) { return colKeys.map((c) => c.join('.')).join('|'); }
// 'wide' 위젯(내 프로젝트)이 있는 열의 기본 폭은 fr 이 아니라 px 다 — '리스트 오버뷰 카드가 3열로 정렬되는 최소 폭'(500px).
//  fr 기본은 화면이 넓을수록 그 열이 같이 넓어져(→ 4·5열) 사람마다 너무 넓던 문제(#req). px 고정이면 화면 폭과 무관하게 항상 딱 3열.
//  저장값이 있으면 그 fr 을 쓰고, 없으면 px 기본을 유지하다 첫 드래그 때 captureFr 로 fr 전환(아래).
const DASH_COL_PX = 500;
function dashColsSaved(sig: string, n: number): number[] | null {
  const ok = (a) => Array.isArray(a) && a.length === n && a.every((x) => typeof x === 'number' && x > 0.5);
  try {
    const o = JSON.parse(localStorage.getItem(DASH_COLS_KEY) || 'null');
    if (o && o.sig === sig && ok(o.fr)) return o.fr.slice();
  } catch { /* 파손된 값 무시 */ }
  if (sig !== DASH_COLS_SIG_V2) return null;
  try { const a = JSON.parse(localStorage.getItem(DASH_COLS_KEY_V2) || 'null'); return ok(a) ? a.slice() : null; }
  catch { return null; }
}
function dashSaveCols(sig, fr) { try { localStorage.setItem(DASH_COLS_KEY, JSON.stringify({ sig, fr })); } catch { /* 무시 */ } }
// ── 박스 행 높이 사용자화(#req R13) — 한 열 안 박스들 사이 세로 드래그 핸들. 열 폭 리사이즈와 동일 UI(fr 비율·기기별 저장). ──
//  #1232 로 한 열의 박스 수가 사람마다 달라져 2개 고정에서 N개로 일반화했다(핸들 N-1개, 각 핸들은 '자기 위·아래 두 칸'만 조절).
//  저장 키는 그 열의 위젯 구성(dashRowKey)에 매여 있다 — 배치를 바꾸면 옛 높이가 딸려오지 않고 그 구성의 기본에서 시작한다.
const DASH_ROW_KEYS_LEGACY: Record<string, string> = { 'proj-fold': 'dash_rows_left_v1', 'notif-sess': 'dash_rows_mid_v1' };
function dashRowKey(keys: string[]) { const sig = keys.join('-'); return DASH_ROW_KEYS_LEGACY[sig] || ('dash_rows_' + sig + '_v1'); }
function dashRowsSaved(key, n): number[] | null {
  try { const a = JSON.parse(localStorage.getItem(key) || 'null'); return Array.isArray(a) && a.length === n && a.every((x) => typeof x === 'number' && x > 0.15) ? a.slice() : null; }
  catch { return null; }
}
function dashSaveRows(key, a) { try { localStorage.setItem(key, JSON.stringify(a)); } catch { /* 무시 */ } }
//  opts.autoLast — 저장값이 없으면 **마지막 칸만 auto**(내용맞춤·스크롤 없음)로 두고, 첫 드래그 때 비로소 전 칸 fr 로 전환.
//   (팀 공유 폴더처럼 '한 줄 내용'인 칸이 고정 fr 로 잘려 스크롤바가 뜨던 문제 방지 — #req.)
//  opts.cssDefault — 저장값이 없으면 인라인 트랙을 아예 설정하지 않고 CSS 기본을 그대로 쓴다(.dash-proj-split 처럼 CSS 에 기본이 있는 경우).
function dashInitRowResize(colEl, storeKey, weights: number[], opts?: { autoLast?: boolean; cssDefault?: boolean }) {
  const n = weights.length;
  if (n < 2) { if (!(opts && opts.cssDefault)) colEl.style.gridTemplateRows = 'minmax(0,1fr)'; return; } // 박스 1개 = 조절할 경계가 없다
  const saved = dashRowsSaved(storeKey, n);
  const rows = saved || weights.slice();
  const HANDLE = 14, MIN_FR = 0.35;
  const autoLast = !!(opts && opts.autoLast), cssDefault = !!(opts && opts.cssDefault);
  let frMode = !!saved || !(autoLast || cssDefault); // false = 기본(마지막 칸 auto 또는 CSS) 유지 상태
  const track = (i) => (!frMode && autoLast && i === n - 1 ? 'auto' : `minmax(0,${rows[i]}fr)`);
  const apply = () => { colEl.style.gridTemplateRows = rows.map((_, i) => track(i)).join(` ${HANDLE}px `); };
  const kids = Array.from(colEl.children); // [box0 … boxN-1] (핸들 삽입 전 스냅샷)
  // 현재(auto/CSS) 픽셀 높이를 fr 비율로 캡처 → 드래그 시작점(레이아웃 안 튀게).
  const captureFr = () => {
    const h = kids.map((k) => Math.max(1, (k as any).offsetHeight || 80));
    const s = (4 * n) / h.reduce((a, b) => a + b, 0);
    h.forEach((x, i) => { rows[i] = x * s; });
    frMode = true;
  };
  const mkHandle = (idx) => {
    const h = el('div', { class: 'dash-row-handle', role: 'separator', 'aria-orientation': 'horizontal', title: '높이 조절 (더블클릭=기본, ↑/↓ 미세조절)', tabindex: '0' }, el('span', { class: 'dash-row-grip' }));
    let startY = 0, a0 = 0, b0 = 0, dragging = false;
    const onMove = (e) => {
      if (!dragging) return;
      const rect = colEl.getBoundingClientRect();
      const content = Math.max(1, rect.height - (n - 1) * HANDLE);
      const totalFr = rows.reduce((a, b) => a + b, 0);
      const dFr = ((e.clientY - startY) / content) * totalFr;
      let a = a0 + dFr, b = b0 - dFr;
      if (a < MIN_FR) { b -= (MIN_FR - a); a = MIN_FR; }
      if (b < MIN_FR) { a -= (MIN_FR - b); b = MIN_FR; }
      rows[idx] = a; rows[idx + 1] = b; apply();
    };
    const onUp = () => { if (!dragging) return; dragging = false; document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); document.body.classList.remove('dash-row-resizing'); dashSaveRows(storeKey, rows); };
    h.addEventListener('pointerdown', (e: any) => { e.preventDefault(); if (!frMode) captureFr(); dragging = true; startY = e.clientY; a0 = rows[idx]; b0 = rows[idx + 1]; document.body.classList.add('dash-row-resizing'); document.addEventListener('pointermove', onMove); document.addEventListener('pointerup', onUp); apply(); });
    h.addEventListener('dblclick', () => {
      try { localStorage.removeItem(storeKey); } catch { /* */ }
      weights.forEach((w, i) => { rows[i] = w; });
      if (cssDefault) { frMode = false; colEl.style.gridTemplateRows = ''; }
      else { frMode = !autoLast; apply(); }
    });
    h.addEventListener('keydown', (e: any) => { const s = e.key === 'ArrowUp' ? -0.3 : e.key === 'ArrowDown' ? 0.3 : 0; if (!s) return; e.preventDefault(); if (!frMode) captureFr(); const a = rows[idx] + s, b = rows[idx + 1] - s; if (a >= MIN_FR && b >= MIN_FR) { rows[idx] = a; rows[idx + 1] = b; apply(); dashSaveRows(storeKey, rows); } });
    return h;
  };
  for (let i = 0; i < n - 1; i++) colEl.insertBefore(mkHandle(i), kids[i + 1]);
  if (!cssDefault) apply(); // 배치가 사람마다 달라 CSS 기본 행 트랙이 맞을 수 없다 — auto/fr 어느 쪽이든 여기서 확정
}

export {
  DASH_COLS_KEY,
  DASH_COLS_KEY_V2,
  DASH_COLS_SIG_V2,
  dashColsSig,
  DASH_COL_PX,
  dashColsSaved,
  dashSaveCols,
  DASH_ROW_KEYS_LEGACY,
  dashRowKey,
  dashRowsSaved,
  dashSaveRows,
  dashInitRowResize,
};
