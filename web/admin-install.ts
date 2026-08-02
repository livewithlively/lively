// admin-install.ts — 설치 한 줄·토큰 발급·유지보수 명령 (#1313 R37, admin.ts 에서 verbatim 분리).
//  ⚠ 사용 가이드(web/learn.ts)가 installCmd·deployCommands 를 admin.js 에서 import 한다 — learn.ts 를 건드리지
//   않으려고 admin.ts 가 이 모듈을 그대로 재수출한다(소비자 import 문 무변경 계약).
import { api, el, toast, uiText } from './core.js';
import { copyButton } from './ui-primitives.js';
import { loadAdmin } from './admin-rerender.js';

// 설치 한 줄 명령(OS별) — #864 부터 **lively CLI 부트스트랩**이다. 사용 가이드(web/learn.ts)가 쓴다.
//
//  ⚠ 이 줄에는 토큰이 없다. 종전엔 여기서 장기 토큰을 명령줄에 리터럴로 박았고, 그게 그대로
//  ~/.zsh_history 에 영구히 남았다(화면공유·클립보드 매니저 노출). 이제 이 줄은 CLI 를 깔기만 하고,
//  토큰은 CLI 의 `lively login` 이 /dev/tty **가림 입력**으로 받는다(어디에도 안 남음).
//  부트스트랩은 TTY 가 있으면 곧장 `lively setup`(로그인+설치)으로 인계하므로 사용자는 여전히 **한 번만 복사**한다.
//
//  또 하나의 이득: 설치 로직이 CLI(Node) 한 곳으로 모여 mac/win 이 **같은 코드**를 돈다.
//  (종전 PowerShell 판은 1,400자짜리 한 줄이라 사실상 아무도 검증하지 못했다 — 그래서 계속 '미검증' 이었다.)
function installCmd(gw, os) {
  if (os === 'windows') return `irm ${gw}/cli.ps1 | iex`;
  return `curl -fsSL ${gw}/cli | sh`;
}

// ── 접속 열쇠(토큰) 발급 — 구성원을 골라 발급하고 설치 한 줄을 건넨다. [구성원 ▸ 접속 열쇠] 안. ──
function installMinterBlock(data, gw, opts: any = {}) {
  const result = el('div', {});
  const sel = el('select', {}, ...(data.members || []).map((m) =>
    el('option', { value: m.id, text: (m.display_name || m.id) + ' · ' + ((m.scopes || []).join('/') || '-') })));
  if (opts.preselectId && (data.members || []).some((m) => m.id === opts.preselectId)) sel.value = opts.preselectId;
  const go = el('button', { class: 'btn btn-primary btn-sm', text: '토큰 발급' });
  go.addEventListener('click', async () => {
    const m = (data.members || []).find((x) => x.id === sel.value) || { id: sel.value };
    if (!m.id) { toast('구성원을 선택하세요', true); return; }
    go.disabled = true;
    try {
      const r = await api('/api/ui/org/token', { method: 'POST',
        body: JSON.stringify({ userId: m.id, memberId: m.id, label: m.display_name || m.id }) });
      const name = m.display_name || m.id;
      const webUrl = gw + '/ui/';
      result.replaceChildren(
        el('p', { class: 'install-ok', text: '✓ ' + name + ' 님 접속 토큰이 발급됐어요 (권한: ' + r.scopes.join('/') + ').' }),
        el('p', { class: 'admin-hint', text: '아래 토큰을 ' + name + ' 님에게 1:1로 전달하세요. 받은 분의 AI·lively 명령이 이 토큰으로 게이트웨이에 접속합니다.' }),
        el('div', { class: 'deploy-head' }, el('span', { class: 'mini-meta' }, ...uiText('발급된 토큰')), copyButton(() => r.token, '토큰 복사')),
        el('pre', { class: 'admin-preview', text: r.token }),
        el('ol', { class: 'minter-steps' },
          el('li', {}, ...uiText('[토큰 복사]'), ' 버튼으로 토큰을 복사하세요.'),
          el('li', {}, name + ' 님에게 ', el('b', { text: '1:1로(슬랙·메신저 DM 등) 전달' }), '하세요 — 토큰은 비밀번호 같은 거라 공개 채널·단톡방엔 올리지 마세요.'),
          el('li', {}, name + ' 님은 ', el('a', { href: webUrl, target: '_blank', rel: 'noopener', text: webUrl }), ' 로그인 화면에서 ', ...uiText('[토큰으로 로그인]'), ' 을 눌러 이 토큰을 붙여넣으면 들어옵니다. 이메일·비밀번호 계정을 이미 받았다면 그대로 로그인해도 됩니다.')),
        el('p', { class: 'admin-hint' }, ...uiText('⚠ 이 토큰은 지금 이 화면에서만 보여요 — 닫으면 다시 볼 수 없습니다(잃어버리면 다시 발급하면 돼요).')),
        el('p', { class: 'admin-hint' }, ...uiText('내 컴퓨터 터미널(Claude Code·Codex)에서 직접 쓰실 분은 — 같은 토큰으로 [사용 가이드 › 시작하기] 안내를 따르면 됩니다.')));
      await loadAdmin(true);
    } catch (e) { toast(e.message, true); }
    go.disabled = false;
  });
  return el('div', { class: 'deploy-block' },
    el('h3', { class: 'member-add-step', text: opts.title || '토큰 발급 (새 팀원 추가)' }),
    // ⚠ 사실 확인(#1085): 최초 웹 로그인은 **이메일 + 임시 비밀번호**다(deploy/bootstrap-admin.mjs 가 첫 관리자에게,
    //  [구성원] 추가가 팀원에게 임시 비밀번호를 1회 발급). 토큰은 웹 로그인 필수물이 아니라 **AI·CLI 접속용 열쇠**다
    //  — 한때 '최초 1회 로그인 시 필요'라고 적었다가 코드로 확인해 바로잡았다.
    el('p', { class: 'admin-hint' }, ...uiText('구성원을 고르고 [토큰 발급]을 누르면 그 사람 전용 토큰이 만들어집니다. 구성원의 AI(Claude Code·Codex)와 lively 명령이 라이블리에 접속할 때 필요합니다. 토큰을 발급해 해당 구성원에게 전달해주세요. (웹 로그인은 이메일·비밀번호로 하며 토큰이 없어도 됩니다.)')),
    el('div', { class: 'install-minter' }, sel, go),
    result);
}

// 유지보수 명령 — #864 부터 **OS 무관**이다(lively CLI 가 mac/win 을 흡수). gw/os 는 부트스트랩 폴백 안내에만 쓴다.
//  종전엔 여기 OS별로 갈라진 1,400자 PowerShell 과 sed 범벅 bash 가 각각 들어 있었다.
function deployCommands(gw, os) {
  // `lively` 가 아직 없는 경우(자동 업데이트 전) 어떻게 되찾는지 — 모든 note 의 공통 꼬리.
  const boot = os === 'windows' ? `irm ${gw}/cli.ps1 | iex` : `curl -fsSL ${gw}/cli | sh`;
  const ifMissing = `\n\n※ 'lively: command not found' 가 나오면 — 새 터미널을 열어 보고(설치 직후엔 PATH 가 현 창에 아직 없습니다), 그래도 없으면 아래로 CLI 를 먼저 설치하세요:\n    ${boot}`;
  return [
    { kind: 'install', title: '설치' }, // 설치 블록은 learn.ts 가 직접 렌더(단계 UI)
    {
      kind: 'update',
      title: '업데이트 (보통은 불필요 — 자동입니다)',
      note: '키트는 세션을 켤 때마다 자동으로 최신과 맞춰집니다(백그라운드 설치 → 다음 세션부터 적용). '
        + '이 명령은 ① 자동 업데이트를 껐거나 ② 지금 당장 맞춰야 하거나 '
        + '③ 관리자가 새 MCP 서버를 추가했을 때 씁니다 — ③ 은 자동 업데이트가 할 수 없는 유일한 일입니다'
        + '(백그라운드에서 MCP 재등록을 하다 실패하면 등록이 사라질 수 있어 일부러 빼 뒀습니다).' + ifMissing,
      cmd: 'lively update',
    },
    {
      kind: 'uninstall',
      title: '제거',
      note: '설치 파일을 영구 제거합니다(lively 영역만 — tmux 훅·셸 별칭 등 본인 설정은 그대로 보존). '
        + '미리 보려면 `lively uninstall --dry-run`. '
        + '완전 차단하려면 관리자가 [구성원 ▸ 접속 토큰] 에서 그 토큰의 접속을 해제해야 합니다.' + ifMissing,
      cmd: 'lively uninstall',
    },
  ];
}

export {
  deployCommands,
  installCmd,
  installMinterBlock,
};
