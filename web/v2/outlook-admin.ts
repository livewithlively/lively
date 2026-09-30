// outlook-admin.ts — Outlook «회사 관리자 허용» 안내 한 벌(#4211). 앱 상세·자료 가져오기 카드·연결 복귀 화면이 같이 쓴다.
//
//  왜 따로 두나: 회사 Microsoft 365 계정은 Mail.Read·Calendars.Read 를 **본인이 허용할 수 없다**(Microsoft 관리형 기본 동의
//   정책, 2025-11). 그 사람은 Microsoft 화면의 «관리자 승인 필요»에서 멈추고, 우리 화면으로 **돌아오지 않는 일이 많다**.
//   그래서 오류를 기다렸다 안내하면 늦다 — 연결 버튼 곁에 «막히면 이 링크를 관리자에게» 를 **미리** 둔다. 세 화면이 서로 다른
//   말을 하면 사람은 어느 것을 믿을지 모른다(노션 NOTION_PICK_TIP 과 같은 이유로 문장 한 벌).
import { api, el, toast } from '../core.js';
import { copyText } from '../ui-primitives.js';

/** 연결 전 안내 — 회사 계정만 해당한다는 것과, 막히면 무엇을 하는지. */
export const OUTLOOK_ADMIN_TIP =
  '회사 계정(Microsoft 365)은 회사 관리자가 한 번 «조직 전체 허용»을 해야 연결돼요. Microsoft 화면에 «관리자 승인 필요»가 뜨면 아래 링크를 회사 관리자에게 보내 주세요. 개인 outlook.com 계정은 바로 연결됩니다.';

/** 관리자가 허용한 **뒤**에 할 일 — 연결을 다시 누르면 끝난다(관리자 허용은 Microsoft 쪽에 기록돼 자동으로 이어지지 않는다). */
export const OUTLOOK_ADMIN_AFTER = '관리자가 허용하면 여기서 [Outlook 연결]을 한 번 더 누르세요 — 이번엔 막히지 않습니다.';

/**
 * 관리자에게 보낼 링크 상자. url 을 모르면(아직 안 받았으면) 서버에 묻는다. 끝내 없으면(앱 미준비) 아무것도 안 그린다 —
 *  보낼 수 없는 링크 자리를 내밀지 않는다.
 */
export function outlookAdminConsentBox(url: string | null | undefined, opts: { strong?: boolean } = {}): HTMLElement {
  const host = el('div', { class: 'cn-help' + (opts.strong ? ' cn-arrived off' : '') });
  const paint = (u: string | null): void => {
    if (!u) { host.replaceChildren(); host.hidden = true; return; }
    host.hidden = false;
    const link = el('a', { href: u, target: '_blank', rel: 'noopener noreferrer', text: '관리자로 직접 열기 ↗', class: 'btn btn-ghost btn-sm' });
    const copy = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '관리자에게 보낼 링크 복사' });
    copy.addEventListener('click', async () => {
      if (await copyText(u)) toast('링크를 복사했어요 — 회사 관리자에게 보내 주세요');
      else toast('복사하지 못했어요 — [관리자로 직접 열기]의 주소를 보내 주세요', true);
    });
    host.replaceChildren(
      el('span', { text: opts.strong ? `회사 관리자의 허용이 먼저 필요해요. ${OUTLOOK_ADMIN_AFTER}` : OUTLOOK_ADMIN_TIP }),
      el('div', { class: 'cn-acts', style: 'margin-top:6px' }, copy, link));
  };
  if (url) paint(url);
  else {
    host.hidden = true;
    void api('/api/ui/org/outlook/admin-consent').then((r: any) => paint(r && typeof r.url === 'string' ? r.url : null)).catch(() => paint(null));
  }
  return host;
}
