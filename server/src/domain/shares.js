/**
 * Share-link service.
 *  - At creation: freeze the selection + entity versions into a snapshot, render with the
 *    chosen template version, and store ONLY the purpose-filtered payload.
 *  - At read: the snapshot still goes through the CURRENT privacy rules. Revoking a field
 *    (e.g. making phone internal-only) removes it from every previously created link.
 *  - Raw facts are never embedded in the share API response.
 */
import { randomBytes } from 'node:crypto';
import { getTemplate } from '../render/templates.js';
import { filterContentForPurpose } from './privacy.js';

export function newToken() {
  return randomBytes(18).toString('base64url');
}

export async function createShare({ store, resumeId, branchKey, purpose = 'share_link', templateKey, templateVersion }) {
  const resume = await store.getResume(resumeId);
  store.assert(resume, 404, 'RESUME_NOT_FOUND', 'resume not found');
  const branch = await store.getBranch(resumeId, branchKey);
  store.assert(branch, 404, 'BRANCH_NOT_FOUND', `branch ${branchKey} not found`);
  // shares also honor an approved locked template
  const locked = await store.getLockedTemplate(resumeId, branchKey);
  const tpl = getTemplate(templateKey || locked?.templateKey || 'classic',
    templateVersion || locked?.templateVer);
  const entities = await store.listEntities(resumeId);
  const privacy = await store.listFieldPrivacy(resumeId);

  const entitiesById = new Map(entities.map((e) => [e.id, e]));
  const versionMap = {};
  for (const item of branch.items || []) {
    const e = entitiesById.get(item.id);
    if (e) versionMap[e.id] = e.version;
  }
  const { content, stripped } = filterContentForPurpose({
    branch, entitiesById, profile: resume.profile || {}, privacy, purpose,
  });

  const token = newToken();
  const rec = await store.createShare({
    token, resumeId, branchKey, purpose,
    content: { items: branch.items, entityVersions: versionMap, profileVersion: 1 },
    render: { blocks: tpl.render(content, { purpose }), profile: content.profile },
    templateKey: tpl.key, templateVer: tpl.version,
  });
  return { token, branchKey, purpose, templateKey: tpl.key, templateVersion: tpl.version, strippedAtCapture: stripped };
}

/**
 * Read a share token. Re-filters stored snapshot against CURRENT privacy by re-rendering
 * from current entities (facts selected at snapshot time only), then enforces versions.
 */
export async function readShare({ store, token }) {
  const share = await store.getShare(token);
  store.assert(share, 404, 'SHARE_NOT_FOUND', 'share link not found');
  store.assert(!share.revoked, 410, 'SHARE_REVOKED', 'share link has been revoked');

  const resume = await store.getResume(share.resumeId);
  const entities = await store.listEntities(share.resumeId);
  const privacy = await store.listFieldPrivacy(share.resumeId);
  const entitiesById = new Map(entities.map((e) => [e.id, e]));

  // Rebuild branch view from FROZEN selection, but with current field values + current privacy.
  const frozenBranch = { key: share.branchKey, items: share.content.items, page: { width: 595, height: 842 } };
  const { content, stripped } = filterContentForPurpose({
    branch: frozenBranch, entitiesById, profile: resume?.profile || {}, privacy,
    purpose: share.purpose,
  });

  const versionDrift = [];
  for (const [id, v] of Object.entries(share.content.entityVersions || {})) {
    const cur = entitiesById.get(id);
    if (cur && cur.version !== v) versionDrift.push({ entityId: id, captured: v, current: cur.version });
  }

  const tpl = getTemplate(share.templateKey, share.templateVer);
  return {
    token, branchKey: share.branchKey, purpose: share.purpose,
    templateKey: share.templateKey, templateVersion: share.templateVer,
    createdAt: share.createdAt,
    content, // sanitized only
    blocks: tpl.render(content, { purpose: share.purpose }),
    note: versionDrift.length ? '部分事实自分享后更新，链接展示最新已允许内容' : undefined,
    versionDrift,
    nowStripped: stripped,
  };
}
