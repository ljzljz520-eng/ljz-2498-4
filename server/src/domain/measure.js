/**
 * Server-side real measurement + overflow tradeoff planning.
 * Also compares the client's predicted pagination (sent in the request) with the server
 * result and reports page/height drift so the UI can warn and offer a version lock.
 */
import { getTemplate, TEMPLATES } from '../render/templates.js';
import { layoutDocument } from '../render/layout.js';
import { filterContentForPurpose } from './privacy.js';

function pageMaxPages(branch, req) {
  if (req.maxPages != null) return req.maxPages;
  if (branch.page?.maxPages != null) return branch.page.maxPages;
  return branch.key === 'onepage' ? 1 : Infinity;
}

/** Assemble entitiesById map and a profile pseudo-entity from resume-scoped entities. */
export function assemble({ branch, entities, profile, privacy, purpose = 'internal' }) {
  const entitiesById = new Map(entities.map((e) => [e.id, e]));
  return filterContentForPurpose({ branch, entitiesById, profile, privacy, purpose });
}

/**
 * Measure branch under a template version. Returns layout plus metadata needed by UI:
 * {templateKey,templateVersion,layout,templateOutdated,overflow,tradeoffs,clientDiff}
 *
 * @param req.maxPages optional explicit acceptance (e.g. user chose "allow two pages")
 */
export function measureBranch({ branch, entities, profile, privacy, purpose, templateKey, templateVersion, clientPrediction, locked, maxPages }) {
  const tpl = getTemplate(templateKey, templateVersion);
  const { content, stripped } = assemble({
    branch, entities, profile, privacy, purpose,
  });
  const limitPages = pageMaxPages(branch, { maxPages });
  const page = { ...branch.page, margin: tpl.margins, maxPages: limitPages };
  const blocks = tpl.render(content, { purpose });
  const laid = layoutDocument(blocks, page);

  const overflow = laid.totalPages > limitPages
    || laid.warnings.some((w) => w.type === 'GROUP_TALLER_THAN_PAGE');

  return {
    templateKey, templateVersion: tpl.version,
    latestVersion: templateRegistryLatest(templateKey),
    templateOutdated: tpl.version !== templateRegistryLatest(templateKey),
    locked: !!locked,
    purpose,
    metrics: {
      totalPages: laid.totalPages,
      totalHeight: Math.round(laid.totalHeight * 10) / 10,
      contentHeight: laid.contentHeight,
      fitsOnePage: branch.key === 'onepage' ? !overflow : null,
      warnings: laid.warnings,
    },
    stripped,
    overflow,
    tradeoffs: overflow ? planTradeoffs({ branch, entities, profile, privacy, purpose, templateKey, templateVersion, laid }) : [],
    clientDiff: diffPrediction(clientPrediction, laid),
    // internal handle for downstream rendering
    _laid: laid,
  };
}

function templateRegistryLatest(key) {
  return TEMPLATES[key]?.latest;
}

/**
 * Actionable tradeoffs: simulate each candidate action and report estimated saved height.
 * Facts are never silently deleted: every action is a visibility/selection change the user
 * must explicitly choose; underlying entities stay in the resume.
 */
export function planTradeoffs(ctx) {
  const actions = [];
  const { branch, entities } = ctx;
  // 1) shorten long URLs (hide url field in project entities selected by this branch)
  for (const item of branch.items || []) {
    const e = entities.find((x) => x.id === item.id);
    if (e?.fields?.url && String(e.fields.url).length > 40) {
      actions.push({
        id: `hide-url:${e.id}`,
        kind: 'hideField',
        label: `隐藏项目「${e.fields.name || e.id}」的长链接 (${e.fields.url.slice(0, 48)}…)`,
        target: { entityId: e.id, field: 'url' },
        savedPt: estimateAction(ctx, { type: 'hideField', entityId: e.id, field: 'url' }),
        reversible: true,
      });
    }
  }
  // 2) collapse summaries to one line (detailLevel brief) — long text facts are kept, just truncated in view
  for (const item of branch.items || []) {
    const e = entities.find((x) => x.id === item.id);
    if (e?.fields?.summary && item.detailLevel !== 'brief') {
      actions.push({
        id: `brief:${e.id}`,
        kind: 'setDetailLevel',
        label: `「${e.fields.role || e.fields.name || e.id}」经历只显示首行摘要（事实保留）`,
        target: { itemId: item.id, detailLevel: 'brief' },
        savedPt: estimateAction(ctx, { type: 'setDetailLevel', itemId: item.id }),
        reversible: true,
      });
    }
  }
  // 3) move an entry from this branch selection (it stays available for detailed branch)
  for (const item of branch.items || []) {
    const e = entities.find((x) => x.id === item.id);
    actions.push({
      id: `deselect:${item.id}`,
      kind: 'deselectItem',
      label: `本页版不包含「${e?.fields?.role || e?.fields?.name || e?.fields?.school || item.id}」（仍在详细版与事实库中）`,
      target: { itemId: item.id },
      savedPt: estimateAction(ctx, { type: 'deselectItem', itemId: item.id }),
      reversible: true,
    });
  }
  // 4) switch to compact template (only if not already)
  if (ctx.templateKey !== 'compact') {
    actions.push({
      id: 'template:compact',
      kind: 'switchTemplate',
      label: '切换到 Compact 版式（条目完全保留）',
      target: { templateKey: 'compact' },
      savedPt: estimateAction(ctx, { type: 'switchTemplate' }),
      reversible: true,
    });
  }
  // 5) split into 2 pages (allow overflow into page 2) — never deletes anything
  actions.push({
    id: 'allow-two-pages',
    kind: 'allowPages',
    label: `接受 2 页输出（当前 ${ctx.laid.totalPages} 页，全部事实保留）`,
    target: { maxPages: 2 },
    savedPt: 0,
    reversible: true,
  });

  return actions
    .map((a) => ({ ...a, savedPt: Math.round(a.savedPt) }))
    .sort((a, b) => b.savedPt - a.savedPt);
}

function simulate(ctx, mutation) {
  const branch = JSON.parse(JSON.stringify(ctx.branch));
  const entities = JSON.parse(JSON.stringify(ctx.entities));
  if (mutation.type === 'hideField') {
    const item = branch.items.find((i) => i.id === mutation.entityId);
    // simulate privacy strip by blanking
    const e = entities.find((x) => x.id === mutation.entityId);
    if (e) e.fields[mutation.field] = '';
  } else if (mutation.type === 'setDetailLevel') {
    const item = branch.items.find((i) => i.id === mutation.itemId);
    if (item) item.detailLevel = 'brief';
    // truncate summary field for simulation
    const e = entities.find((x) => x.id === mutation.itemId);
    if (e?.fields?.summary) e.fields.summary = e.fields.summary.split(/(?<=[。.!?！？])/)[0]?.slice(0, 60) || '';
  } else if (mutation.type === 'deselectItem') {
    branch.items = branch.items.filter((i) => i.id !== mutation.itemId);
  }
  const tplKey = mutation.type === 'switchTemplate' ? 'compact' : ctx.templateKey;
  const tpl = getTemplate(tplKey, undefined);
  const { content } = assemble({ branch, entities, profile: ctx.profile, privacy: ctx.privacy, purpose: ctx.purpose });
  const page = { ...branch.page, margin: tpl.margins, maxPages: Infinity };
  const laid = layoutDocument(tpl.render(content, { purpose: ctx.purpose }), page);
  return laid;
}

function estimateAction(ctx, mutation) {
  const before = ctx.laid.totalHeight;
  const after = simulate(ctx, mutation).totalHeight;
  return Math.max(0, before - after);
}

/** Compare client prediction vs server truth. */
export function diffPrediction(client, laid) {
  if (!client) return null;
  const srvPages = laid.totalPages;
  const cliPages = client.totalPages;
  const srvHeight = Math.round(laid.totalHeight);
  const cliHeight = Math.round(client.totalHeight || 0);
  const pageMismatch = cliPages !== srvPages;
  const heightDriftPt = Math.abs(cliHeight - srvHeight);
  // client may report per-block heights; compare index-wise where present
  const blockDiffs = [];
  if (Array.isArray(client.unitHeights)) {
    laid.units.forEach((u, i) => {
      if (client.unitHeights[i] != null && Math.abs(client.unitHeights[i] - u.h) > 0.75) {
        blockDiffs.push({ index: i, client: client.unitHeights[i], server: Math.round(u.h * 10) / 10, delta: Math.round((u.h - client.unitHeights[i]) * 10) / 10 });
      }
    });
  }
  return {
    clientPages: cliPages, serverPages: srvPages, pageMismatch,
    clientHeight: cliHeight, serverHeight: srvHeight, heightDriftPt,
    significant: pageMismatch || heightDriftPt > 12 || blockDiffs.length > 0,
    blockDiffs,
  };
}
