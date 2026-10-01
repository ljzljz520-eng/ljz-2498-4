import type {
  CompiledVariant,
  FontFamily,
  PageSpec,
  RenderBlock,
  RenderSection,
  ResumeDoc,
  ResumeEntity,
  TextStyle,
  VariantState,
} from "./types.ts";
import { projectFields } from "./privacy.ts";
import type { ExportPurpose } from "./types.ts";

/**
 * Templates are *versioned*.  A snapshot permanently records the template
 * version it was rendered with; users may also pin an approved version on a
 * variant.  When the template package is updated, previously approved
 * snapshots keep rendering with the locked version (regression safety).
 */
export interface TemplateDef {
  id: string;
  version: string;
  label: string;
  /** base font of the template — sections may override per field */
  baseFamily: FontFamily;
  baseSize: number;
  sectionGap: number;
  blockGap: number;
  fieldGaps: Record<string, number>;
  /** style overrides per field name, enabling mixed-font paragraphs */
  fieldStyles: Record<string, Partial<TextStyle>>;
  /** fields rendered as a single non-splittable paragraph */
  protectedParagraphFields: string[];
  /** long-link detection — these fields get URL-aware run splitting */
  urlFields: string[];
  page: PageSpec;
}

export const DEFAULT_PAGE: PageSpec = {
  width: 794, // A4 @96dpi
  height: 1123,
  marginTop: 56,
  marginBottom: 56,
  marginLeft: 64,
  marginRight: 64,
};

// v1 — the originally approved template
export const TEMPLATE_V1: TemplateDef = {
  id: "classic",
  version: "1.0.0",
  label: "经典（已认可版本）",
  baseFamily: "serif",
  baseSize: 13,
  sectionGap: 22,
  blockGap: 8,
  fieldGaps: { company: 2, period: 2, summary: 6, bullets: 6 },
  fieldStyles: {
    title: { bold: true, size: 15 },
    company: { size: 12 },
    period: { size: 11 },
    url: { family: "mono", size: 10.5 },
    bullets: { size: 12 },
    summary: { size: 12 },
  },
  protectedParagraphFields: ["summary"],
  urlFields: ["url", "link", "repo"],
  page: DEFAULT_PAGE,
};

// v2 — updated template (tighter rhythm).  Older snapshots still pin v1.
export const TEMPLATE_V2: TemplateDef = {
  ...TEMPLATE_V1,
  version: "2.0.0",
  label: "经典 v2（更新版）",
  sectionGap: 18,
  blockGap: 5,
  baseSize: 12.5,
  fieldGaps: { company: 2, period: 2, summary: 5, bullets: 5 },
};

export const TEMPLATES: Record<string, TemplateDef[]> = {
  classic: [TEMPLATE_V2, TEMPLATE_V1], // index 0 = latest
};

export function latestTemplate(id = "classic"): TemplateDef {
  return TEMPLATES[id][0];
}

export function getTemplate(id: string, version: string): TemplateDef {
  const set = TEMPLATES[id];
  if (!set) throw new Error(`unknown template: ${id}`);
  const hit = set.find((t) => t.version === version);
  if (!hit) throw new Error(`unknown template version: ${id}@${version}`);
  return hit;
}

/** Resolve the template a variant currently renders with (pin or latest). */
export function resolveTemplate(variant: VariantState): TemplateDef {
  if (variant.pinnedTemplate) return getTemplate("classic", variant.pinnedTemplate);
  return latestTemplate("classic");
}

// ---------------------------------------------------------------------------
// Compilation: doc + variant visibility + purpose -> renderable sections.
// Compilation never mutates the doc; hidden facts remain in `doc.entities`.
// ---------------------------------------------------------------------------

const URL_RE = /(https?:\/\/[^\s]+|[\w.-]+\.[a-z]{2,}(?:\/[^\s]*)?)/g;

function splitRuns(text: string, base: TextStyle, isUrlField: boolean) {
  const runs: { text: string; style: TextStyle }[] = [];
  if (!isUrlField) {
    runs.push({ text, style: { ...base } });
    return runs;
  }
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) runs.push({ text: text.slice(last, idx), style: { ...base } });
    runs.push({
      text: m[0],
      style: { ...base, family: "mono", size: Math.max(10, (base.size ?? 12) - 1) },
    });
    last = idx + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), style: { ...base } });
  return runs;
}

export function compile(
  doc: ResumeDoc,
  variant: VariantState,
  purpose: ExportPurpose,
  template?: TemplateDef,
): CompiledVariant {
  const tpl = template ?? resolveTemplate(variant);
  const sections: RenderSection[] = [];

  // ---- profile section ----------------------------------------------------
  {
    const pfields = projectFields(doc.profile.fields, doc.profile.privacy, purpose);
    const blocks: RenderBlock[] = [];
    blocks.push({
      key: "profile:name",
      field: "name",
      style: { family: tpl.baseFamily, size: 20, bold: true },
      runs: [{ text: doc.profile.name, style: { family: tpl.baseFamily, size: 20, bold: true } }],
      spacingAfter: 6,
      privacy: "public",
    });
    for (const [field, value] of Object.entries(pfields)) {
      if (variant.hiddenFields.includes(`profile:${field}`)) continue;
      const style: TextStyle = { family: tpl.baseFamily, size: tpl.baseSize, ...(tpl.fieldStyles[field] ?? {}) };
      blocks.push({
        key: `profile:${field}`,
        field,
        style,
        runs: splitRuns(value, style, tpl.urlFields.includes(field)),
        spacingAfter: tpl.fieldGaps[field] ?? tpl.blockGap,
        privacy: doc.profile.privacy[field] ?? "public",
      });
    }
    sections.push({ id: "profile", title: "", category: "profile", blocks });
  }

  // ---- entity sections ----------------------------------------------------
  const order: ResumeDoc["entities"][number]["category"][] = ["experience", "project", "education"];
  const titles: Record<string, string> = {
    experience: "工作经历",
    project: "项目",
    education: "教育",
  };
  const byId = new Map(doc.entities.map((e) => [e.id, e]));
  for (const cat of order) {
    const blocks: RenderBlock[] = [];
    for (const id of variant.entityIds) {
      const ent = byId.get(id);
      if (!ent || ent.category !== cat) continue;
      const visible = projectFields(ent.fields, ent.privacy, purpose);
      // entity title block (protected with the first field so rows stay whole by default)
      const titleStyle: TextStyle = { family: tpl.baseFamily, size: tpl.baseSize, ...(tpl.fieldStyles.title ?? {}) };
      blocks.push({
        key: `${ent.id}:title`,
        entityId: ent.id,
        field: "title",
        style: titleStyle,
        runs: [{ text: ent.title, style: titleStyle }],
        spacingAfter: tpl.fieldGaps.company ?? tpl.blockGap,
        keepTogether: true,
      });
      for (const [field, value] of Object.entries(visible)) {
        if (variant.hiddenFields.includes(`${ent.id}:${field}`)) continue;
        const style: TextStyle = {
          family: tpl.baseFamily,
          size: tpl.baseSize,
          ...(tpl.fieldStyles[field] ?? {}),
        };
        blocks.push({
          key: `${ent.id}:${field}`,
          entityId: ent.id,
          field,
          style,
          runs: splitRuns(multilineSafe(value), style, tpl.urlFields.includes(field)),
          spacingAfter: tpl.fieldGaps[field] ?? tpl.blockGap,
          keepTogether: tpl.protectedParagraphFields.includes(field),
          privacy: ent.privacy[field] ?? "public",
        });
      }
    }
    if (blocks.length) sections.push({ id: cat, title: titles[cat], category: cat, blocks });
  }

  return {
    variantId: variant.id,
    templateId: tpl.id,
    templateVersion: tpl.version,
    page: tpl.page,
    sections,
  };
}

function multilineSafe(v: string): string {
  return v.replace(/\r\n/g, "\n");
}
