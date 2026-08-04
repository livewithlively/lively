// admin-login-idp.ts — [로그인 · 회사 계정] 패널(#1520). 구성원이 조직 IdP(구글 워크스페이스·Azure AD·Okta)
//  계정으로 웹에 로그인하게 켜는 자리.
//
//  왜 관리탭인가: 종전엔 배포 .env 에만 넣을 수 있었는데, 고객 실박스가 SSM 전용이면 .env 편집이 비현실적이다
//   (secret-box.ts 머리주석의 컨벤션 확장과 같은 사정). 그래서 여기서 넣고 **재시작 없이** 먹게 한다.
//   env(OIDC_*)로 설정한 배포는 그대로 동작한다 — 관리탭을 끄면 env 로 되돌아간다.
//
//  ⚠ 시크릿 입력칸은 type=password 가 아니라 **텍스트칸 + 가림**(markSecretInput)이다 — password 는
//   '이 사이트 계정의 비밀번호'에만 쓴다(브라우저 비밀번호 관리자가 저장을 제안하는 오작동 방지, #1250).
import { api, cardHead, el, markSecretInput, toast, uiText } from './core.js';
import { field } from './ui-primitives.js';
import { sectionHead } from './admin-widgets.js';

function loginIdpEditor(detail: any, data: any) {
  const canEdit = !!data.canEdit;
  const body = el('div');
  detail.replaceChildren(
    sectionHead('로그인 · 회사 계정',
      '구성원이 회사 구글·SSO 계정으로 로그인하게 합니다. 켜도 이메일·비밀번호 로그인은 그대로 남습니다(IdP 장애 시 들어올 길).'),
    el('div', { class: 'card' }, cardHead('회사 계정 로그인(OIDC)'), body));
  body.append(el('p', { class: 'admin-hint' }, ...uiText('불러오는 중…')));

  const callbackUrl = location.origin + '/api/ui/auth/oidc/callback';

  (async () => {
    let cfg: any;
    try {
      const res = await api('/api/ui/org/runtime-config');
      cfg = res && res.config && res.config.oidc_config;
      if (!cfg) throw new Error('설정을 읽지 못했습니다(관리자 권한이 필요합니다).');
    } catch (e: any) {
      body.replaceChildren(el('p', { class: 'admin-hint' }, ...uiText((e && e.message) || '설정을 불러오지 못했습니다.')));
      return;
    }
    render(cfg);
  })();

  function statusBanner(cfg: any) {
    // '저장했는데 왜 안 되지'를 없애는 자리 — 지금 실제로 무엇이 쓰이는지 그대로 말한다.
    if (cfg.source === 'db') {
      return el('div', { class: 'box' }, ...uiText('✅ 지금 이 화면의 설정으로 회사 계정 로그인이 켜져 있습니다.'));
    }
    if (cfg.source === 'env') {
      return el('div', { class: 'box' }, ...uiText(
        '지금은 서버 설정(.env 의 OIDC_*)으로 켜져 있습니다. 아래에서 저장하면 이 화면의 설정이 우선합니다.'));
    }
    const why = cfg.enabled
      ? '켜기는 했지만 issuer·클라이언트 ID·시크릿 중 빠진 값이 있어 아직 동작하지 않습니다.'
      : '아직 꺼져 있습니다 — 로그인 화면에는 이메일·비밀번호만 보입니다.';
    return el('div', { class: 'box' }, ...uiText(why));
  }

  function render(cfg: any) {
    const enabled = el('input', { type: 'checkbox' }) as any;
    enabled.checked = !!cfg.enabled;
    const issuer = el('input', { type: 'text', value: cfg.issuer || '', placeholder: 'https://accounts.google.com' }) as any;
    const clientId = el('input', { type: 'text', value: cfg.client_id || '', placeholder: 'xxxxx.apps.googleusercontent.com' }) as any;
    const secret = el('input', {
      type: 'text', value: '',
      placeholder: cfg.client_secret_set ? '설정됨 — 바꿀 때만 입력하세요' : '구글 콘솔에서 발급된 시크릿',
    }) as any;
    markSecretInput(secret); // 텍스트칸 + 가림(위 주석)
    const domains = el('input', {
      type: 'text', value: (cfg.allowed_domains || []).join(', '), placeholder: 'honest.ai (비우면 자동 가입 없음)',
    }) as any;
    const label = el('input', { type: 'text', value: cfg.label || '', placeholder: '비우면 issuer 로 자동(예: Google 계정으로 로그인)' }) as any;

    const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' }) as any;
    saveBtn.disabled = !canEdit;
    const status = el('span', { class: 'admin-status' });

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      const payload: any = {
        enabled: !!enabled.checked,
        issuer: issuer.value.trim(),
        client_id: clientId.value.trim(),
        allowed_domains: domains.value,
        label: label.value.trim() || null,
      };
      // 시크릿은 **입력했을 때만** 보낸다 — 빈 칸으로 저장해도 기존 시크릿이 지워지지 않게(3상태 중 '보존').
      if (secret.value.trim()) payload.client_secret = secret.value.trim();
      try {
        await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ oidc_config: payload }) });
        toast('저장했습니다. 로그인 화면을 새로고침하면 반영됩니다.');
        secret.value = '';
        const res = await api('/api/ui/org/runtime-config');
        render(res.config.oidc_config);
      } catch (e: any) {
        toast((e && e.message) || '저장하지 못했습니다', true);
        saveBtn.disabled = !canEdit ? true : false;
      }
    });

    // 시크릿 제거 — 켜 둔 채 시크릿만 지우면 동작이 멈추므로, 끄기와 함께 안내한다.
    const clearBtn = el('button', { class: 'btn btn-sm', text: '시크릿 지우기' }) as any;
    clearBtn.disabled = !canEdit || !cfg.client_secret_set;
    clearBtn.addEventListener('click', async () => {
      clearBtn.disabled = true;
      try {
        await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ oidc_config: { client_secret: null } }) });
        toast('시크릿을 지웠습니다.');
        const res = await api('/api/ui/org/runtime-config');
        render(res.config.oidc_config);
      } catch (e: any) { toast((e && e.message) || '지우지 못했습니다', true); clearBtn.disabled = false; }
    });

    const cbBox = el('div', { class: 'admin-ro', style: 'word-break:break-all' }, callbackUrl);
    const copyBtn = el('button', { class: 'btn btn-sm', text: '복사' }) as any;
    copyBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(callbackUrl); toast('복사했습니다.'); }
      catch (_) { toast('복사하지 못했습니다 — 주소를 직접 선택해 복사하세요', true); }
    });

    body.replaceChildren(
      statusBanner(cfg),
      el('p', { class: 'admin-hint' }, ...uiText(
        'IdP 콘솔(구글 Cloud Console ▸ Google Auth Platform)에서 웹 애플리케이션 클라이언트를 만들고, ' +
        '아래 리디렉션 주소를 그대로 등록한 뒤 발급된 클라이언트 ID·시크릿을 여기 넣으세요. ' +
        '구글 워크스페이스라면 Audience 를 Internal 로 두면 조직 구성원만 로그인할 수 있고 구글 검증 절차도 없습니다.')),
      field('IdP 에 등록할 리디렉션 주소', el('div', { style: 'display:flex; gap:8px; align-items:center; flex-wrap:wrap' }, cbBox, copyBtn)),
      field('회사 계정 로그인 사용', el('label', { style: 'display:flex; gap:8px; align-items:center' }, enabled,
        el('span', { class: 'admin-hint', style: 'margin:0' }, ...uiText('끄면 이메일·비밀번호만 남습니다.')))),
      field('issuer (IdP 주소)', issuer),
      field('클라이언트 ID', clientId),
      field('클라이언트 시크릿', el('div', { style: 'display:flex; gap:8px; align-items:center; flex-wrap:wrap' }, secret, clearBtn)),
      field('자동 가입 허용 도메인 (쉼표로 구분)', el('div', {}, domains,
        el('p', { class: 'admin-hint', style: 'margin:6px 0 0' }, ...uiText(
          '이 도메인의 회사 이메일이면 첫 로그인에 구성원이 자동으로 만들어집니다(권한은 지식·프로젝트 조회만). ' +
          '비우면 미리 등록된 구성원만 로그인할 수 있습니다.')))),
      field('로그인 버튼 문구', label),
      el('div', { class: 'admin-actions' }, saveBtn, status));
  }
}

export { loginIdpEditor };
