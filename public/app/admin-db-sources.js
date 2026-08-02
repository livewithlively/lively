// admin-db-sources.ts — [DB 데이터소스] 패널 + 그 소스의 설정 3종 (#1313 R40, admin.ts 에서 verbatim 분리).
//  소스 등록/편집(dbSourceEditor·dbSourceForm) 아래에 소스별 설정이 라이브 스키마 오버레이로 따라 붙는다:
//   ① 테이블 정책 · 컬럼 마스킹(renderDbPolicyPanel) ② raw-PII 열람 권한(renderUnmaskGrantPanel)
//   ③ 감사 대상 식별자(renderSubjectKeyPanel — 구 [DB 접근 감사] 화면에 있었지만 감사가 아니라 **설정**이라 #837 이 옮겼다).
//  ②③은 감사 화면(admin-audit.ts)이 아니라 여기 산다 — 서버도 /org/db-source/* 의 하위 리소스로 본다.
//  ⚠ 접속 비밀번호는 **값을 저장하지 않는다** — 환경변수 이름(auth_ref)만 저장하고, 그 이름조차
//   allowed_db_secret_refs allowlist 안에 있어야 한다. 고객 DB 는 무수정, 집행은 전부 게이트웨이가 한다.
import { api, cardHead, el, errorNote, memberCombo, relTime, selectFilter, state, toast, uiText } from './core.js';
import { field } from './ui-primitives.js';
import { loadAdmin, rerenderPanel } from './admin-rerender.js';
import { allowlistCard, sectionHead, sectionTitle } from './admin-widgets.js';
function dbSourceEditor(detail, data) {
    const sources = data.dbSources || [];
    const envSources = data.envSources || [];
    const sel = state.admin.dbSrcSel;
    const listCol = el('div', { class: 'admin-sublist' });
    listCol.append(el('button', { class: 'btn btn-ghost btn-sm admin-add', text: '+ DB 소스 추가',
        onclick: () => { state.admin.dbSrcSel = '__new__'; rerenderPanel(detail, 'db-sources', data); } }));
    for (const s of sources) {
        listCol.append(el('div', { class: 'mini-row' + (s.name === sel ? ' sel' : ''),
            onclick: () => { state.admin.dbSrcSel = s.name; rerenderPanel(detail, 'db-sources', data); } }, el('div', { class: 'mini-title', text: s.name }, s.enabled === false ? el('span', { class: 'pill', text: '비활성' }) : null), el('div', { class: 'mini-meta', text: (s.host || '-') + ' · ' + (s.auth_mode || 'password') + (s.rls ? ' · RLS' : '') })));
    }
    // env 소스(.env/DB_SOURCES_JSON) — 읽기 전용(여기선 편집 불가).
    for (const s of envSources) {
        listCol.append(el('div', { class: 'mini-row mini-ro' }, el('div', { class: 'mini-title', text: s.name }, el('span', { class: 'pill', text: 'env' })), el('div', { class: 'mini-meta', text: (s.host || '-') + ' · 읽기 전용(.env)' })));
    }
    const right = el('div', {});
    const editing = sel === '__new__'
        ? { name: '', driver: 'postgres', url: '', auth_mode: 'password', auth_ref: '', rls: '', max_rows: '', timeout_ms: '', note: '', enabled: true }
        : sources.find((s) => s.name === sel);
    if (editing)
        dbSourceForm(right, editing, data, detail, sel === '__new__');
    else
        right.append(el('p', { class: 'admin-hint' }, ...uiText('db_query/db_schema 가 조회하는 외부 운영 DB 목록입니다. 읽기 전용 role(RLS 적용)로 접속하는 것을 전제로 하며, 접속 비밀번호는 값을 저장하지 않고 환경변수 이름(auth_ref)만 저장합니다. 왼쪽에서 소스를 선택하면 테이블 정책·컬럼 마스킹, 원본 열람 권한, 감사 대상 식별자 설정이 함께 열립니다. .env 로 등록한 소스는 「env」 표시가 붙으며 이 화면에서는 수정할 수 없습니다.')));
    // 등록된 소스를 고르면 그 소스의 **설정** 3종이 따라 붙는다(라이브 스키마 오버레이, 무재시작):
    //  ① 테이블 정책·컬럼 마스킹 ② 원본 개인정보 열람 권한(unmask grant) ③ 감사 대상 식별자 컬럼(subject-key).
    //  ③은 구 [DB 접근 감사] 화면에 꽂혀 있었지만 그건 **감사가 아니라 설정**이고, 서버도 /org/db-source/subject-key(s)
    //  로 이 소스의 하위 리소스로 본다 — #837 에서 제자리로 옮겼다. 감사 화면엔 '무슨 일이 있었나'만 남는다.
    if (editing && sel !== '__new__') {
        const panel = el('div', { class: 'card', style: 'margin-top:12px' });
        right.append(panel);
        void renderDbPolicyPanel(panel, sel);
        const gpanel = el('div', { class: 'card', style: 'margin-top:12px' });
        right.append(gpanel);
        void renderUnmaskGrantPanel(gpanel, sel, data);
        const spanel = el('div', { class: 'card', style: 'margin-top:12px' });
        right.append(spanel);
        void renderSubjectKeyPanel(spanel, sel, data);
    }
    const rcDb = data.runtimeConfig || { allowed_db_hosts: [], allowed_db_secret_refs: [] };
    const dbSafety = allowlistCard(data, 'DB 접속 안전범위 (allowlist)', 'db_query/db_schema 의 DB 접속을 아래 두 목록으로 제한합니다. 목록에 없는 대상은 차단됩니다.', [
        { key: 'allowed_db_hosts', label: '허용 DB host (allowed_db_hosts)', initial: rcDb.allowed_db_hosts, placeholder: 'localhost\ndb.internal.acme.com\n줄당 host 한 개',
            hint: '접속을 허용할 사설/내부 host 입니다. 목록에 없는 사설망·localhost 접속은 차단됩니다(SSRF 방어). 외부 공인 DB 는 등록하지 않아도 됩니다.' },
        { key: 'allowed_db_secret_refs', label: '허용 비밀번호 환경변수 이름 (allowed_db_secret_refs)', initial: rcDb.allowed_db_secret_refs, placeholder: 'PROD_RDS_RO_PASSWORD\n줄당 환경변수 이름 한 개(값 금지)',
            hint: 'auth_ref 가 참조할 수 있는 비밀번호 환경변수 이름입니다. 값이 아니라 이름만 적으며, 실제 값은 게이트웨이 프로세스 환경변수에 있어야 합니다.' },
    ]);
    // 메인 카드와 안전범위 카드가 detail 직속으로 붙어 여백 0 이었다 → admin-stack(gap:14px)으로 감싼다(#req).
    detail.replaceChildren(sectionHead('DB 데이터소스', 'AI가 조회할 수 있는 데이터베이스를 등록하고, 어느 테이블까지 어떻게 보여줄지 정합니다.', data.meaning['db-source']), el('div', { class: 'admin-stack' }, el('div', { class: 'card' }, cardHead('등록된 DB 소스'), el('div', { class: 'admin-two admin-two-cols' }, listCol, right)), dbSafety));
}
function dbSourceForm(root, s, data, detail, isNew) {
    const allowed = (data.runtimeConfig && data.runtimeConfig.allowed_db_secret_refs) || [];
    const nameIn = el('input', { type: 'text', value: s.name, placeholder: '소스 이름(영문/숫자)', disabled: isNew ? null : '' });
    const urlIn = el('input', { type: 'text', value: '', placeholder: isNew ? 'postgres://readonly@host:5432/db (비밀번호 제외)' : ('현재 host: ' + (s.host || '-') + ' · 변경 시에만 입력(비밀번호 제외)') });
    // 드라이버(#715) — postgres | mysql(Aurora). mysql 은 RLS 미지원이라 선택 시 rls 입력을 잠근다.
    const drvSel = el('select', {}, el('option', { value: 'postgres', text: 'postgres' }), el('option', { value: 'mysql', text: 'mysql (Aurora MySQL)' }));
    drvSel.value = s.driver === 'mysql' ? 'mysql' : 'postgres';
    const modeSel = el('select', {}, el('option', { value: 'password', text: 'password (env 참조)' }), el('option', { value: 'iam', text: 'iam (후속)', disabled: '' }), el('option', { value: 'mtls', text: 'mtls (후속)', disabled: '' }), el('option', { value: 'vault', text: 'vault (후속)', disabled: '' }));
    modeSel.value = s.auth_mode || 'password';
    const refIn = el('input', { type: 'text', value: s.auth_ref || '', placeholder: '예: ANALYTICS_DB_PW (env 이름, 값 아님)' });
    const refHint = el('p', { class: 'admin-hint', text: allowed.length ? '참조 가능한 env: ' + allowed.join(', ') : '⚠ 비밀번호 있는 DB면 allowed_db_secret_refs 에 환경변수 이름이 등록돼 있어야 합니다(운영자 설정 · 비밀번호 없는 DB면 비워도 됩니다)' });
    const rlsIn = el('input', { type: 'text', value: s.rls || '', placeholder: 'app.current_user (비우면 행수준 격리 없음)' });
    const syncDrv = () => {
        const my = drvSel.value === 'mysql';
        if (isNew)
            urlIn.placeholder = my ? 'mysql://readonly@host:3306/dbname (비밀번호 제외 · 스키마 필수)' : 'postgres://readonly@host:5432/db (비밀번호 제외)';
        rlsIn.disabled = my;
        if (my)
            rlsIn.value = '';
        rlsIn.placeholder = my ? 'mysql 미지원 — 비움 고정' : 'app.current_user (비우면 행수준 격리 없음)';
    };
    drvSel.addEventListener('change', syncDrv);
    syncDrv();
    const maxIn = el('input', { type: 'number', value: (s.max_rows == null ? '' : s.max_rows), placeholder: '기본 1000' });
    const toIn = el('input', { type: 'number', value: (s.timeout_ms == null ? '' : s.timeout_ms), placeholder: '기본 5000' });
    const noteIn = el('input', { type: 'text', value: s.note || '', placeholder: '설명(선택)' });
    const enChk = el('input', { type: 'checkbox' });
    enChk.checked = s.enabled !== false;
    const tdSel = el('select', {}, el('option', { value: 'allow', text: 'deny-list — 기본 허용(명시 차단만 제외)' }), el('option', { value: 'deny', text: 'allow-list — 기본 차단(명시 허용만 조회 · 컴플라이언스 권장)' }));
    tdSel.value = s.table_default || 'allow';
    const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
    const status = el('span', { class: 'admin-status' });
    saveBtn.addEventListener('click', async () => {
        if (!nameIn.value.trim()) {
            toast('이름 필수', true);
            return;
        }
        saveBtn.disabled = true;
        try {
            const urlV = urlIn.value.trim();
            if (isNew && !urlV) {
                toast('접속 URL 필수', true);
                saveBtn.disabled = false;
                return;
            }
            const payload = {
                name: nameIn.value.trim(), driver: drvSel.value, auth_mode: modeSel.value,
                auth_ref: refIn.value.trim() || null,
                rls: drvSel.value === 'mysql' ? null : (rlsIn.value.trim() || null),
                max_rows: maxIn.value ? Number(maxIn.value) : null,
                timeout_ms: toIn.value ? Number(toIn.value) : null,
                note: noteIn.value.trim() || null, enabled: enChk.checked, table_default: tdSel.value,
            };
            if (urlV)
                payload.url = urlV; // 빈칸 = url 미변경(수정 시)
            await api('/api/ui/org/db-source', { method: 'POST', body: JSON.stringify(payload) });
            await loadAdmin(true);
            state.admin.dbSrcSel = payload.name;
            toast('저장됨 — 즉시 조회 가능');
            rerenderPanel(detail, 'db-sources', state.admin.data);
        }
        catch (e) {
            toast(e.message, true);
            saveBtn.disabled = false;
        }
    });
    const actions = el('div', { class: 'admin-actions' }, saveBtn, status);
    if (!isNew)
        actions.append(el('button', { class: 'btn-text', text: '제거', onclick: async () => {
                if (!confirm(`DB 소스 '${s.name}' 제거?`))
                    return;
                try {
                    await api('/api/ui/org/db-source/remove', { method: 'POST', body: JSON.stringify({ name: s.name }) });
                    await loadAdmin(true);
                    state.admin.dbSrcSel = null;
                    toast('제거됨');
                    rerenderPanel(detail, 'db-sources', state.admin.data);
                }
                catch (e) {
                    toast(e.message, true);
                }
            } }));
    root.replaceChildren(field('이름', nameIn), field('드라이버 (driver)', drvSel), field('접속 URL (비밀번호 제외)', urlIn), field('인증 방식 (auth_mode)', modeSel), field('비밀번호 환경변수 이름 (auth_ref)', refIn), refHint, field('RLS GUC (rls)', rlsIn), field('최대 행수 (max_rows)', maxIn), field('타임아웃 ms (timeout_ms)', toIn), field('테이블 기본자세 (table_default)', tdSel), field('설명', noteIn), el('label', { class: 'admin-check' }, enChk, ' 활성'), actions);
}
// ── 테이블 정책 · 컬럼 마스킹 패널(#186) — 라이브 스키마 오버레이. 고객 DB 무수정, 게이트웨이 집행. ──
async function renderDbPolicyPanel(panel, source) {
    panel.replaceChildren(el('p', { class: 'admin-hint' }, ...uiText('스키마 불러오는 중…')));
    let ov;
    try {
        ov = await api('/api/ui/org/db-source/schema?source=' + encodeURIComponent(source));
    }
    catch (e) {
        panel.replaceChildren(el('p', { class: 'admin-hint', text: '스키마 로드 실패: ' + e.message }));
        return;
    }
    const openT = state.admin.dbPolTable || null;
    panel.replaceChildren(sectionTitle('테이블 정책 · 컬럼 마스킹', '이 소스에서 조회 가능한 테이블과 개인정보 컬럼 마스킹을 관리합니다 — 고객 DB 무수정, 게이트웨이가 결정론적으로 집행.'), el('p', { class: 'admin-hint', text: '기본자세: ' + (ov.table_default === 'deny'
            ? 'allow-list(기본 차단 — 명시 허용만 조회)' : 'deny-list(기본 허용 — 명시 차단만 제외)') + ' · 위 폼의 table_default 로 변경' }));
    const tbl = el('table', { class: 'fields-table' });
    tbl.append(el('tr', {}, el('th', { text: '테이블' }), el('th', { text: '조회' }), el('th', { text: '마스킹' }), el('th', { text: '컬럼' })));
    for (const t of (ov.tables || [])) {
        if (t.system) { // 게이트웨이 내부 테이블 — 항상 차단(웹 편집 불가), 정직하게 표시
            tbl.append(el('tr', { class: 'mini-ro' }, el('td', { text: t.name }), el('td', {}, el('span', { class: 'pill', text: '시스템 차단' })), el('td', { class: 'mini-meta', text: '잠금' }), el('td', {})));
            continue;
        }
        const allowed = t.mode === 'allow';
        const toggle = el('button', { class: 'btn btn-ghost btn-sm', text: allowed ? '허용' : '차단',
            onclick: async () => { await setTablePolicy(source, t.name, allowed ? 'deny' : 'allow'); void renderDbPolicyPanel(panel, source); } });
        const isOpen = t.name === openT;
        const colsBtn = el('button', { class: 'btn-text', text: (isOpen ? '▾ 컬럼' : '▸ 컬럼') + (t.maskedCount ? ` (${t.maskedCount})` : '') });
        colsBtn.addEventListener('click', () => { state.admin.dbPolTable = isOpen ? null : t.name; void renderDbPolicyPanel(panel, source); });
        tbl.append(el('tr', { class: allowed ? '' : 'mini-ro' }, el('td', { text: t.name }), el('td', {}, toggle), el('td', { class: 'mini-meta', text: t.maskedCount ? (t.maskedCount + ' 컬럼') : '–' }), el('td', {}, colsBtn)));
        if (isOpen) {
            const cell = el('td', { colspan: '4' });
            tbl.append(el('tr', {}, cell));
            void renderColumnMasks(cell, panel, source, t.name);
        }
    }
    panel.append(tbl);
}
async function renderColumnMasks(cell, panel, source, table) {
    cell.replaceChildren(el('span', { class: 'admin-hint' }, ...uiText('컬럼 불러오는 중…')));
    let ov;
    try {
        ov = await api('/api/ui/org/db-source/schema?source=' + encodeURIComponent(source) + '&table=' + encodeURIComponent(table));
    }
    catch (e) {
        cell.replaceChildren(el('span', { class: 'admin-hint', text: '컬럼 로드 실패: ' + e.message }));
        return;
    }
    const STYLES = [['', '(마스킹 없음)'], ['full', 'full — 전체 ***'], ['partial', 'partial — 앞1·뒤1'], ['email', 'email — 로컬부 가림'], ['hash', 'hash — sha256'], ['null', 'null — 널']];
    const ct = el('table', { class: 'fields-table', style: 'margin:6px 0 0 12px' });
    for (const c of (ov.columns || [])) {
        const box = el('select', {});
        for (const [v, label] of STYLES)
            box.append(el('option', { value: v, text: label }));
        box.value = c.masked || '';
        box.addEventListener('change', async () => {
            await setColumnMask(source, table, c.column_name, box.value);
            void renderDbPolicyPanel(panel, source); // 마스킹 수 즉시 반영
        });
        ct.append(el('tr', {}, el('td', { text: c.column_name }), el('td', { class: 'mini-meta', text: c.data_type }), el('td', {}, box)));
    }
    cell.replaceChildren(ct);
}
async function setTablePolicy(source, table, mode) {
    try {
        await api('/api/ui/org/db-source/table-policy', { method: 'POST', body: JSON.stringify({ source, table, mode }) });
        toast(mode === 'allow' ? '허용됨' : '차단됨');
    }
    catch (e) {
        toast(e.message, true);
    }
}
async function setColumnMask(source, table, column, style) {
    try {
        await api('/api/ui/org/db-source/column-mask', { method: 'POST', body: JSON.stringify(style ? { source, table, column, style } : { source, table, column, remove: true }) });
        toast(style ? ('마스킹: ' + style) : '마스킹 해제');
    }
    catch (e) {
        toast(e.message, true);
    }
}
async function renderSubjectKeyPanel(panel, source, data) {
    panel.replaceChildren(el('p', { class: 'admin-hint' }, ...uiText('식별자 설정 불러오는 중…')));
    let keys = [];
    let schema = null;
    try {
        const r = await api('/api/ui/org/db-source/subject-keys?source=' + encodeURIComponent(source));
        keys = r.keys || [];
        schema = await api('/api/ui/org/db-source/schema?source=' + encodeURIComponent(source)).catch(() => null);
    }
    catch (e) {
        panel.replaceChildren(errorNote(e, '식별자 설정을 불러오지 못했습니다'));
        return;
    }
    const rows = [
        sectionTitle('대상 식별자 컬럼 — ' + source, "이 소스에서 조회 시 '누구의 정보인지'를 감사에 남길 컬럼을 지정합니다(예: 고객ID). ⚠ 주민번호·계좌 같은 민감 원값 컬럼은 지정하지 마세요 — 감사기록이 개인정보 저장소가 되면 안 됩니다. 서로게이트 키(내부 ID)만 지정하세요."),
    ];
    if (keys.length) {
        for (const k of keys) {
            rows.push(el('div', { class: 'item' }, el('span', { class: 'pill', text: k.table_name + '.' + k.column_name }), el('button', { class: 'btn btn-ghost btn-sm spacer', text: '해제', onclick: async () => {
                    try {
                        await api('/api/ui/org/db-source/subject-key', { method: 'POST', body: JSON.stringify({ source, table: k.table_name, column: k.column_name, remove: true }) });
                        toast('해제됨');
                        renderSubjectKeyPanel(panel, source, data);
                    }
                    catch (e) {
                        toast(e.message, true);
                    }
                } })));
        }
    }
    else
        rows.push(el('p', { class: 'admin-hint' }, ...uiText('지정된 식별자 컬럼이 없습니다.')));
    const tables = schema && schema.tables ? schema.tables.filter((t) => t.mode === 'allow' && !t.system).map((t) => t.name) : [];
    const tableSel = tables.length ? selectFilter([['', '테이블 선택'], ...tables.map((t) => [t, t])], '') : el('input', { type: 'text', placeholder: '테이블명' });
    const colInput = el('input', { type: 'text', placeholder: '컬럼명 (예: customer_id)' });
    const addBtn = el('button', { class: 'btn btn-primary btn-sm', text: '식별자로 지정', onclick: async () => {
            const table = tableSel.value.trim();
            const column = colInput.value.trim();
            if (!table || !column) {
                toast('테이블·컬럼을 입력하세요', true);
                return;
            }
            try {
                await api('/api/ui/org/db-source/subject-key', { method: 'POST', body: JSON.stringify({ source, table, column }) });
                toast('지정됨');
                renderSubjectKeyPanel(panel, source, data);
            }
            catch (e) {
                toast(e.message, true);
            }
        } });
    rows.push(el('div', { class: 'addbox', style: 'margin-top:10px' }, el('div', { class: 'admin-actions', style: 'gap:8px; flex-wrap:wrap' }, tableSel, colInput, addBtn)));
    panel.replaceChildren(...rows);
}
// ── raw-PII 언마스크 권한(grant) 패널(#746 P4) — 이 소스의 마스킹을 특정 구성원이 우회(raw 조회)하도록 허가. ──
//  직무상 raw PII 가 필요한 사람(심사역·CS 등)용. 만료(JIT) 드롭다운·승인자 기록(maker-checker). 텍스트 최소.
const GRANT_EXPIRY = [['72h', '3일 (권장)'], ['24h', '1일'], ['7d', '7일'], ['30d', '30일'], ['', '무기한 (지양)']];
async function renderUnmaskGrantPanel(panel, source, data) {
    panel.replaceChildren(el('p', { class: 'admin-hint' }, ...uiText('언마스크 권한 불러오는 중…')));
    let grants = [];
    let schema = null;
    try {
        const r = await api('/api/ui/org/db-source/unmask-grants?source=' + encodeURIComponent(source) + '&active=1');
        grants = r.grants || [];
        schema = await api('/api/ui/org/db-source/schema?source=' + encodeURIComponent(source)).catch(() => null);
    }
    catch (e) {
        panel.replaceChildren(errorNote(e, '언마스크 권한을 불러오지 못했습니다'));
        return;
    }
    const rows = [
        sectionTitle('raw-PII 열람 권한 (언마스크)', '기본은 전원 마스킹입니다. 직무상 원본이 꼭 필요한 구성원에게만, 특정 테이블·컬럼을, 기간을 정해 열어줍니다 — 열람 내역은 「DB 접근 감사」에 남습니다.'),
    ];
    if (grants.length) {
        for (const g of grants) {
            const exp = g.expires_at ? relTime(g.expires_at) + ' 만료' : '무기한';
            rows.push(el('div', { class: 'item' }, el('span', { class: 'pill pill-warn', text: g.member_id }), el('span', { class: 'mini-meta', text: g.table_name + '.' + g.column_name }), el('span', { class: 'mini-meta' }, ...uiText(exp)), g.reason ? el('span', { class: 'mini-meta', text: '· ' + g.reason }) : null, el('button', { class: 'btn btn-ghost btn-sm spacer', text: '권한 해제', onclick: async () => {
                    if (!confirm(`${g.member_id} 의 ${g.table_name}.${g.column_name} 언마스크 권한을 해제할까요?`))
                        return;
                    try {
                        await api('/api/ui/org/db-source/unmask-grant/revoke', { method: 'POST', body: JSON.stringify({ id: g.id }) });
                        toast('권한 해제됨');
                        renderUnmaskGrantPanel(panel, source, data);
                    }
                    catch (e) {
                        toast(e.message, true);
                    }
                } })));
        }
    }
    else
        rows.push(el('p', { class: 'admin-hint' }, ...uiText('부여된 언마스크 권한이 없습니다 (전원 마스킹).')));
    // 추가 — 구성원(드롭다운)·테이블(마스킹 있는 테이블 드롭다운)·컬럼(그 테이블 마스킹 컬럼 드롭다운, * 포함)·만료·승인자·사유
    const memberC = memberCombo({ placeholder: '구성원 선택' });
    const maskedTables = schema && schema.tables ? schema.tables.filter((t) => (t.maskedCount || 0) > 0).map((t) => t.name) : [];
    const tableSel = maskedTables.length
        ? selectFilter([['', '테이블 선택'], ...maskedTables.map((t) => [t, t])], '')
        : el('input', { type: 'text', placeholder: '테이블명' });
    const colSel = el('select', {}, el('option', { value: '*', text: '* (그 테이블의 마스킹 컬럼 전체)' }));
    const refreshCols = async () => {
        const tv = tableSel.value;
        while (colSel.options.length > 1)
            colSel.remove(1);
        if (!tv)
            return;
        try {
            const sc = await api('/api/ui/org/db-source/schema?source=' + encodeURIComponent(source) + '&table=' + encodeURIComponent(tv));
            for (const c of (sc.rows || []))
                if (c.masked)
                    colSel.append(el('option', { value: c.column_name, text: c.column_name + ' (' + c.masked + ')' }));
        }
        catch { /* graceful — * 만 */ }
    };
    if (tableSel.tagName === 'SELECT')
        tableSel.addEventListener('change', refreshCols);
    const expSel = selectFilter(GRANT_EXPIRY, '72h');
    const approverC = memberCombo({ placeholder: '승인자(선택)' });
    const reasonIn = el('input', { type: 'text', placeholder: '사유(선택 · 예: 대출 심사)' });
    const addBtn = el('button', { class: 'btn btn-primary btn-sm', text: '권한 부여', onclick: async () => {
            const member = memberC.value();
            const table = tableSel.value.trim();
            if (!member || !table) {
                toast('구성원·테이블을 선택하세요', true);
                return;
            }
            const payload = { member, source, table, column: colSel.value || '*' };
            if (expSel.value)
                payload.expires = expSel.value;
            if (approverC.value())
                payload.approved_by = approverC.value();
            if (reasonIn.value.trim())
                payload.reason = reasonIn.value.trim();
            try {
                await api('/api/ui/org/db-source/unmask-grant', { method: 'POST', body: JSON.stringify(payload) });
                toast('부여됨');
                renderUnmaskGrantPanel(panel, source, data);
            }
            catch (e) {
                toast(e.message, true);
            }
        } });
    rows.push(el('div', { class: 'addbox', style: 'margin-top:10px' }, el('div', { class: 'addbox-h', text: '+ 언마스크 권한 부여' }), field('구성원', memberC.el), field('테이블', tableSel), field('컬럼', colSel), field('만료 (JIT)', expSel), field('승인자 (maker-checker)', approverC.el), field('사유', reasonIn), el('div', { class: 'admin-actions', style: 'margin-top:10px' }, addBtn)));
    panel.replaceChildren(...rows);
}
export { dbSourceEditor, };
