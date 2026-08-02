// me-logins.ts — [내 설정 ▸ 내 서비스 로그인] 패널: 서비스별 탭 · 슬랙 대화별 열람/발송 정책 · 레포 접근
//  (#1313 R38, admin.ts 에서 verbatim 분리).
//  토큰 입력 폼(svcTokenForm)과 git 자격 오버레이는 자격 금고(admin-credentials.ts) 소유를 그대로 받아 쓴다 —
//   CRED_KINDS 스펙 표를 여기서 다시 만들지 않는다(단일 거처).
import { api, cardHead, el, errorNote, toast, uiText } from './core.js';
import { sectionHead } from './admin-widgets.js';
import { openGitCredentialManager, svcTokenForm } from './admin-credentials.js';

// ── 내 서비스 로그인 — 서비스별 탭(#762). 방식(OAuth/토큰) 대신 '어떤 서비스'로 묶어 비개발자도 직관적으로. ──
//  탭 = 조직에 등록/연결된 서비스. [＋ 서비스 연결]에서 토큰형 서비스를 셀프 추가(OAuth 미등록 서비스는 관리자 몫).
const LOGIN_SERVICES: Array<{ key: string; label: string; icon: string; oauth?: string; token?: string; blurb: string }> = [
  // blurb — '무엇을 허용하는 것인지'를 그대로 말한다(#1085). '나로서 …해요' 는 무슨 일이 벌어지는지 모호했다.
  { key: 'notion', label: 'Notion', icon: '📔', oauth: 'notion', blurb: 'AI가 내 Notion 계정에 로그인해서 직접 문서를 읽고 작성할 수 있습니다.' },
  { key: 'linear', label: 'Linear', icon: '📐', oauth: 'linear', blurb: 'AI가 내 Linear 계정에 로그인해서 직접 이슈를 보고 만들 수 있습니다.' },
  { key: 'slack', label: 'Slack', icon: '💬', oauth: 'slack', token: 'slack_user_token', blurb: 'AI가 내 Slack 계정에 로그인해서 직접 메시지를 검색하고 보낼 수 있습니다.' },
  { key: 'google-gmail', label: 'Gmail', icon: '✉️', oauth: 'google-gmail', blurb: 'AI가 내 Gmail 계정에 로그인해서 직접 메일을 읽고 보낼 수 있습니다.' },
  { key: 'google-drive', label: 'Google Drive', icon: '📁', oauth: 'google-drive', blurb: 'AI가 내 Google Drive 계정에 로그인해서 직접 파일을 읽을 수 있습니다.' },
  { key: 'google-calendar', label: 'Google 캘린더', icon: '📅', oauth: 'google-calendar', blurb: 'AI가 내 Google 캘린더 계정에 로그인해서 직접 일정을 확인할 수 있습니다.' },
  { key: 'github', label: 'GitHub', icon: '🐙', token: 'github_pat', blurb: 'AI가 내 GitHub 계정에 로그인해서 직접 이슈·PR·저장소를 다룰 수 있습니다.' },
  { key: 'gitlab', label: 'GitLab', icon: '🦊', token: 'gitlab_pat', blurb: 'AI가 내 GitLab 계정에 로그인해서 직접 MR·저장소를 다룰 수 있습니다.' },
  { key: 'clickup', label: 'ClickUp', icon: '🗂️', token: 'clickup_token', blurb: 'AI가 내 ClickUp 계정에 로그인해서 직접 작업을 확인할 수 있습니다.' },
  { key: 'figma', label: 'Figma', icon: '🎨', token: 'figma_token', blurb: 'AI가 내 Figma 계정에 로그인해서 직접 디자인을 읽을 수 있습니다.' },
  { key: 'prometheus', label: 'Prometheus', icon: '📊', token: 'prometheus_bearer', blurb: 'AI가 내 Prometheus 계정에 로그인해서 직접 지표를 조회할 수 있습니다.' },
  { key: 'claude-headless', label: 'Claude (헤드리스 실행)', icon: '🤖', token: 'claude_setup_token', blurb: '헤드리스 분류·에이전트 크론(claude -p)이 내 Claude 계정으로 인증·실행됩니다 — 터미널에서 `claude setup-token` 으로 발급한 토큰을 등록하세요(구독 크레딧 과금).' },
];

async function renderServiceTabs(host: any) {
  host.replaceChildren(el('p', { class: 'admin-hint', style: 'margin:0' }, ...uiText('불러오는 중…')));
  let creds: any = { credentials: [] }, oauth: any = { connectors: [] };
  try {
    creds = await api('/api/ui/me/credentials');
    oauth = await api('/api/ui/me/oauth/connectors').catch(() => ({ connectors: [] }));
  } catch (e: any) { host.replaceChildren(errorNote(e, '내 로그인을 불러오지 못했습니다')); return; }
  const oauthMap = new Map<string, any>((oauth.connectors || []).map((c: any) => [c.server, c]));
  const credMap = new Map<string, any>((creds.credentials || []).filter((c: any) => c.kind !== 'aws_role_arn').map((c: any) => [c.kind, c]));
  const isReg = (s: any) => !!((s.oauth && oauthMap.has(s.oauth)) || (s.token && credMap.has(s.token)));
  const isOn = (s: any) => !!((s.oauth && oauthMap.get(s.oauth) && oauthMap.get(s.oauth).connected) || (s.token && credMap.get(s.token) && credMap.get(s.token).has_secret));
  const tabs = LOGIN_SERVICES.filter(isReg);
  const addable = LOGIN_SERVICES.filter((s) => !isReg(s) && s.token); // 토큰형은 셀프 추가 가능
  const reload = () => renderServiceTabs(host);

  if (!tabs.length) {
    host.replaceChildren(
      el('p', { class: 'admin-hint', style: 'margin:0 0 12px' }, ...uiText('아직 연결한 서비스가 없어요. 아래에서 골라 연결해요.')),
      addPanel(addable, reload));
    return;
  }

  let active = tabs[0].key;
  const tabBar = el('div', { class: 'chips svc-tabs' });
  const body = el('div', { class: 'svc-tab-body' });
  const draw = () => {
    const mkTab = (key: string, label: string, icon: string, ok: boolean) => {
      const b = el('button', { type: 'button', class: 'chip svc-tab' + (active === key ? ' on' : '') },
        icon ? el('span', { class: 'svc-tab-ic', text: icon }) : null,
        el('span', { text: label }),
        ok ? el('span', { class: 'svc-tab-dot', title: '연결됨' }) : null);
      b.onclick = () => { active = key; draw(); };
      return b;
    };
    tabBar.replaceChildren(
      ...tabs.map((s) => mkTab(s.key, s.label, s.icon, isOn(s))),
      mkTab('__add__', '＋ 서비스 연결', '', false));
    if (active === '__add__') body.replaceChildren(addPanel(addable, reload));
    else body.replaceChildren(servicePanel(tabs.find((x) => x.key === active) || tabs[0], oauthMap, credMap, reload));
  };
  host.replaceChildren(tabBar, body);
  draw();
}

// 선택한 서비스 패널 — 상태 + 연결/해제(OAuth) 또는 토큰 상태/삭제/입력.
function servicePanel(svc: any, oauthMap: Map<string, any>, credMap: Map<string, any>, reload: () => void) {
  const oc = svc.oauth ? oauthMap.get(svc.oauth) : null;
  const cred = svc.token ? credMap.get(svc.token) : null;
  const on = !!((oc && oc.connected) || (cred && cred.has_secret));
  const wrap = el('div', {},
    el('div', { class: 'svc-panel-head' },
      el('span', { class: 'svc-panel-ic', text: svc.icon }),
      el('span', { class: 'svc-panel-nm', text: svc.label }),
      el('span', { class: 'pill' + (on ? ' pill-ok' : ''), text: on ? '연결됨 ✓' : '미연결' })),
    el('p', { class: 'admin-hint', style: 'margin:6px 0 14px' }, ...uiText(svc.blurb)));
  if (oc) {
    const connectBtn = el('button', { class: 'btn btn-sm ' + (oc.connected ? 'btn-ghost' : 'btn-primary'), text: oc.connected ? '다시 연결' : '연결',
      onclick: async () => {
        try {
          const r = await api('/api/ui/me/oauth/connect', { method: 'POST', body: JSON.stringify({ server: svc.oauth }) });
          if (r.authorized) { toast('이미 연결됨'); reload(); return; }
          window.open(r.authorization_url, '_blank', 'noopener'); toast('새 탭에서 로그인·동의하세요 — 완료 후 [새로고침]');
        } catch (e: any) { toast(e.message, true); }
      } });
    const discBtn = oc.connected ? el('button', { class: 'btn-text btn-text-danger', style: 'margin-left:auto', text: '연결 해제',
      onclick: async () => { if (!confirm(svc.label + ' 연결을 해제할까요?')) return; try { await api('/api/ui/me/oauth/disconnect', { method: 'POST', body: JSON.stringify({ server: svc.oauth }) }); toast('해제됨'); reload(); } catch (e: any) { toast(e.message, true); } } }) : null;
    wrap.append(el('div', { class: 'admin-actions', style: 'margin:0' }, connectBtn, el('button', { class: 'btn-text', text: '새로고침', onclick: reload }), discBtn));
  }
  if (svc.token) {
    if (cred) {
      wrap.append(el('div', { class: 'svc-item', style: 'margin-top:12px' },
        el('span', { class: 'mini-meta', text: '토큰 등록됨 ✓' + (cred.scope_key ? ' · ' + cred.scope_key : '') }),
        el('span', { class: 'svc-item-actions' }, el('button', { class: 'btn btn-ghost btn-sm', text: '삭제',
          onclick: async () => { if (!confirm(svc.label + ' 토큰을 삭제할까요?')) return; try { await api('/api/ui/me/credential/delete', { method: 'POST', body: JSON.stringify({ kind: svc.token, scope_key: cred.scope_key || '' }) }); toast('삭제됨'); reload(); } catch (e: any) { toast((e && e.message) || '삭제 실패', true); } } }))));
    } else if (!oc) {
      wrap.append(el('div', { style: 'margin-top:12px' }, svcTokenForm(svc.token, reload)));
    }
  }
  // #1226 — 연결한 다음이 진짜 문제다: 슬랙은 **워크스페이스 통째로만** 권한을 준다(채널별 거부가 없다).
  //  그래서 '연결했다 = 내가 속한 모든 대화가 AI 에게 열렸다' 가 된다. 그걸 여기서 채널 단위로 되돌린다.
  if (svc.key === 'slack' && on) wrap.append(slackChannelPolicyCard());
  return wrap;
}

// ── [Slack] 대화별 열람·발송 허용(#1226 · 기본값 재설계 #1262) ──
//  체크를 끄면 그 대화는 AI 의 슬랙 호출에서 걸러진다(게이트웨이가 요청을 막고 응답에서 지운다).
//  #1262: **기본값이 대화 종류로 갈린다** — 공개 채널은 열려 있고, 비공개·그룹DM·DM 은 닫혀 있다.
//   그래서 화면이 '지금 켜져 있나' 만 보여주면 부족하다. 왜 그 상태인지(기본값인지 내가 바꾼 건지)를 같이
//   보여줘야 하고, **규칙 자체를 화면에서 설명해야 한다** — 이건 슬랙 기능이 아니라 우리가 만든 동작이라,
//   설명이 없으면 사람은 "왜 AI 가 이 채널을 못 읽지?" 를 알아낼 방법이 아예 없다.
const CH_TYPE_LABEL: Record<string, string> = { public: '공개', private: '비공개', group_dm: '그룹 DM', dm: 'DM', unknown: '목록 밖' };

// 규칙 설명 — 기술 용어 없이. '무엇이 기본인지 · 왜 그런지 · 새로 생기는 대화는 어떻게 되는지' 세 가지를 답한다.
function channelRuleExplainer() {
  const rule = (icon: string, title: string, body: string) => el('div', { style: 'display:flex; gap:9px; align-items:flex-start; padding:7px 0' },
    el('span', { style: 'font-size:15px; line-height:1.35', text: icon }),
    el('span', { style: 'display:flex; flex-direction:column; gap:1px' },
      el('span', { class: 'mini-title', text: title }),
      el('span', { class: 'mini-meta' }, ...uiText(body))));
  return el('div', { style: 'margin:0 0 12px' },
    el('p', { class: 'admin-hint', style: 'margin:0 0 4px' }, ...uiText(
      '슬랙은 “이 채널만 빼고” 같은 권한을 주지 않습니다 — 한 번 연결하면 내가 볼 수 있는 대화가 통째로 열려요. '
      + '그래서 라이블리가 대신 걸러 줍니다. 아무것도 설정하지 않아도 아래 규칙이 자동으로 적용됩니다.')),
    rule('🌐', '공개 채널 — 처음부터 열려 있어요',
      'AI 가 읽고 보낼 수 있습니다. 워크스페이스 사람이면 누구나 볼 수 있는 대화라 기본을 열어 둡니다. 보여주고 싶지 않으면 체크를 끄세요.'),
    rule('🔒', '비공개 채널 · 그룹 DM · 1:1 DM — 처음부터 닫혀 있어요',
      'AI 가 읽지도, 보내지도 못합니다. 필요한 대화만 직접 체크를 켜서 여세요.'),
    el('p', { class: 'admin-hint', style: 'margin:6px 0 0' }, ...uiText(
      '나중에 새로 만들어지거나 새로 초대된 대화도 같은 규칙을 따릅니다 — 비공개 대화는 내가 직접 켜기 전까지 계속 닫혀 있어요. '
      + '연결만 해 두고 잊어버려도 사적인 대화가 새지 않습니다.')));
}

function slackChannelPolicyCard() {
  const listBox = el('div', { class: 'svc-list' });
  const summary = el('p', { class: 'admin-hint', style: 'margin:0 0 10px' }, ...uiText('불러오는 중…'));
  const search = el('input', { type: 'search', placeholder: '채널 이름으로 찾기', style: 'max-width:260px' });
  const notice = el('div');
  let all: any[] = [];

  const label = (c: any) => (c.type === 'dm' || c.type === 'group_dm' ? c.name : '#' + String(c.name || '').replace(/^#/, ''));
  const isDefault = (c: any) => c.allow_read === c.default_read && c.allow_write === c.default_write;
  let connected = true;
  const paint = () => {
    // '목록이 비었다'를 '전부 허용'이라고 말하면 거짓 안심이 된다 — 연결이 없어서 못 읽은 것과 구분한다.
    if (!connected) { summary.replaceChildren(...uiText('슬랙 연결을 확인하지 못했습니다 — 위에서 [연결]을 마치면 내가 속한 대화가 여기에 뜹니다.')); return; }
    if (!all.length) { summary.replaceChildren(...uiText('내가 속한 대화를 찾지 못했습니다. 슬랙에서 채널에 참여한 뒤 [새로고침]하세요.')); return; }
    // 사람이 알고 싶은 건 '몇 개가 AI 에게 열려 있나' 다. 닫힌 개수는 그 나머지로 자연히 읽힌다.
    const open = all.filter((c) => c.allow_read).length;
    const closed = all.length - open;
    summary.replaceChildren(...uiText(
      `대화 ${all.length}개 중 AI 가 읽을 수 있는 건 ${open}개입니다`
      + (closed ? ` — 나머지 ${closed}개는 닫혀 있어요.` : '.')));
  };
  const rowOf = (c: any) => {
    const mk = (checked: boolean) => { const b = el('input', { type: 'checkbox' }); b.checked = checked; return b; };
    const readChk = mk(c.allow_read), writeChk = mk(c.allow_write);
    const badges = el('span', { style: 'display:inline-flex; gap:4px; align-items:center' });
    const resetWrap = el('span');
    const paintRow = () => {
      badges.replaceChildren(
        el('span', { class: 'pill', text: CH_TYPE_LABEL[c.type] || c.type }),
        // 기본값 그대로면 굳이 배지를 달지 않는다(대부분이 그 상태라 시끄럽기만 하다).
        ...(isDefault(c) ? [] : [el('span', { class: 'pill', text: '직접 설정' })]));
      resetWrap.replaceChildren(...(isDefault(c) ? [] : [el('button', {
        class: 'btn-text', text: '기본값으로',
        onclick: () => { readChk.checked = c.default_read; writeChk.checked = c.default_write; void save(); },
      })]));
    };
    const save = async () => {
      readChk.disabled = writeChk.disabled = true;
      try {
        await api('/api/ui/me/channel-policy', { method: 'POST', body: JSON.stringify({
          system: 'slack', channel_id: c.id, channel_name: c.name,
          // 대화 종류 — 서버가 '기본값과 같아졌는지'를 판정하고, 집행 때 쓸 종류 캐시도 이 값으로 채운다.
          channel_type: c.type,
          // DM 은 상대 user_id 도 보낸다 — 슬랙이 DM 을 U… 로도 열어서, 이게 없으면 그 경로로 차단이 뚫린다.
          ...(c.peer_id ? { peer_id: c.peer_id } : {}),
          allow_read: readChk.checked, allow_write: writeChk.checked }) });
        c.allow_read = readChk.checked; c.allow_write = writeChk.checked;
        paintRow(); paint();
      } catch (e: any) {
        readChk.checked = c.allow_read; writeChk.checked = c.allow_write;   // 저장 실패 = 화면도 되돌린다(거짓 안심 방지)
        toast((e && e.message) || '저장하지 못했습니다', true);
      }
      readChk.disabled = writeChk.disabled = false;
    };
    readChk.addEventListener('change', () => void save());
    writeChk.addEventListener('change', () => void save());
    const box = (chk: any, text: string) => el('label', { style: 'display:inline-flex; align-items:center; gap:5px; font-size:12.5px; color:var(--ink-sub); cursor:pointer' }, chk, el('span', { text }));
    paintRow();
    return el('div', { class: 'svc-item' },
      el('span', { class: 'svc-item-main' },
        el('span', { class: 'mini-title' }, el('span', { text: label(c) }), badges),
        c.from_policy ? el('span', { class: 'mini-meta' }, ...uiText('지금 내 대화 목록엔 없습니다(나갔거나 권한 밖) — 설정만 남아 있어요.')) : null),
      el('span', { class: 'svc-item-actions' }, resetWrap, box(readChk, '열람'), box(writeChk, '발송')));
  };
  const draw = () => {
    const q = String(search.value || '').trim().toLowerCase();
    const rows = all.filter((c) => !q || String(c.name || '').toLowerCase().includes(q) || String(c.id).toLowerCase().includes(q));
    listBox.replaceChildren(...(rows.length ? rows.map(rowOf) : [el('p', { class: 'admin-hint', style: 'margin:0' }, ...uiText('찾는 대화가 없습니다.'))]));
  };
  search.addEventListener('input', draw);

  const load = async () => {
    let d: any;
    try { d = await api('/api/ui/me/slack/channels'); }
    catch (e: any) { summary.replaceChildren(); listBox.replaceChildren(errorNote(e, '대화 목록을 불러오지 못했습니다')); return; }
    all = d.channels || [];
    connected = d.connected !== false;
    const notes: any[] = [];
    // 목록을 못 받은 경우에도 이미 저장된 설정은 보여 준다 — 그래야 잘못 걸어 둔 차단을 풀 수 있다.
    if (d.error) notes.push(el('p', { class: 'admin-hint', style: 'margin:0 0 8px' }, ...uiText('슬랙에서 대화 목록을 받지 못했습니다(' + d.error + '). 아래는 이미 저장해 둔 설정입니다.')));
    if (d.warning) notes.push(el('p', { class: 'admin-hint', style: 'margin:0 0 8px' }, ...uiText(d.warning)));
    notice.replaceChildren(...notes);
    paint(); draw();
  };
  void load();

  return el('div', { class: 'card', style: 'margin-top:14px' },
    cardHead('대화별 열람 · 발송 허용', 'AI 가 내 슬랙에서 무엇을 읽고 어디로 보낼 수 있는지 대화 단위로 정합니다. 여기서 끄면 게이트웨이가 AI 의 슬랙 요청에서 그 대화를 걸러냅니다.'),
    channelRuleExplainer(),
    notice, summary,
    el('div', { class: 'admin-actions', style: 'margin:0 0 10px' }, search, el('button', { class: 'btn-text', text: '새로고침', onclick: () => void load() })),
    el('div', { style: 'max-height:420px; overflow:auto' }, listBox));
}

// 추가 패널 — 지원하지만 아직 연결 안 한 서비스. [연결] 시 그 서비스 토큰 폼을 인라인으로 편다.
function addPanel(addable: any[], reload: () => void) {
  const wrap = el('div', {});
  if (!addable.length) { wrap.append(el('p', { class: 'admin-hint', style: 'margin:0' }, ...uiText('추가로 연결할 서비스가 없어요.'))); return wrap; }
  const list = el('div', { class: 'svc-list' });
  addable.forEach((s) => {
    const btn = el('button', { class: 'btn btn-primary btn-sm', text: '연결' });
    const row = el('div', { class: 'svc-item' },
      el('span', { class: 'svc-panel-ic', style: 'font-size:19px', text: s.icon }),
      el('span', { class: 'svc-item-main' }, el('span', { class: 'mini-title', text: s.label }), el('span', { class: 'mini-meta' }, ...uiText(s.blurb))),
      el('span', { class: 'svc-item-actions' }, btn));
    btn.onclick = () => {
      const next = row.nextElementSibling as HTMLElement | null;
      if (next && next.classList.contains('svc-inline-form')) { next.remove(); return; }
      row.after(el('div', { class: 'svc-inline-form', style: 'margin:-2px 0 2px' }, svcTokenForm(s.token, reload)));
    };
    list.append(row);
  });
  wrap.append(list);
  wrap.append(el('p', { class: 'admin-hint', style: 'margin:12px 0 0' }, ...uiText('Google 등 OAuth로만 연결되는 서비스는 관리자가 조직에 등록하면 위 탭에 떠요.')));
  return wrap;
}

// ── [내 설정 ▸ 내 서비스 로그인] — member_secret vault + OAuth 연결 + git 인증 ──
async function myLoginsSection(detail) {
  // #762 서비스별 탭 재설계 — 헤더 + [서비스 로그인(탭)] + [레포 접근(개발자용)]. 방식(OAuth/토큰) 노출 안 함.
  // 제목은 카드에 고정하고, 탭 본문만 안쪽 host 에 그린다 — renderServiceTabs 가 replaceChildren 이라 제목이 같이 지워지면 안 된다.
  const svcHost = el('div');
  const svcCard = el('div', { class: 'card' },
    cardHead('서비스 로그인', 'AI 가 나를 대신해 이 서비스를 쓰려면 내 계정을 연결해야 합니다. 연결은 나에게만 적용되고, 토큰 값은 저장 후 다시 볼 수 없습니다.'),
    svcHost);
  const gitCard = el('div', { class: 'card' },
    cardHead('리포지토리 접근', '코드 저장소(GitHub·GitLab)에서 클론·푸시할 때 쓰는 SSH 키·토큰입니다. 코드 작업을 하지 않으면 설정하지 않아도 됩니다.', el('span', { class: 'head-badge head-badge-aud', text: '개발자용' })),
    el('div', { class: 'admin-actions' },
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'git 인증 관리', onclick: () => openGitCredentialManager('me') })));
  detail.replaceChildren(
    sectionHead('외부 서비스 관리', 'AI가 내 계정으로 외부 서비스를 쓸 수 있게 연결하고, 연결한 뒤 어디까지 허용할지 정합니다. 여기 설정은 나에게만 적용되고 팀에는 공유되지 않습니다.'),
    el('div', { class: 'admin-stack' }, svcCard, gitCard));
  await renderServiceTabs(svcHost);
}

export {
  CH_TYPE_LABEL,
  LOGIN_SERVICES,
  addPanel,
  channelRuleExplainer,
  myLoginsSection,
  renderServiceTabs,
  servicePanel,
  slackChannelPolicyCard,
};
