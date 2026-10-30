// lib/app-spec-view.ts — 앱 「개발 정보」 화면(#4632 · v2/app-spec-page.ts)의 순수 규칙. 서버 응답은 capabilities/apps.ts app_spec.
//  두 층을 한 화면에 엮는다: facts(코드에서 바로 읽은 것 — 늘 코드와 같다) · doc(AI 가 쓴 쉬운 말 설명 — 판의 코드 지문마다).
//  설명이 예전 판 것이면(stale) 그렇다고 말하고, 표 · 칸은 늘 facts 가 정본이다(설명에만 있는 표는 «코드에 없음» 으로 보이지 않는다).
import { verName } from './studio-flow.js';

export type SpecState = 'ok' | 'stale' | 'writing' | 'failed' | 'unavailable' | 'limit';
export interface SpecCallView { kind: 'lively' | 'sdk' | 'tool' | 'host' | 'model'; name: string; label: string; count: number; where: Array<{ file: string; line: number }> }
export interface SpecFactsView {
  pages: Array<{ key: string; title: string; entry: string; places: string[] }>;
  tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }>;
  perms: Array<{ key: string; label: string }>;
  calls: SpecCallView[];
  files: Array<{ path: string; size: number; text: boolean }>;
  server: { start: string | null; dir: string | null } | null;
  instructions: boolean;
}
export interface SpecDocView {
  summary: string;
  screens: Array<{ name: string; where: string; what: string }>;
  data: Array<{ name: string; what: string; fields: Array<{ name: string; what: string }> }>;
  features: Array<{ name: string; steps: string[]; code: string }>;
  external: Array<{ what: string; how: string; data: string; code: string }>;
  permissions: Array<{ name: string; why: string }>;
  limits: string[];
  changes: string[];
}
export interface SpecResponse {
  app_id: string; title: string; version_no: number | null; view: 'published' | 'installed';
  facts: SpecFactsView; spec_state: SpecState; spec_error: string | null;
  spec: { version_no: number | null; made_at: string | null; model: string | null; doc: SpecDocView | null } | null;
  /** 「다시 만들기」 를 막 눌러 다시 쓰기 간격(1분)이 안 지났다 — 이만큼 뒤에 다시 누를 수 있다(감사 4-11). 없으면 null. */
  retry_after_ms?: number | null;
}
/** 「다시 만들기」 를 누른 뒤의 알림 — 실제로 다시 쓰기 시작했을 때만 «시작했어요», 아니면 왜 못 했는지(리뷰 N10 · 감사 4-11).
 *  간격에 막힘(retry_after_ms) · 오늘 몫을 다 씀(limit) · 키 없음(unavailable) · 그대로 실패(failed) · 이미 다 씀(ok). */
export function regenToast(r: Pick<SpecResponse, 'spec_state' | 'retry_after_ms'>): { text: string; warn: boolean } {
  if (r.retry_after_ms) return { text: retryAfterText(r.retry_after_ms), warn: true };
  switch (r.spec_state) {
    case 'writing': case 'stale': return { text: '설명을 다시 쓰기 시작했어요', warn: false };
    case 'limit': return { text: '오늘 설명을 쓸 수 있는 횟수를 다 썼어요. 내일 다시 눌러 주세요.', warn: true };
    case 'unavailable': return { text: '워크스페이스 API 키가 없어 설명을 다시 쓰지 못했어요.', warn: true };
    case 'ok': return { text: '이미 지금 버전의 설명이 있어요.', warn: false };
    default: return { text: '설명을 다시 쓰기 시작하지 못했어요. 잠시 후 다시 눌러 주세요.', warn: true };
  }
}
/** 다시 만들기가 간격에 막혔을 때 알림 — «N초 뒤에 다시 눌러 주세요». */
export function retryAfterText(ms: number): string {
  const sec = Math.max(1, Math.ceil(ms / 1000));
  return '방금 다시 써 봤어요. ' + (sec >= 60 ? Math.ceil(sec / 60) + '분' : sec + '초') + ' 뒤에 다시 눌러 주세요.';
}

//  버전 이름은 앱빌더 나머지와 같은 꼴(초안 · V2 …) — lib/studio-flow verName.
const ver = (n: number | null | undefined): string => (n == null ? '' : verName(n));

/** 머리 아래 한 줄 — 설명이 어느 판 기준인지, 지금 무엇을 하는 중인지. */
export function specStateLine(r: Pick<SpecResponse, 'spec_state' | 'version_no' | 'spec' | 'spec_error'>): { tone: 'ok' | 'wait' | 'warn'; text: string } {
  const now = ver(r.version_no);
  const was = ver(r.spec ? r.spec.version_no : null);
  //  지금 버전 설명이 아닌데 앞 버전 설명을 보여 줄 때는 늘 그 버전을 말한다(격리 리뷰 #4632 — V2 설명이 V5 화면에 말없이 서지 않게).
  const older = r.spec && !isCurrentSpec(r) ? ' 아래 설명은 ' + (was || '예전 버전') + ' 기준이에요.' : '';
  switch (r.spec_state) {
    case 'ok': return { tone: 'ok', text: (now ? now + ' 코드 기준으로 쓴 설명이에요.' : '지금 코드 기준으로 쓴 설명이에요.') + ' 코드가 바뀌면 저절로 다시 써요.' };
    case 'stale': return { tone: 'wait', text: (was ? was + ' 기준 설명을 보여 드리고 있어요. ' : '예전 버전 설명을 보여 드리고 있어요. ') + (now ? now + ' 코드로 다시 쓰는 중이에요.' : '지금 코드로 다시 쓰는 중이에요.') };
    case 'writing': return { tone: 'wait', text: 'AI가 코드를 읽고 설명을 쓰는 중이에요. 1~2분 걸려요. 아래 「코드에서 바로 읽은 것」은 지금도 정확해요.' };
    case 'failed': return { tone: 'warn', text: '설명을 쓰지 못했어요. ' + (r.spec_error ? r.spec_error.replace(/[.。]?$/, '.') + ' ' : '') + '「다시 만들기」를 눌러 주세요.' + older };
    case 'unavailable': return { tone: 'warn', text: 'AI 설명은 워크스페이스 API 키가 있어야 만들어져요. 관리자가 키를 등록하면 저절로 써요. 아래 「코드에서 바로 읽은 것」은 지금도 볼 수 있어요.' + older };
    case 'limit': return { tone: 'warn', text: '오늘 이 워크스페이스에서 설명을 쓸 수 있는 횟수를 다 썼어요. 내일 다시 열면 써요. 아래 「코드에서 바로 읽은 것」은 지금도 정확해요.' + older };
  }
  //  모르는 상태(빈 답 · 새 서버의 새 상태) — undefined 를 돌려주면 화면이 넘어졌다. 기다리는 말로 둔다.
  return { tone: 'wait', text: '설명 상태를 확인하고 있어요.' + older };
}

/** 보이는 설명이 지금 버전 것인가(ok 일 때만). 아니면 «달라진 점» 은 그 버전 이야기라 감춘다. */
export const isCurrentSpec = (r: Pick<SpecResponse, 'spec_state'>): boolean => r.spec_state === 'ok';

/** 다시 물어볼까 — 쓰는 중이면(쓰는 중 · 예전 판 설명) 계속 본다. */
export const specShouldPoll = (s: SpecState): boolean => s === 'writing' || s === 'stale';

/**
 * 표 한 벌 — 표와 칸의 목록은 코드(facts)가 정본이고, 뜻은 설명(doc)에서 이름이 같은 것을 붙인다.
 *  설명에만 있는 표 · 칸은 버린다(코드에 없는 것을 보이지 않는다). 설명에 뜻이 없으면 what 은 ''.
 */
export function mergeTables(facts: SpecFactsView['tables'], doc: SpecDocView | null): Array<{ name: string; what: string; columns: Array<{ name: string; type: string; what: string }> }> {
  const byName = new Map((doc ? doc.data : []).map((d) => [d.name.trim().toLowerCase(), d]));
  return facts.map((t) => {
    const d = byName.get(t.name.toLowerCase());
    const fw = new Map((d ? d.fields : []).map((x) => [x.name.trim().toLowerCase(), x.what]));
    return { name: t.name, what: d ? d.what : '', columns: t.columns.map((c) => ({ name: c.name, type: c.type, what: fw.get(c.name.toLowerCase()) || '' })) };
  });
}

const KIND_LABEL: Record<SpecCallView['kind'], string> = { lively: '라이블리 API', sdk: '화면 SDK', tool: '라이블리 도구', host: '바깥 주소', model: 'AI 모델' };
export const callKindLabel = (k: SpecCallView['kind']): string => KIND_LABEL[k] || k;
/** 자리 글 — «ui/index.html 363, 364줄» 처럼 파일마다 묶는다. 자리보다 쓰인 곳이 많으면 «외 N곳». */
export function whereText(c: Pick<SpecCallView, 'where' | 'count'>): string {
  const by = new Map<string, number[]>();
  for (const w of c.where) { const a = by.get(w.file) || []; a.push(w.line); by.set(w.file, a); }
  const parts = [...by.entries()].map(([f, ls]) => f + ' ' + ls.join(', ') + '줄');
  const more = c.count - c.where.length;
  return parts.join(', ') + (more > 0 ? ' 외 ' + more + '곳' : '');
}

/** 파일 크기 글. */
export function sizeText(n: number): string {
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + 'KB';
  return (n / 1024 / 1024).toFixed(1) + 'MB';
}
