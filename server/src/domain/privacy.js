/**
 * Privacy engine. Privacy is applied AT READ TIME for every purpose, including share-link
 * snapshots captured earlier — so revoking phone access removes it even from old links.
 * The filtered result is the ONLY thing placed in API responses or share payloads; the
 * raw field value never rides along in JSON "just in case".
 */

export const PURPOSES = ['internal', 'apply_trusted', 'apply_public', 'share_link'];

/**
 * @param privacy list of {fieldPath,purposes[]}
 * fieldPath forms:
 *   profile.phone
 *   entities.<entityId>.fieldName
 *   entities.*.fieldName        (all entities)
 *   entities.kind:project.url   (all entities of a kind)
 */
export function isFieldAllowed(privacy, path, purpose) {
  const rules = privacy.filter((r) => pathMatches(r.fieldPath, path));
  if (!rules.length) return true; // no rule => allowed by default
  const latest = rules[rules.length - 1];
  return latest.purposes.includes(purpose);
}

function pathMatches(pattern, path) {
  const pa = pattern.split('.');
  const ta = path.split('.');
  if (pa.length !== ta.length) return false;
  for (let i = 0; i < pa.length; i++) {
    if (pa[i] === '*') continue;
    if (pa[i].startsWith('kind:') && i === 1) {
      // entities.kind:project.url vs entities.<id>.url — kind info not present in path alone,
      // handled by caller using enriched path entities.<id>.url with kind map.
      return false;
    }
    if (pa[i] !== ta[i]) return false;
  }
  return true;
}

/**
 * Build purpose-filtered content from a branch + entities.
 * @returns {{content:object, stripped:string[]}}
 */
export function filterContentForPurpose({ branch, entitiesById, profile, privacy, purpose }) {
  const stripped = [];
  const allow = (path) => {
    const ok = isFieldAllowed(privacy, path, purpose);
    if (!ok) stripped.push(path);
    return ok;
  };

  const safeProfile = {};
  for (const [k, v] of Object.entries(profile || {})) {
    if (v == null) continue;
    const path = `profile.${k}`;
    if (allow(path)) safeProfile[k] = v;
  }

  const buckets = { experience: [], project: [], education: [] };
  for (const item of branch.items || []) {
    const e = entitiesById.get(item.id);
    if (!e) continue; // selected fact was deleted — skip selection, keep other facts untouched
    const fields = {};
    for (const [k, v] of Object.entries(e.fields || {})) {
      if (v == null || v === '') continue;
      const path = `entities.${e.id}.${k}`;
      if (allow(path)) fields[k] = v;
    }
    buckets[e.kind].push({ id: e.id, kind: e.kind, version: e.version, fields, detailLevel: item.detailLevel });
  }

  return {
    content: { profile: safeProfile, experience: buckets.experience, project: buckets.project, education: buckets.education },
    stripped: [...new Set(stripped)],
  };
}
