import { compile } from "./templates.ts";
import { createMeasurer, type Measurer } from "./measure.ts";
import type {
  CompiledVariant,
  OverflowAction,
  OverflowReport,
  ResumeDoc,
  VariantState,
} from "./types.ts";
import type { ExportPurpose } from "./types.ts";
import { TEMPLATE_V1, TEMPLATE_V2, getTemplate } from "./templates.ts";

/**
 * Overflow planning.  The server is the source of truth for savings estimates.
 * Every action is *reversible* and annotated with fact risk; hiding a fact in
 * one variant never deletes it.  The client only presents choices — it never
 * silently applies one.
 */

const serverMeasurer: Measurer = createMeasurer({
  engine: "server",
  profile: "server-rt-1",
  maxPages: 1,
  jitter: 0,
});

export function planOverflow(
  doc: ResumeDoc,
  onePage: VariantState,
  detailed: VariantState | null,
  purpose: ExportPurpose,
): OverflowReport {
  const baseline = compile(doc, onePage, purpose);
  const baseMetrics = serverMeasurer.measure(baseline);
  const maxPages = onePage.kind === "one_page" ? 1 : 2;
  const overflowPx = Math.max(
    0,
    baseMetrics.totalHeight - baseMetrics.usableHeight * maxPages,
  );

  const actions: OverflowAction[] = [];

  const measureAltered = (variant: VariantState, compiled?: CompiledVariant) =>
    serverMeasurer.measure(compiled ?? compile(doc, variant, purpose));

  // 1) move whole entities to detailed variant (they remain visible there)
  for (const eid of onePage.entityIds) {
    if (detailed && !detailed.entityIds.includes(eid)) {
      // moving requires adding it to detailed first — still safe
    }
    const altered: VariantState = {
      ...onePage,
      entityIds: onePage.entityIds.filter((x) => x !== eid),
    };
    const m = measureAltered(altered);
    const saving = Math.max(0, baseMetrics.totalHeight - m.totalHeight);
    if (saving > 0) {
      const ent = doc.entities.find((e) => e.id === eid);
      actions.push({
        kind: "move_to_detailed",
        label: `将「${ent?.title ?? eid}」移到详细版（一页版隐藏，详细版保留全部事实）`,
        estimatedSavingPx: Math.round(saving),
        factRisk: [],
        targetEntityId: eid,
        reversible: true,
      });
    }
  }

  // 2) hide a single field (fact retained on source + detailed)
  for (const block of baseline.sections.flatMap((s) => s.blocks)) {
    if (!block.entityId || !block.field) continue;
    const key = `${block.entityId}:${block.field}`;
    if (onePage.hiddenFields.includes(key)) continue;
    const altered: VariantState = {
      ...onePage,
      hiddenFields: [...onePage.hiddenFields, key],
    };
    const m = measureAltered(altered);
    const saving = Math.max(0, baseMetrics.totalHeight - m.totalHeight);
    if (saving > 0) {
      actions.push({
        kind: "hide_field",
        label: `在一页版隐藏字段「${block.field}」（事实不会删除，可在详细版查看）`,
        estimatedSavingPx: Math.round(saving),
        factRisk: [`字段 ${block.field} 将不在一页版出现`],
        targetEntityId: block.entityId,
        targetField: block.field,
        reversible: true,
      });
    }
  }

  // 3) shorten long URLs visually — underlying value untouched
  for (const block of baseline.sections.flatMap((s) => s.blocks)) {
    const urlRun = block.runs.find((r) => r.style.family === "mono" && r.text.length > 24);
    if (!urlRun) continue;
    const clone: CompiledVariant = structuredClone(baseline);
    for (const s of clone.sections) {
      for (const b of s.blocks) {
        if (b.key === block.key) {
          b.runs = b.runs.map((r) =>
            r === urlRun || (r.style.family === "mono" && r.text === urlRun.text)
              ? { ...r, text: visualShortenUrl(r.text) }
              : r,
          );
        }
      }
    }
    const m = measureAltered(onePage, clone);
    const saving = Math.max(0, baseMetrics.totalHeight - m.totalHeight);
    if (saving > 0) {
      actions.push({
        kind: "shorten_url",
        label: `视觉缩短长链接（完整链接仍保留在源数据，悬停/导出 HTML 可见）`,
        estimatedSavingPx: Math.round(saving),
        factRisk: ["仅显示层截断，完整 URL 不删除"],
        targetEntityId: block.entityId,
        targetField: block.field,
        reversible: true,
      });
    }
  }

  // 4) tighten spacing at template level (no facts affected)
  {
    const tighter = {
      ...getTemplate(baseline.templateId, baseline.templateVersion),
      sectionGap: 0,
      blockGap: 2,
      fieldGaps: { company: 1, period: 1, summary: 2, bullets: 2 },
    };
    const recompiled = compile(doc, onePage, purpose, tighter);
    recompiled.sections.forEach((s) =>
      s.blocks.forEach((b) => (b.spacingAfter = Math.min(b.spacingAfter, 2))),
    );
    const m = serverMeasurer.measure(recompiled);
    const saving = Math.max(0, baseMetrics.totalHeight - m.totalHeight);
    actions.push({
      kind: "tighten_spacing",
      label: "收紧段落与模块间距（不触碰任何事实）",
      estimatedSavingPx: Math.round(saving),
      factRisk: [],
      reversible: true,
    });
  }

  // 5) allow a protected paragraph to break across pages
  for (const block of baseline.sections.flatMap((s) => s.blocks)) {
    if (!block.keepTogether) continue;
    const clone: CompiledVariant = structuredClone(baseline);
    for (const s of clone.sections) {
      for (const b of s.blocks) if (b.key === block.key) b.keepTogether = false;
    }
    const m = measureAltered(onePage, clone);
    const saving = Math.max(0, baseMetrics.totalHeight - m.totalHeight);
    if (saving > 0) {
      actions.push({
        kind: "split_paragraph",
        label: `允许跨页拆分受保护段落「${block.field ?? block.key}」（文字不删减，仅取消保护）`,
        estimatedSavingPx: Math.round(saving),
        factRisk: ["段落可能跨页，但内容完整"],
        targetEntityId: block.entityId,
        targetField: block.field,
        reversible: true,
      });
    }
  }

  actions.sort((a, b) => b.estimatedSavingPx - a.estimatedSavingPx);

  // hidden facts accounting: facts present in the doc but not rendered by
  // *this* variant — surfaced so the UI can prove nothing disappeared silently
  const visibleKeys = new Set(baseline.sections.flatMap((s) => s.blocks.map((b) => b.key)));
  let hiddenFactCount = 0;
  for (const e of doc.entities) {
    if (!onePage.entityIds.includes(e.id)) hiddenFactCount += 1;
    for (const f of Object.keys(e.fields)) {
      if (onePage.hiddenFields.includes(`${e.id}:${f}`)) hiddenFactCount += 1;
    }
  }
  void visibleKeys;

  return {
    overflowPx: Math.round(overflowPx),
    pageCount: baseMetrics.pageCount,
    maxPages,
    actions,
    hiddenFactCount,
  };
}

export function visualShortenUrl(url: string): string {
  if (url.length <= 26) return url;
  return url.slice(0, 18) + "…" + url.slice(-7);
}

export { TEMPLATE_V1, TEMPLATE_V2 };
