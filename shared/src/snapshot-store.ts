import type {
  ExportPurpose,
  ResumeDoc,
  VariantSnapshot,
  VariantState,
} from "./types.ts";
import { compile, getTemplate } from "./templates.ts";
import { createMeasurer } from "./measure.ts";
import { newId } from "./ids.ts";

/**
 * Snapshot creation with privacy projection performed AT SNAPSHOT TIME.
 * A share token resolves to a snapshot whose payload contains ONLY the fields
 * allowed for its purpose — forbidden facts are not present in the serialised
 * payload at all, so they cannot leak even if the client is tampered with.
 */

export function buildSnapshotContent(
  doc: ResumeDoc,
  variant: VariantState,
  purpose: ExportPurpose,
  templateVersion?: string,
) {
  const template = templateVersion ? getTemplate("classic", templateVersion) : undefined;
  const compiled = compile(doc, variant, purpose, template);
  const maxPages = variant.kind === "one_page" ? 1 : 3;
  const measurer = createMeasurer({
    engine: "server",
    profile: "server-snapshot",
    maxPages,
    jitter: 0,
  });
  const metrics = measurer.measure(compiled);
  return { compiled, metrics, maxPages };
}

export function createSnapshot(
  doc: ResumeDoc,
  variant: VariantState,
  purpose: ExportPurpose,
  ctx: { branchId: string; commitId: string; at: string; templateVersion?: string },
): VariantSnapshot {
  const { compiled, metrics } = buildSnapshotContent(doc, variant, purpose, ctx.templateVersion);
  return {
    id: newId("snap"),
    variantId: variant.id,
    resumeId: doc.id,
    branchId: ctx.branchId,
    commitId: ctx.commitId,
    templateId: compiled.templateId,
    templateVersion: compiled.templateVersion, // LOCKED at snapshot time
    purpose,
    compiled,
    metrics,
    createdAt: ctx.at,
  };
}

/**
 * Defence-in-depth assertion used after building a snapshot and in tests:
 * scan the payload that will be sent to a share viewer and fail loudly if any
 * forbidden raw value made it in.
 */
export function assertNoForbiddenValues(snapshot: VariantSnapshot, forbiddenValues: string[]): string[] {
  const haystack = JSON.stringify(snapshot.compiled);
  return forbiddenValues.filter((v) => v.length > 0 && haystack.includes(v));
}
