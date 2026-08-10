// admin-ops.ts — 운영 패널 3종: [로그] · [세션] · [세션 공유] (#1313 R39, admin.ts 에서 verbatim 분리).
//  셋 다 "이 박스가 지금 어떤 상태이고 무엇을 남기나"를 다루는 admin 전용 읽기+정책 화면이다.
//  ⚠ sessionShareEditor.build() 는 캡처한 rc 가 아니라 **data.runtimeConfig 를 매번 다시 읽는다**(rcNow).
//   저장은 data.runtimeConfig 만 갱신하고 rc 는 그대로라, 캐시하면 저장해도 체크가 풀려 보이는 스테일
//   클로저 버그가 난다(원래 주석 그대로 보존). 캐시하지 마라.
import { api, cardHead, el, toast, uiText } from './core.js';
import { fmtBytes, sectionHead } from './admin-widgets.js';
// ⚠ confirmDialog 는 정의처(ui-primitives)에서 직접 — admin.ts 배럴을 거치면 순환이 된다(admin-collector-presets 와 같은 이유).
import { confirmDialog } from './ui-primitives.js';

// 로그(#1059 — '컴퓨팅 리소스'에서 분리한 별도 메뉴). 게이트웨이 로그 파일 크기 + 회전(보관) 정책.
//  데이터 출처는 저장소와 같은 /api/ui/org/storage(logs·policy.log_*). 저장은 storage_policy 의 log 필드만(병합 — 디스크·메모리 보존).
function logsEditor(detail, data) {
  const canEdit = !!data.canEdit;
  const body = el('div');
  detail.replaceChildren(
    sectionHead('로그', '게이트웨이 로그 파일이 얼마나 쌓였는지 확인하고, 무한히 자라지 않도록 회전(보관) 상한을 정합니다. 저장하면 즉시 반영됩니다(재시작 불필요).'),
    el('div', { class: 'card' }, body));
  body.append(el('p', { class: 'admin-hint' }, ...uiText('불러오는 중…')));

  async function load() {
    let st;
    try { st = await api('/api/ui/org/storage'); }
    catch (e: any) { body.replaceChildren(el('p', { class: 'admin-hint', text: '상태를 불러오지 못했습니다: ' + e.message })); return; }
    build(st);
  }

  function build(st) {
    const p = st.policy || {};
    const logs = st.logs || { files: [], totalBytes: 0, capBytes: 0, dir: '' };
    const current = (logs.files || []).filter((f) => !f.rotated);
    const kept = (logs.files || []).filter((f) => f.rotated);
    const logLine = logs.capBytes > 0
      ? `현재 ${fmtBytes(logs.totalBytes)} — 정책상 최대 ${fmtBytes(logs.capBytes)}로 제한됩니다`
      : `현재 ${fmtBytes(logs.totalBytes)} — ⚠ 회전이 꺼져 있어 상한이 없습니다`;
    const logDetail = (logs.files || []).length
      ? el('p', { class: 'storage-calc', text: `현재 로그 ${current.length}개 · 보관본 ${kept.length}개 (${(logs.files || []).slice(0, 4).map((f) => f.name + ' ' + fmtBytes(f.bytes)).join(' · ')})` })
      : el('p', { class: 'storage-calc', text: '로그 파일 없음' });

    const numIn = (val, min, max) => {
      const i = el('input', { class: 'input input-num', type: 'number', min: String(min), max: String(max) });
      i.value = String(val); i.disabled = !canEdit;
      return i;
    };
    const logMaxIn = numIn(p.log_max_mb ?? 50, 0, 10000);
    const logKeepIn = numIn(p.log_keep ?? 3, 0, 50);
    const logCalc = el('p', { class: 'storage-calc' });
    const recalc = () => {
      const mb = Number(logMaxIn.value) || 0;
      const keep = Number(logKeepIn.value) || 0;
      logCalc.textContent = mb <= 0
        ? '⚠ 0 = 회전 끔 — 로그가 무한히 쌓입니다(권장하지 않음).'
        : `→ 로그가 차지할 수 있는 최대 용량: ${fmtBytes(mb * 1024 * 1024 * (keep + 1))} (${mb}MB 씩 현재 1개 + 보관 ${keep}개)`;
    };
    logMaxIn.addEventListener('input', recalc);
    logKeepIn.addEventListener('input', recalc);
    recalc();

    const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: '정책 저장' });
    saveBtn.disabled = !canEdit;
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        // storage_policy 병합 저장 — log 필드만 보낸다(디스크·메모리 임계는 컴퓨팅 리소스 탭에서 관리, 서버가 보존).
        await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ storage_policy: { log_max_mb: Number(logMaxIn.value), log_keep: Number(logKeepIn.value) } }) });
        toast('저장됨 — 즉시 반영됩니다(재시작 불필요).');
        load();
      } catch (e: any) { toast(e.message, true); saveBtn.disabled = false; }
    });

    const srcNote = st.policy_source === 'env'
      ? el('p', { class: 'admin-hint' }, ...uiText('현재 값은 서버 환경변수(.env) 시드입니다 — 여기서 저장하면 관리탭 설정이 우선합니다.'))
      : st.policy_source === 'default'
        ? el('p', { class: 'admin-hint' }, ...uiText('아직 설정한 적이 없어 기본값으로 동작 중입니다.'))
        : null;

    body.replaceChildren(
      el('h3', { class: 'storage-h', text: '지금 상태' }),
      el('div', { class: 'storage-block' },
        el('div', { class: 'storage-head' }, el('strong', { text: '로그' })),
        el('p', { class: 'storage-calc' }, el('code', { text: logs.dir || '' })),
        el('p', { class: 'storage-calc', text: logLine }),
        logDetail),
      el('h3', { class: 'storage-h', text: '정책' }),
      ...(srcNote ? [srcNote] : []),
      el('div', { class: 'storage-block' },
        el('strong', { text: '로그 보관' }),
        el('div', { class: 'storage-fields' },
          el('label', {}, el('span', { text: '파일 1개 최대(MB)' }), logMaxIn),
          el('label', {}, el('span', { text: '보관 개수' }), logKeepIn)),
        logCalc,
        el('p', { class: 'admin-hint' }, ...uiText('상한을 넘으면 자동으로 회전합니다(내용은 보관본으로 넘기고 현재 파일은 비웁니다). 서비스는 멈추지 않습니다.')),
        el('div', { class: 'storage-actions' }, saveBtn)),
    );
  }

  load();
}

// 세션(#1059 F b/c) — 이 박스의 전 중앙 세션 메타뷰 + 수동 회수. admin 전용(/api/ui/terminal/admin/sessions).
//  회수(reclaim=1)는 tmux 만 종료하고 desired-state 를 보존 → 사용자가 목록에서 '복원 가능'으로 다시 연다(파괴적 삭제 아님).
//  managed(상시)는 keep-alive 가 되살리므로 회수 버튼을 막고, 접속중·작업중 세션은 admin 이 회수 가능하나(긴급 override) 확인창으로 한번 더.
function sessionsAdminEditor(detail, data) {
  const canEdit = !!data.canEdit; // admin scope
  const body = el('div');
  detail.replaceChildren(
    sectionHead('세션', '이 박스에서 지금 도는 모든 AI 세션입니다. 안 쓰는 세션이 쌓이면 메모리가 말라 박스가 멈출 수 있어요(#1059) — 여기서 보고 오래 쉬는 세션을 회수하세요. 회수해도 대화·설정은 보존돼 사용자가 다시 열 수 있습니다(파괴적 삭제 아님).'),
    el('div', { class: 'card' }, body));
  body.append(el('p', { class: 'admin-hint' }, ...uiText('불러오는 중…')));

  const memberName = (id) => { const m = (data.members || []).find((x) => x.id === id); return m ? (m.display_name || m.id) : (id || '?'); };
  const shortDir = (d) => { if (!d) return '—'; const parts = String(d).split('/').filter(Boolean); return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : d; };
  const STMAP = { busy: ['작업 중', 'busy'], waiting: ['확인 필요', 'waiting'], idle: ['대기 중', 'idle'], exited: ['종료됨', 'exited'], offline: ['연결 끊김', 'offline'] };
  const agoText = (sec) => { if (!sec) return '기록 없음'; const dd = Math.floor(Date.now() / 1000) - Number(sec); if (dd < 60) return '방금'; if (dd < 3600) return Math.floor(dd / 60) + '분 전'; if (dd < 86400) return Math.floor(dd / 3600) + '시간 전'; return Math.floor(dd / 86400) + '일 전'; };

  async function load() {
    let d;
    try { d = await api('/api/ui/terminal/admin/sessions'); }
    catch (e: any) { body.replaceChildren(el('p', { class: 'admin-hint', text: '불러오지 못했습니다: ' + e.message })); return; }
    build((d && d.sessions) || []);
  }

  function build(sessions) {
    // 상태 우선 정렬(작업중·확인필요 = 건드리면 안 되는 것을 위로 인지) → 그 안에서 최근 작업순.
    const rank = { busy: 0, waiting: 1, idle: 2, exited: 3, offline: 4 };
    const rows = [...sessions].sort((a, b) => (rank[a.agentState] ?? 9) - (rank[b.agentState] ?? 9) || (Number(b.lastActive) || 0) - (Number(a.lastActive) || 0));
    const summary = el('p', { class: 'admin-hint', text: `총 ${sessions.length}개 · 접속 중 ${sessions.filter((s) => s.attached).length}개 · 상시 ${sessions.filter((s) => s.managed).length}개. 회수는 tmux 만 종료하고 대화·설정을 보존합니다(사용자가 “복원 가능”으로 다시 엶).` });

    const list = el('div', { class: 'sess-admin-list' });
    if (!rows.length) list.append(el('p', { class: 'admin-hint' }, ...uiText('지금 도는 세션이 없습니다.')));
    for (const s of rows) {
      const [lbl, cls] = STMAP[s.agentState] || STMAP.offline;
      const headline = (s.title && s.title !== s.label ? s.title : s.label) || '(이름 없음)';
      const reclaimBtn = el('button', { class: 'btn btn-sm btn-danger', text: '회수' }) as HTMLButtonElement;
      reclaimBtn.disabled = !canEdit || !!s.managed;
      if (s.managed) reclaimBtn.title = '상시(managed) 세션은 keep-alive 가 되살리므로 회수 대상이 아닙니다.';
      reclaimBtn.addEventListener('click', async () => {
        // #1582 — 브라우저 confirm 대신 라이블리 확인창(세션을 다루는 다른 화면과 같은 모양·같은 어휘).
        //  회수는 남의 세션을 건드리는 관리자 동작이라, 무엇이 보존되고 무엇이 끊기는지 둘 다 적는다.
        const inUse = s.attached || s.agentState === 'busy' || s.agentState === 'waiting';
        if (!await confirmDialog({
          title: `‘${s.label || s.id}’ 세션을 회수할까요?`, danger: true, confirmText: '회수', cancelText: '취소',
          message: '메모리를 되찾고 「복원 가능」 목록에 남습니다 — 대화·설정은 보존되고 소유자가 다시 열 수 있어요.',
          lines: inUse ? ['⚠ 지금 사용 중(접속·작업·대기)입니다 — 회수하면 진행 중이던 화면이 끊깁니다.'] : [],
        })) return;
        reclaimBtn.disabled = true; reclaimBtn.textContent = '회수 중…';
        try { await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '?reclaim=1', { method: 'DELETE' }); toast('회수했어요 — 복원 가능 목록에 남습니다.'); load(); }
        catch (e: any) { toast(e.message, true); reclaimBtn.disabled = false; reclaimBtn.textContent = '회수'; }
      });
      list.append(el('div', { class: 'sess-admin-row' },
        el('span', { class: 'sess-admin-dot sess-admin-dot-' + cls, title: lbl }),
        el('div', { class: 'sess-admin-main' },
          el('div', { class: 'sess-admin-title', title: headline, text: headline }),
          el('div', { class: 'sess-admin-meta', text: `${memberName(s.owner)} · ${s.harness || 'shell'}${s.projectId ? ' · 프로젝트 #' + s.projectId : ''}${s.managed ? ' · 상시' : ''} · 📁 ${shortDir(s.dir)}` })),
        el('span', { class: 'sess-admin-st sess-admin-st-' + cls, text: lbl }),
        el('span', { class: 'sess-admin-when', text: (s.attached ? '접속 중 · ' : '') + agoText(s.lastActive) }),
        reclaimBtn));
    }

    const refresh = el('button', { class: 'btn btn-sm', text: '새로고침' });
    refresh.addEventListener('click', load);
    body.replaceChildren(summary, list, el('div', { class: 'storage-actions' }, refresh));
  }
  load();
}

// 세션 공유(세션이력 캡처) 정책(#905 C1) — 관리탭 ▸ 세션 공유. runtimeConfig.session_share 를 읽고 POST 로 저장.
//  프라이버시가 걸린 설정이라 **무엇이 캡처되는지·기본이 꺼짐인지**를 화면에서 분명히 말한다.
function sessionShareEditor(detail, data) {
  const rc = data.runtimeConfig;                 // admin 만 non-null
  const canEdit = !!data.canEdit && !!rc;
  const DEF = { enabled: false, harnesses: ['claude'], scope: 'main', store: 'slim', retention_days: 30, view_policy: 'attach', resume_policy: 'owner' };
  const body = el('div');
  detail.replaceChildren(
    sectionHead('세션 공유', '구성원의 AI 대화 기록을 중앙에 모아, 다른 컴퓨터·다른 사람이 이어서 보고 이어받게 합니다. 대화 전문이 저장되므로 기본은 꺼져 있습니다.'),
    el('div', { class: 'card' }, cardHead('세션 공유 설정'), body));
  if (!rc) { body.append(el('p', { class: 'admin-hint' }, ...uiText('이 설정은 관리자(admin)만 볼 수 있습니다.'))); return; }
  build();

  function build() {
    // ⚠ 저장 후 재렌더는 **data.runtimeConfig(최신)** 를 다시 읽는다 — 캡처된 옛 rc 를 쓰면 저장돼도 체크가 풀린다
    //  (save 는 data.runtimeConfig 를 갱신하지 rc 를 안 바꾼다 — 스테일 클로저 버그).
    const rcNow = data.runtimeConfig;
    const ss = { ...DEF, ...((rcNow && rcNow.session_share) || {}) };
    body.replaceChildren();

    // ── 마스터 스위치 ──
    const enChk = el('input', { type: 'checkbox' }); enChk.checked = ss.enabled === true; enChk.disabled = !canEdit;
    const enRow = el('label', { class: 'admin-check' }, enChk,
      el('span', { text: ' 세션 대화 기록 수집 켜기 — 켜면 아래 하네스의 세션 트랜스크립트가 중앙에 저장됩니다' }));

    // ── 하네스 ──
    const hSet = new Set(Array.isArray(ss.harnesses) ? ss.harnesses : ['claude']);
    const hChk = (key, label, note) => {
      const c = el('input', { type: 'checkbox' }); c.checked = hSet.has(key); c.disabled = !canEdit;
      c.addEventListener('change', () => { if (c.checked) hSet.add(key); else hSet.delete(key); });
      return el('label', { class: 'admin-check' }, c, el('span', { text: ' ' + label }), note ? el('span', { class: 'admin-hint', text: '  ' + note }) : null);
    };
    const harnessRows = el('div', {},
      hChk('claude', 'Claude Code', ''),
      hChk('codex', 'Codex', '구조적으로 별도 처리 필요 — 현재 파이프라인 미지원(실험)'));

    // ── select 헬퍼 ──
    const sel = (opts, val) => {
      const s = el('select', { class: 'input' }, ...opts.map(([v, t]) => el('option', { value: v, text: t })));
      s.value = val; s.disabled = !canEdit; return s;
    };
    const scopeSel = sel([['main', '주 대화만'], ['tree', '주 대화 + 서브에이전트(트리 전체)']], ss.scope);
    const storeSel = sel([['slim', '슬림 — 서명·툴결과·토큰통계 제거(본문 유지, 용량↓)'], ['raw', '원본 그대로(용량↑)']], ss.store);
    const viewSel = sel([['attach', '세션 입장 가능자'], ['owner', '세션 소유자만']], ss.view_policy);
    const retIn = el('input', { class: 'input input-num', type: 'number', min: '0', max: '3650' });
    retIn.value = String(ss.retention_days ?? 30); retIn.disabled = !canEdit;

    const field = (label, ctrl, hint) => el('div', { class: 'admin-field' },
      el('label', { class: 'admin-field-label', text: label }), ctrl,
      hint ? el('p', { class: 'admin-hint' }, ...uiText(hint)) : null);

    const saveBtn = el('button', { class: 'btn btn-primary', text: '저장', disabled: !canEdit });
    saveBtn.addEventListener('click', async () => {
      // 하네스 0개로 켜기 = 무의미(서버가 조용히 기본값으로 되돌린다). 사용자에게 이유를 말하고 막는다(무언 되돌림 방지).
      if (enChk.checked && hSet.size === 0) { toast('수집할 하네스를 하나 이상 선택하세요', true); return; }
      saveBtn.disabled = true;
      try {
        const patch = {
          enabled: enChk.checked,
          harnesses: [...hSet],
          scope: scopeSel.value, store: storeSel.value, view_policy: viewSel.value,
          retention_days: Math.max(0, Math.min(3650, Math.floor(Number(retIn.value) || 0))),
        };
        const r = await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ session_share: patch }) });
        if (r && r.runtimeConfig) data.runtimeConfig = r.runtimeConfig;
        toast('세션 공유 설정 저장됨 — 구성원 다음 세션부터 반영');
        build();
      } catch (e: any) { toast(e.message, true); saveBtn.disabled = !canEdit; }
    });

    body.append(
      el('div', { class: 'card-sub' }, enRow),
      field('수집할 하네스', harnessRows, null),
      field('수집 범위', scopeSel, null),
      field('저장 형태', storeSel, null),
      field('보존 기간(일)', retIn, '0 = 무제한(디스크 주의). 지난 기록은 자동 정리됩니다.'),
      field('기록 열람 권한', viewSel, '중앙에 모인 대화를 누가 열람·이어받을 수 있는지.'),
      canEdit ? el('div', { class: 'admin-actions' }, saveBtn)
        : el('p', { class: 'admin-hint' }, ...uiText('읽기 전용 — 변경은 관리자(admin) 권한이 필요합니다.')));
  }
}

export {
  logsEditor,
  sessionsAdminEditor,
  sessionShareEditor,
};
