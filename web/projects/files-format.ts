// projects/files-format.ts — #1405 W1: files.ts 분할 ①.
//  파일 표시용 포맷(크기·날짜)과 정렬 상태(localStorage 왕복 + 비교자·토글 버튼).
//  순수 잎 — 이 모듈은 files 계열 어느 것도 되짚지 않는다.
import { el } from '../core.js';

function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}

// 파일 수정일 컴팩트 표기(#877) — 목록에서 '언제 바뀐/올라온 버전인지' 식별용. 오늘/어제는 시각까지, 올해는 M/D, 지난해는 YY/M/D.
//  mtime=0/미상(구버전 서버 응답)이면 빈 문자열 → 날짜를 아예 표시하지 않는다(graceful).
function fmtFileDate(ms) {
  const n = Number(ms) || 0;
  if (!n) return '';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const sameYMD = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const yst = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameYMD(d, now)) return '오늘 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  if (sameYMD(d, yst)) return '어제 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '/' + d.getDate();
  return (d.getFullYear() % 100) + '/' + (d.getMonth() + 1) + '/' + d.getDate();
}

// 전체 일시 — 모달 목록(#1118)은 항상 이 풀 표기(연-월-일 시:분)로 보여 '뭐가 마지막 버전인지' 바로 식별한다. 카드 툴팁도 공용.
function fmtFileDateFull(ms) {
  const n = Number(ms) || 0;
  if (!n) return '';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// ── 파일 목록 정렬(#1118) — 탐색기 톤: 폴더 우선 고정 + 이름/크기/수정 일시 열 정렬. 기기별 저장, 두 모달(프로젝트 '전체 보기'·홈 팀 공유 폴더) 공유. ──
const FILE_SORT_KEY = 'livelyFileSort';

function fileSortLoad(): { key: string; dir: number } {
  try {
    const v = JSON.parse(localStorage.getItem(FILE_SORT_KEY) || '');
    if (v && ['name', 'size', 'mtime'].includes(v.key) && (v.dir === 1 || v.dir === -1)) return v;
  } catch (_) { /* 기본값 */ }
  return { key: 'name', dir: 1 };
}

function fileSortSave(s) { try { localStorage.setItem(FILE_SORT_KEY, JSON.stringify(s)); } catch (_) { /* private 모드 등 */ } }

function fileSortApply(items, s) {
  const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ko', { numeric: true, sensitivity: 'base' });
  const num = (it) => s.key === 'size' ? (it.type === 'dir' ? -1 : (Number(it.size) || 0)) : (Number(it.mtime) || 0);
  return [...(items || [])].sort((a, b) => {
    const d = (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1);
    if (d) return d;                                  // 폴더 우선 — 방향과 무관(탐색기 기본)
    if (s.key === 'name') return s.dir * byName(a, b);
    const r = num(a) - num(b);
    return r ? s.dir * r : byName(a, b);              // 동률은 이름 오름차순
  });
}

// 열 머리글 버튼 — 클릭 시 그 열로 정렬(첫 클릭 기본 방향: 이름 ↑ · 크기/수정 일시 ↓, 재클릭 반전).
function fileSortBtn(label, key, sort, onSort) {
  const on = sort.key === key;
  const b = el('button', { class: 'file-sort-btn' + (on ? ' on' : ''), type: 'button', title: '‘' + label + '’ 기준 정렬' },
    label, on ? el('span', { class: 'file-sort-arrow', text: sort.dir === 1 ? '▲' : '▼' }) : null);
  b.onclick = (ev) => { ev.stopPropagation(); onSort(on ? { key, dir: -sort.dir } : { key, dir: key === 'name' ? 1 : -1 }); };
  return b;
}

// 타임라인용 날짜시간 — '몇 시간 전' 대신 절대 날짜·시각(연도는 올해가 아니면만 표기).
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  const yr = d.getFullYear() !== new Date().getFullYear() ? (d.getFullYear() + '. ') : '';
  return yr + (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

export { fileSortApply, fileSortBtn, fileSortLoad, fileSortSave, fmtDateTime, fmtFileDate, fmtFileDateFull, fmtSize };
