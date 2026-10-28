// v2/member-names.ts — 구성원 id → 표시 이름(#4632 점검 6-5). 잎 모듈 — core 말고는 들이지 않는다.
//  카드 · 배포 설정 · 사이드바 · 만들기 화면 ⑤ 는 계정 아이디(sangmin-yoon)가 아니라 표시 이름(윤상민)을 쓴다.
//  명부는 앱빌더 목록(builder-model)이 앱 목록과 함께 받고, 못 받으면 아이디 그대로. 만들기 화면(app-studio)도 읽기만 한다 —
//  builder-model 이 app-studio 를 들이므로, 명부가 builder-model 에 있으면 둘이 서로 들이게 된다(격리 리뷰).
import { api } from '../core.js';

let names: Map<string, string> | null = null;
let namesAt = 0;   // 마지막으로 물은 때 — 못 받았으면 5분 뒤에 다시(명부를 못 읽는 사람에게 30초마다 묻지 않게)
async function fetchNames(): Promise<void> {
  try {
    const d: any = await api('/api/ui/org/members');
    const rows: any[] = Array.isArray(d?.members) ? d.members : Array.isArray(d) ? d : [];
    const m = new Map<string, string>();
    rows.forEach((x) => { if (x && x.id) m.set(String(x.id), String(x.display_name || x.nickname || x.id)); });
    if (m.size) names = m;
  } catch (_) { /* 아이디로 보인다 */ }
}
/** 명부를 아직 못 받았으면 받는다(5분에 한 번까지). 받아 두었으면 곧바로 끝난다. */
export function ensureMemberNames(): Promise<void> {
  if (names || Date.now() - namesAt < 300_000) return Promise.resolve();
  namesAt = Date.now();
  return fetchNames();
}
/** 구성원 id → 표시 이름(모르면 id). 빈 id 는 빈 글. */
export function memberName(id: string | null | undefined): string {
  const k = String(id || ''); if (!k) return '';
  return (names && names.get(k)) || k;
}
