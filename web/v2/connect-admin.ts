// v2/connect-admin.ts — [외부 앱 연결] 화면의 **관리자 쪽 절반**(#1719, 원준 2026-08-21).
//
// 왜 여기 있나: 이 화면이 답해야 하는 질문은 하나다 — "AI가 이 앱을 내 계정으로 쓸 수 있나".
//  그런데 그게 되려면 **두 가지**가 다 서 있어야 한다.
//   ① 조직이 그 앱을 열어 뒀나 (외부 MCP 서버 등록 — 관리자 1회, 조직 전체에 적용)
//   ② 내가 내 계정으로 로그인했나 (구성원 각자)
//  종전엔 ①이 관리탭 [AI 능력 ▸ AI 도구 ▸ 외부 도구 서버(MCP)] 안쪽에만 있어서, 여기 서 있는 관리자는
//  "관리자가 등록해야 해요" 라는 **자기 자신에게 하는 안내**를 읽고 다른 화면으로 떠나야 했다. 한 화면에 둔다.
//
// 무엇을 다시 만들지 않았나: 등록 폼 전체(전송방식·mode·scope·level·PII·감사·auth_env…)는 관리탭에 그대로 있다.
//  여기 있는 건 **프리셋 한 줄로 끝나는 흔한 길**뿐이다 — 값은 전부 서버 프리셋(mcp-server-presets.ts)에서 오고
//  내가 지어내는 값은 없다. 프리셋 밖(직접 등록·세부 조정)은 관리탭으로 보낸다. 입구를 둘로 만들되 **깊이는
//  하나만** 갖는다 — 같은 폼을 두 벌 만들면 조용히 어긋난다(구 CRED_KINDS 교훈).
import { api, el, hasScope, toast, uiText } from '../core.js';
import { confirmDialog } from '../ui-primitives.js';

export type OrgMcp = {
  admin: boolean;
  servers: any[];    // 조직에 등록된 MCP 서버 전량(관리자에게만 내려온다 — servers_all)
  presets: any[];    // 기본 카탈로그(프리셋). name 이 이 화면의 앱 key 와 같다.
};

/** 관리자면 조직 쪽 사실을 읽어 온다. 관리자가 아니면 null — 화면은 그 절반을 아예 그리지 않는다. */
export async function loadOrgMcp(): Promise<OrgMcp | null> {
  if (!hasScope('admin')) return null;
  const [srv, pre] = await Promise.all([
    api('/api/ui/org/mcp-servers').catch(() => null),
    api('/api/ui/org/mcp-server-presets').catch(() => null),
  ]);
  if (!srv && !pre) return null;
  return { admin: true, servers: (srv && (srv.servers_all || srv.servers)) || [], presets: (pre && pre.catalog) || [] };
}

export const orgServerOf = (org: OrgMcp | null, key: string): any | null =>
  (org && org.servers.find((s: any) => s.name === key)) || null;
export const presetOf = (org: OrgMcp | null, key: string): any | null =>
  (org && org.presets.find((p: any) => p.name === key)) || null;

/** 이 게이트웨이의 OAuth 콜백 — 상류 콘솔(구글·슬랙)의 '허용된 redirect URI' 에 그대로 넣는 값. */
const callbackUrl = (): string => location.origin.replace(/\/mcp$/, '').replace(/\/$/, '') + '/oauth/callback';

function copyRow(label: string, value: string): HTMLElement {
  return el('div', { class: 'cn-copy' },
    el('div', { class: 'cn-copy-k', text: label }),
    el('code', { class: 'cn-copy-v', text: value }),
    el('button', {
      class: 'btn-text', type: 'button', text: '복사',
      onclick: () => { void navigator.clipboard?.writeText(value).then(() => toast('복사했어요'), () => toast('복사하지 못했습니다', true)); },
    }));
}

/** 프리셋 한 벌로 조직에 등록하고(=문을 열고) 곧바로 발행(상류 툴 캡처)까지 시도한다. */
async function openForOrg(preset: any, clientId: string, clientSecret: string): Promise<void> {
  //  값은 전부 프리셋에서 온다 — 관리탭 폼이 프리셋을 골랐을 때 채우는 것과 **같은 조합**이다(mcpPresetField).
  //  레인 C(#1881 figma) — 게이트웨이가 대리하지 않는 상류다. 프록시로 심으면 상류가 거부하고, [발행]도 실패한다.
  //   조직 쪽에서 할 일은 '이 서버를 켜 두는 것' 하나뿐이고 인증은 멤버 클라이언트가 자기 OAuth 로 한다.
  const lanC = preset.mode === 'client';
  await api('/api/ui/org/mcp-server', {
    method: 'POST',
    body: JSON.stringify({
      name: preset.name, transport: 'http', url: preset.url, command: null, auth_env: null,
      note: preset.label + ' — [외부 앱 연결]에서 열었습니다', enabled: true,
      mode: lanC ? 'client' : 'proxy', scope: preset.scope, level: preset.level,
      auth_mode: lanC ? null : 'oauth', auth_kind: lanC ? null : preset.auth_kind, auth_scope_key: null,
      pii_scrub: !!preset.pii_scrub,
      log_args: false,   // #1082 — 프리셋은 전부 외부 SaaS. 호출 인자(슬랙 DM·메일 본문) 기록은 꺼진 채로 시작한다.
    }),
  });
  // 사전등록 client 가 필요한 상류(구글·슬랙)만 — (gateway, auth_kind, 'oauth:client') 슬롯에 시딩한다.
  if (clientId.trim()) {
    const seed: any = { client_id: clientId.trim() };
    if (clientSecret.trim()) seed.client_secret = clientSecret.trim();
    await api('/api/ui/org/credential', {
      method: 'POST',
      body: JSON.stringify({ kind: preset.auth_kind, scope_key: 'oauth:client', secret: JSON.stringify(seed) }),
    });
  }
  // 레인 C 는 발행하지 않는다 — 게이트웨이가 상류에 붙을 수 없어(클라이언트 allowlist) 반드시 실패하고,
  //  그 실패가 '설정이 잘못됐다'는 오해를 만든다. 도구는 멤버 PC 의 AI 도구가 직접 받는다.
  if (lanC) {
    toast(`조직에 열었어요 — 구성원 PC 의 AI 도구에 자동 등록됩니다(각자 ${preset.label} 계정으로 연결). 발행은 필요 없습니다`);
    return;
  }
  // 발행 = 상류 tools/list 캡처. 여기서 막히는 건 대개 콘솔 설정이 덜 된 경우라, 실패해도 등록 자체는 살려 둔다.
  try {
    const r: any = await api('/api/ui/org/mcp-server/refresh', { method: 'POST', body: JSON.stringify({ name: preset.name }) });
    toast(`조직에 열었어요 — 도구 ${r && r.tool_count != null ? r.tool_count : '?'}개 발행됨. 이제 [계정으로 연결]을 누르세요`);
  } catch (e: any) {
    toast('조직에 열었지만 도구 발행에 실패했어요 — ' + ((e && e.message) || e) + ' (아래 절차를 다시 확인하세요)', true);
  }
}

/** 프리셋의 셋업 안내 — **서버가 준 문장만** 쓴다(내가 지어내면 그 서비스 콘솔과 어긋난다).
 *  ⚠ 절차는 접어 둔다. 구글 프리셋은 9단계라 펴 두면 이 화면 하나가 스크롤 세 배가 된다("한 페이지에 들어가게",
 *   원준 2026-08-20). 늘 필요한 것(콘솔에 붙여넣을 값 두 개 + 입력칸)은 펴 두고, 읽는 절차만 접는다. */
function guideBlock(preset: any): HTMLElement[] {
  const cb = callbackUrl();
  const out: HTMLElement[] = [];
  const g = preset.guide;
  if (g && Array.isArray(g.steps) && g.steps.length) {
    const steps = el('ol', { class: 'cn-steps' }, ...g.steps.map((s: string) => {
      const li = el('li', {});
      String(s).split('{callback}').forEach((part, i, arr) => {
        li.append(...uiText(part));
        if (i < arr.length - 1) li.append(el('code', { text: cb }));
      });
      return li;
    }));
    out.push(el('details', { class: 'cn-steps-wrap' },
      el('summary', { class: 'cn-steps-sum', text: `${preset.label} 콘솔 설정 절차 ${g.steps.length}단계 — 처음이면 펼쳐 보세요` }),
      ...(g.intro ? [el('p', { class: 'cn-help' }, ...uiText(String(g.intro)))] : []),
      steps,
      ...(g.url ? [el('a', { class: 'btn btn-ghost btn-sm', href: g.url, target: '_blank', rel: 'noopener noreferrer', text: '설정 페이지 열기 ↗' })] : [])));
  }
  out.push(copyRow('콜백 주소(redirect URI)', cb));
  if (preset.oauth_scope) out.push(copyRow('필요한 허용범위(scope)', String(preset.oauth_scope)));
  if (preset.note) out.push(el('details', { class: 'cn-steps-wrap' },
    el('summary', { class: 'cn-steps-sum', text: '이 앱에 대해 알아 둘 것' }),
    el('p', { class: 'cn-help' }, ...uiText(String(preset.note)))));
  return out;
}

/**
 * 앱 상세 화면의 '조직' 구역. 관리자가 아니면 null(그 자리를 아예 만들지 않는다 — 못 누를 버튼을 보여주지 않는다).
 * reload 는 상세 화면 전체 재렌더.
 */
export function orgAdminSection(svc: any, org: OrgMcp | null, reload: () => void): HTMLElement | null {
  if (!org || !org.admin) return null;
  const server = orgServerOf(org, svc.key);
  const preset = presetOf(org, svc.key);
  const head = el('div', { class: 'cn-sec-h' },
    el('span', { class: 'v2-k', text: '조직 설정' }),
    el('span', { class: 'cn-adm-badge', text: '관리자만 보여요' }));

  // ── 이미 열려 있다 ──
  if (server) {
    const n = (server.tools_snapshot && server.tools_snapshot.length) || 0;
    const acts = el('div', { class: 'cn-acts' },
      el('button', {
        class: 'btn btn-ghost btn-sm', type: 'button', text: n ? '도구 목록 다시 받기' : '도구 발행하기',
        onclick: async (e: any) => {
          const b = e.currentTarget as HTMLButtonElement; b.disabled = true;
          try { const r: any = await api('/api/ui/org/mcp-server/refresh', { method: 'POST', body: JSON.stringify({ name: server.name }) }); toast(`도구 ${r && r.tool_count != null ? r.tool_count : '?'}개를 받았어요`); reload(); }
          catch (err: any) { toast((err && err.message) || '받지 못했습니다', true); b.disabled = false; }
        },
      }),
      el('button', {
        class: 'btn-text btn-text-danger', type: 'button', text: '조직에서 닫기',
        onclick: async () => {
          if (!await confirmDialog({
            title: `${svc.label} 을(를) 조직에서 닫을까요?`, danger: true, confirmText: '닫기',
            message: '팀 전체가 이 앱을 AI로 쓸 수 없게 됩니다.',
            note: '이미 연결해 둔 구성원들의 로그인도 쓸 수 없게 됩니다 — 다시 열면 각자 다시 연결해야 해요.',
          })) return;
          try { await api('/api/ui/org/mcp-server/remove', { method: 'POST', body: JSON.stringify({ name: server.name }) }); toast('조직에서 닫았어요'); reload(); }
          catch (e: any) { toast((e && e.message) || '닫지 못했습니다', true); }
        },
      }));
    return el('section', { class: 'cn-sec cn-adm' }, head,
      el('p', { class: 'cn-help' }, ...uiText(n
        ? `**조직에 열려 있어요** — 팀 누구나 자기 계정으로 연결할 수 있습니다. AI가 쓸 수 있는 도구 ${n}개가 발행돼 있어요.`
        : '**조직에 열려 있지만 아직 도구가 발행되지 않았어요** — 발행해야 세션에서 실제로 호출할 수 있습니다.')),
      acts,
      el('p', { class: 'cn-help cn-muted' }, ...uiText('전송 방식·권한 등급·PII 마스킹 같은 세부 설정은 [관리 ▸ AI 능력 ▸ AI 도구 ▸ 외부 도구 서버(MCP)] 에 있어요.')));
  }

  // ── 아직 안 열렸는데 프리셋도 없다 — 여기서 대충 만들지 않고 관리탭으로 보낸다 ──
  if (!preset) {
    return el('section', { class: 'cn-sec cn-adm' }, head,
      el('p', { class: 'cn-help' }, ...uiText('이 앱은 기본 카탈로그에 없어서 여기서 한 번에 열 수 없어요 — 주소·인증 방식을 직접 정해야 합니다.')),
      el('p', { class: 'cn-help cn-muted' }, ...uiText('[관리 ▸ AI 능력 ▸ AI 도구 ▸ 외부 도구 서버(MCP)] 에서 등록하세요.')));
  }

  // ── 프리셋으로 한 번에 열 수 있다 ──
  const dcr = !!preset.dcr;
  const idIn = el('input', { class: 'cn-in', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: '콘솔에서 발급받은 client_id' }) as HTMLInputElement;
  const secIn = el('input', { class: 'cn-in', type: 'password', autocomplete: 'new-password', placeholder: 'client_secret (있으면)' }) as HTMLInputElement;
  const openBtn = el('button', { class: 'btn btn-primary', type: 'button', text: '조직에 열기' }) as HTMLButtonElement;
  openBtn.addEventListener('click', async () => {
    if (!dcr && !idIn.value.trim()) { toast('이 앱은 콘솔에서 만든 client_id 가 필요해요', true); idIn.focus(); return; }
    openBtn.disabled = true;
    try { await openForOrg(preset, dcr ? '' : idIn.value, dcr ? '' : secIn.value); reload(); }
    catch (e: any) { toast((e && e.message) || '열지 못했습니다', true); openBtn.disabled = false; }
  });

  return el('section', { class: 'cn-sec cn-adm' }, head,
    el('p', { class: 'cn-help' }, ...uiText(dcr
      ? '**아직 조직에 열려 있지 않아요.** 이 앱은 별도 준비 없이 바로 열 수 있습니다 — 열면 팀 누구나 자기 계정으로 연결할 수 있어요.'
      : '**아직 조직에 열려 있지 않아요.** 이 앱은 먼저 그 서비스 콘솔에서 앱을 하나 만들어야 합니다(아래 절차) — 조직당 한 번이면 됩니다.')),
    ...(dcr ? [] : [
      el('div', { class: 'cn-guide' }, ...guideBlock(preset)),
      el('div', { class: 'cn-fields' },
        el('label', { class: 'cn-f' }, el('span', { class: 'cn-f-k', text: 'client_id' }), idIn),
        el('label', { class: 'cn-f' }, el('span', { class: 'cn-f-k', text: 'client_secret' }), secIn)),
    ]),
    el('div', { class: 'cn-acts' }, openBtn));
}
