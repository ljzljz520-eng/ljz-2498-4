/**
 * Versioned, self-contained template registry. Templates are pure functions from
 * sanitized content to layout blocks. Old versions are NEVER removed: exports and share
 * links lock templateKey+templateVersion, so an approved layout stays reproducible after
 * the template package is updated.
 */

export const TEMPLATES = {
  classic: {
    key: 'classic',
    latest: '1.1.0',
    versions: {
      // 1.0.0 — original approved layout (kept for restores)
      '1.0.0': {
        key: 'classic', version: '1.0.0', label: 'Classic (approved)',
        margins: 48, baseSize: 10, family: 'Times-Roman',
        render(content, opts = {}) {
          const b = [];
          b.push({ type: 'heading', text: content.profile?.name || '' });
          b.push({ type: 'text', runs: contactRuns(content, opts), style: { fontFamily: null, fontSize: 9, family: 'Times-Roman' } });
          section(b, 'Experience', content.experience, (e) => [
            { type: 'text', runs: [{ text: e.fields.role || '', bold: true }, { text: e.fields.company ? ` · ${e.fields.company}` : '' }] },
            { type: 'text', text: e.fields.summary || '', style: { fontSize: 9.5 } },
          ]);
          section(b, 'Projects', content.project, (e) => [
            { type: 'text', runs: [{ text: e.fields.name || '', bold: true }, { text: e.fields.url ? ` — ${e.fields.url}` : '', family: 'Courier' }] },
            { type: 'text', text: e.fields.description || '', style: { fontSize: 9.5 } },
          ]);
          section(b, 'Education', content.education, (e) => [
            { type: 'text', runs: [{ text: e.fields.school || '', bold: true }, { text: e.fields.degree ? ` · ${e.fields.degree}` : '' }] },
          ]);
          return b;
        },
      },
      // 1.1.0 — current: tighter gaps (changes height), Helvetica, 10pt
      '1.1.0': {
        key: 'classic', version: '1.1.0', label: 'Classic',
        margins: 40, baseSize: 10, family: 'Helvetica',
        render(content, opts = {}) {
          const b = [];
          b.push({ type: 'heading', text: content.profile?.name || '', style: { fontSize: 15 } });
          b.push({ type: 'text', runs: contactRuns(content, opts), style: { fontSize: 9 } });
          b.push({ type: 'spacer', h: 4 });
          section(b, 'Experience', content.experience, (e) => [
            { type: 'item', keepWithNext: 2, blocks: [
              { type: 'text', runs: [{ text: e.fields.role || '', bold: true }, { text: e.fields.company ? ` · ${e.fields.company}` : '' }] },
              { type: 'text', text: e.fields.summary || '', style: { fontSize: 9.5 } },
            ] },
          ]);
          section(b, 'Projects', content.project, (e) => [
            { type: 'item', keepWithNext: 2, blocks: [
              { type: 'text', runs: [
                { text: e.fields.name || '', bold: true },
                ...(e.fields.url ? [{ text: ` — ${e.fields.url}`, family: 'Courier', fontSize: 8.5 }] : []),
              ] },
              { type: 'text', text: e.fields.description || '', style: { fontSize: 9.5 } },
            ] },
          ]);
          section(b, 'Education', content.education, (e) => [
            { type: 'text', runs: [{ text: e.fields.school || '', bold: true }, { text: e.fields.degree ? ` · ${e.fields.degree}` : '' }] },
          ]);
          return b;
        },
      },
    },
  },
  compact: {
    key: 'compact',
    latest: '2.0.0',
    versions: {
      '2.0.0': {
        key: 'compact', version: '2.0.0', label: 'Compact',
        margins: 32, baseSize: 9, family: 'Helvetica',
        render(content) {
          const b = [];
          b.push({ type: 'heading', text: content.profile?.name || '', style: { fontSize: 13 } });
          b.push({ type: 'text', runs: contactRuns(content, {}), style: { fontSize: 8.5 } });
          b.push({ type: 'spacer', h: 2 });
          for (const e of content.experience || []) {
            b.push({ type: 'item', keepWithNext: 1, blocks: [
              { type: 'text', runs: [{ text: `${e.fields.role || ''} @ ${e.fields.company || ''}`, bold: true }], style: { fontSize: 9 } },
              { type: 'text', text: e.fields.summary || '', style: { fontSize: 8.5 } },
            ] });
          }
          for (const e of content.project || []) {
            b.push({ type: 'text', text: e.fields.name || '', style: { fontSize: 9, bold: true } });
          }
          for (const e of content.education || []) {
            b.push({ type: 'text', text: `${e.fields.school || ''} ${e.fields.degree || ''}`, style: { fontSize: 8.5 } });
          }
          return b;
        },
      },
    },
  },
};

function contactRuns(content, opts) {
  const p = content.profile || {};
  const runs = [];
  if (p.email) runs.push({ text: p.email, family: 'Courier', fontSize: 8.5 });
  if (p.phone) runs.push({ text: (runs.length ? ' · ' : '') + p.phone, fontSize: 9 });
  if (p.site) runs.push({ text: (runs.length ? ' · ' : '') + p.site, family: 'Courier', fontSize: 8.5 });
  return runs;
}

function section(out, title, list, mapItem) {
  if (!list || !list.length) return;
  out.push({ type: 'spacer', h: 6 });
  out.push({ type: 'heading', text: title });
  out.push({ type: 'rule' });
  for (const e of list) {
    const blocks = mapItem(e);
    out.push({ type: 'item', keepWithNext: 1, blocks });
  }
}

export function getTemplate(key, version) {
  const family = TEMPLATES[key];
  if (!family) throw Object.assign(new Error(`unknown template ${key}`), { status: 400, code: 'TEMPLATE_UNKNOWN' });
  const ver = version || family.latest;
  const tpl = family.versions[ver];
  if (!tpl) throw Object.assign(new Error(`template ${key}@${ver} not registered`), { status: 400, code: 'TEMPLATE_VERSION_UNKNOWN' });
  return tpl;
}

export function listTemplates() {
  return Object.values(TEMPLATES).map((f) => ({
    key: f.key, latest: f.latest,
    versions: Object.keys(f.versions).map((v) => ({ version: v, label: f.versions[v].label, margins: f.versions[v].margins })),
  }));
}
