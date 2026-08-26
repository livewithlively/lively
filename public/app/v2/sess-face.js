const clean = (v) => String(v ?? '').trim();
export function pickSessFace(id, inst, memo) {
    const sid = clean(id);
    const named = (v) => { const t = clean(v); return t && t !== sid ? t : ''; };
    const title = named(inst?.subject_label) || named(memo?.n) || named(inst?.title);
    const projectId = Number(inst?.subject_project_id || inst?.project_id || 0) || 0;
    return { title, projectId };
}
