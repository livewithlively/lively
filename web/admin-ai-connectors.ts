// admin-ai-connectors.ts — [구성원 권한 관리 ▸ Claude 커넥터] (#4213 T6 #4427).
//  ① 워크스페이스 정책 스위치(관리자) — 구성원이 자기 Claude 계정에 연결한 앱을 AI 세션과 자료 수집에 쓰나.
//  ② 구성원 × 앱 기록(보기만) — 앱 × 구성원 현황판의 정식 자리는 [외부 앱 연결](T13)이다. 여기는 관리자가 정책을
//     바꾸기 전후로 «누가 무엇을 연결해 쓰고 있나» 를 보는 자리다.
//  ③ 내 것 새로 확인 — 화면을 보는 사람 자신의 기록만 다시 잰다(남의 계정은 재지 않는다 — 서버 표면 머리말).
//  ⚠ 자리를 [AI 도구]가 아니라 여기 둔 이유: [AI 도구]는 개인형 워크스페이스(ui_profile=personal)에서 숨겨진다
//   (admin-shell PERSONAL_HIDDEN). 이 정책은 «구성원의 AI 계정» 에 관한 것이라 [AI 실행 계정] 옆이 맞고, 여기는 숨겨지지 않는다.
import { api, cardHead, el, errorNote, relTime, toast, uiText } from './core.js';

/** 상태 이름 — 이름이라 명사로 둔다(설명문이 아니다). 서버 상태 표(org/store/member-ai-connectors.ts)와 한 벌. */
const STATUS_LABEL: Record<string, string> = {
  connected: '연결됨',
  'needs-auth': '다시 로그인 필요',
  failed: '연결 실패',
  pending: '승인 대기',
  unknown: '상태 모름',
  removed: '끊음',
};

/** 확인 실패 사유 → 사람 말. 모르는 사유는 뭉뚱그려 «확인하지 못했어요» — 내부 코드를 그대로 보이지 않는다. */
export function scanErrorText(error: string | null | undefined): string {
  switch (String(error || '')) {
    case 'not-logged-in': return 'Claude 에 로그인돼 있지 않아요.';
    case 'not-claude-ai-login': return 'Claude 계정이 아니라 API 키로 로그인돼 있어 커넥터가 보이지 않아요.';
    case 'no-cli': return '이 자리에 Claude Code 가 없어요.';
    case 'timeout': return '확인하는 데 시간이 너무 오래 걸렸어요.';
    case 'no-capacity': return '지금 자리가 모자라 확인하지 못했어요. 잠시 뒤 다시 해 주세요.';
    case 'no-claude-ai-connectors': return '수집 실행에서 Claude 커넥터가 하나도 보이지 않았어요.';
    case 'unconfirmed-empty': return '연결해 둔 앱이 한 번에 모두 보이지 않았어요. 로그인이 풀렸을 수도 있어 한 번 더 확인하면 반영합니다.';
    default: return '확인하지 못했어요.';
  }
}

export async function memberAiConnectorsPanel(host: HTMLElement, data: any): Promise<void> {
  const canEdit = !!data?.canEdit;
  const names = new Map<string, string>();
  for (const m of (data?.members || [])) names.set(String(m.id), String(m.display_name || m.id));
  host.replaceChildren(el('p', { class: 'admin-hint', text: '불러오는 중입니다…' }));
  let r: any;
  try { r = await api('/api/ui/member-ai-connectors'); }
  catch (e) { host.replaceChildren(errorNote(e, '구성원 Claude 커넥터를 불러오지 못했습니다')); return; }
  //  state 가 unknown 이면 서버가 정책을 못 읽은 것이다 — 스위치를 그 값으로 그리면 «꺼짐» 으로 보인다(거짓). 잠그고 안내만 한다.
  const state = String(r?.policy?.state || (r?.policy?.allowed === false ? 'blocked' : 'allowed'));
  const allowed = state === 'allowed';

  // ── ① 정책 ──
  const chk = el('input', { type: 'checkbox' }) as HTMLInputElement;
  chk.checked = allowed; chk.disabled = !canEdit || state === 'unknown';
  chk.addEventListener('change', async () => {
    const next = chk.checked;
    chk.disabled = true;
    try {
      await api('/api/ui/member-ai-connectors/policy', { method: 'POST', body: JSON.stringify({ allowed: next }) });
      toast(next ? '구성원 Claude 커넥터를 씁니다. 새로 여는 AI 세션부터 적용됩니다.' : '구성원 Claude 커넥터를 막았습니다. 새로 여는 AI 세션부터 적용됩니다.');
      void memberAiConnectorsPanel(host, data);
    } catch (e: any) {
      chk.checked = !next; chk.disabled = !canEdit || state === 'unknown';   // 거짓 안심 금지 — 실패하면 되돌린다
      toast((e && e.message) || '정책을 바꾸지 못했습니다', true);
    }
  });
  const policyCard = el('div', { class: 'card' },
    cardHead('구성원 Claude 커넥터 사용'),
    el('label', { class: 'admin-check' }, chk,
      el('span', { text: ' 구성원이 자기 Claude 계정에 연결해 둔 앱(Slack · Notion · Gmail 등)을 AI 세션과 자료 수집에 씁니다' })),
    el('p', { class: 'admin-hint' }, ...uiText(
      '켜 두면(기본) 같은 서비스가 라이블리에도 연결돼 있을 때는 라이블리 연결을 먼저 쓰고, 라이블리에 없는 서비스는 그 구성원의 Claude 커넥터를 씁니다.')),
    el('p', { class: 'admin-hint' }, ...uiText(
      '끄면 라이블리가 여는 AI 세션에 Claude 커넥터가 실리지 않고, 구성원 Claude 계정으로 하는 자료 수집도 돌지 않습니다. 구성원이 자기 컴퓨터에서 직접 연 Claude 에는 «쓰지 말라» 는 안내만 전해집니다.')),
    el('p', { class: 'admin-hint' }, ...uiText('바꾼 값은 새로 여는 AI 세션부터 적용됩니다.')),
    state === 'unknown' ? el('p', { class: 'admin-hint', text: '지금 정책을 읽지 못했습니다. 그동안 새 AI 세션에는 Claude 커넥터가 실리지 않습니다. 잠시 뒤 다시 열어 주세요.' }) : null,
    canEdit ? null : el('p', { class: 'admin-hint', text: '이 설정은 관리자만 바꿀 수 있습니다.' }));

  // ── ② 기록 ──
  const members: any[] = Array.isArray(r?.members) ? r.members : [];
  const rows = members.map((m) => {
    const who = names.get(String(m.member_id)) || String(m.member_id);
    const scan = m.scan;
    const when = scan ? relTime(scan.scanned_at) + ' 확인' + (scan.origin === 'collect' ? '(수집 실행)' : '') : '아직 확인하지 않았어요.';
    const apps = (m.connectors || []).filter((c: any) => c.status !== 'removed');
    return el('div', { class: 'builtin-row' },
      el('span', { class: 'builtin-name', text: who }, el('span', { class: 'mini-meta', text: ' · ' + when })),
      scan && scan.ok === false ? el('p', { class: 'admin-hint', text: scanErrorText(scan.error) }) : null,
      apps.length
        ? el('div', {}, ...apps.map((c: any) => el('span', { class: c.status === 'connected' ? 'pill' : 'pill pill-warn',
          text: c.app + ' · ' + (STATUS_LABEL[c.status] || c.status) })))
        : el('p', { class: 'admin-hint', text: scan && scan.ok ? 'Claude 에 연결한 앱이 없어요.' : '' }));
  });
  const refreshBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '내 커넥터 새로 확인', disabled: !allowed }) as HTMLButtonElement;
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true; refreshBtn.textContent = '확인하는 중…';
    try {
      const out: any = await api('/api/ui/me/ai-connectors/refresh', { method: 'POST', body: '{}' });
      const s = out?.record?.scan;
      toast(out?.skipped === 'recent' ? '방금 확인한 값을 보여 드립니다.'
        : out?.skipped === 'policy-unknown' ? '정책을 읽지 못해 확인하지 않았습니다. 잠시 뒤 다시 해 주세요.'
          : s && s.ok === false ? scanErrorText(s.error) : '내 Claude 커넥터를 다시 확인했습니다.');
      void memberAiConnectorsPanel(host, data);
    } catch (e: any) {
      refreshBtn.disabled = false; refreshBtn.textContent = '내 커넥터 새로 확인';
      toast((e && e.message) || '확인하지 못했습니다', true);
    }
  });
  const listCard = el('div', { class: 'card' },
    cardHead('구성원별 연결 현황', '구성원이 자기 Claude 계정에 연결해 둔 앱입니다. 수집 실행이 시작될 때와, 본인이 «새로 확인» 을 누를 때 갱신됩니다.'),
    el('div', { class: 'admin-actions' }, refreshBtn,
      allowed ? null : el('span', { class: 'admin-hint', text: '  정책이 꺼져 있어 새로 확인하지 않습니다.' })),
    ...(rows.length ? rows : [el('p', { class: 'admin-hint', text: '아직 확인한 구성원이 없어요.' })]));

  host.replaceChildren(policyCard, listCard);
}
