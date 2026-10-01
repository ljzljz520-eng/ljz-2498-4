import type {
  BranchCommit,
  ContentBranch,
  EntityCategory,
  ResumeDoc,
  ResumeEntity,
  VariantKind,
  VariantState,
} from "./types.ts";
import { newId } from "./ids.ts";
import { diffEntity, type ChangeContext } from "./lineage.ts";

/**
 * Pure document/variant operations.  The server persists the results in
 * PGlite; keeping logic here means the exact same rules run in API handlers
 * and in tests.
 */

export function createDoc(id: string, title: string, name = ""): ResumeDoc {
  return {
    id,
    title,
    profile: { name, fields: {}, privacy: {}, rev: 0 },
    entities: [],
  };
}

export function upsertEntity(
  doc: ResumeDoc,
  entity: Omit<ResumeEntity, "rev" | "updatedAt"> & { rev?: number },
  ctx: ChangeContext,
): { doc: ResumeDoc; entity: ResumeEntity; lineage: ReturnType<typeof diffEntity> } {
  const idx = doc.entities.findIndex((e) => e.id === entity.id);
  const before = idx >= 0 ? doc.entities[idx] : undefined;
  const next: ResumeEntity = {
    ...entity,
    rev: (before?.rev ?? 0) + 1,
    updatedAt: ctx.at,
  } as ResumeEntity;
  const entities = [...doc.entities];
  if (idx >= 0) entities[idx] = next;
  else entities.push(next);
  // new entities join BOTH variants by default only if asked; variants
  // control entityIds themselves (see addEntityToVariant).
  return {
    doc: { ...doc, entities },
    entity: next,
    lineage: diffEntity(before, next, ctx),
  };
}

export function addEntityToVariant(
  variant: VariantState,
  entityId: string,
  kind: EntityCategory,
): VariantState {
  void kind;
  if (variant.entityIds.includes(entityId)) return variant;
  return { ...variant, entityIds: [...variant.entityIds, entityId] };
}

/**
 * Hide a field in ONE variant.  The source fact is never touched and the
 * other variant keeps showing it.  This is the primitive that backs
 * "一页版与详细版可选不同条目".
 */
export function setFieldHidden(variant: VariantState, key: string, hidden: boolean): VariantState {
  const has = variant.hiddenFields.includes(key);
  if (hidden && !has) return { ...variant, hiddenFields: [...variant.hiddenFields, key] };
  if (!hidden && has) {
    return { ...variant, hiddenFields: variant.hiddenFields.filter((k) => k !== key) };
  }
  return variant;
}

/** Move an entity to another variant: removes here, guarantees presence there. */
export function moveEntity(
  from: VariantState,
  to: VariantState,
  entityId: string,
): { from: VariantState; to: VariantState } {
  return {
    from: { ...from, entityIds: from.entityIds.filter((id) => id !== entityId) },
    to: addEntityToVariant(to, entityId, "experience"),
  };
}

export function createBranch(
  resumeId: string,
  name: string,
  kind: ContentBranch["kind"],
  parentCommitId: string | null,
  at: string,
): ContentBranch {
  return {
    id: newId("br"),
    resumeId,
    name,
    kind,
    parentCommitId,
    createdAt: at,
    archived: false,
  };
}

export function makeCommit(
  branch: ContentBranch,
  parent: BranchCommit | null,
  doc: ResumeDoc,
  message: string,
  author: string,
  at: string,
): BranchCommit {
  return {
    id: newId("co"),
    branchId: branch.id,
    parentId: parent?.id ?? null,
    docSnapshot: structuredClone(doc),
    message,
    author,
    createdAt: at,
  };
}

export function createVariant(
  resumeId: string,
  branchId: string,
  kind: VariantKind,
  name: string,
  entityIds: string[],
): VariantState {
  return {
    id: newId("var"),
    resumeId,
    kind,
    name,
    branchId,
    entityIds,
    hiddenFields: [],
    pinnedTemplate: null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Restore a previously approved layout after a template update:
 * repoint a variant at the template version recorded by the snapshot.
 */
export function pinVariantToSnapshot(variant: VariantState, templateVersion: string): VariantState {
  return { ...variant, pinnedTemplate: templateVersion, updatedAt: new Date().toISOString() };
}

/**
 * Audit helper: given a source doc and a variant, list facts present in the
 * source but not rendered by the variant.  Lets the UI state plainly what is
 * excluded by choice — the system never drops facts silently.
 */
export function listHiddenFacts(doc: ResumeDoc, variant: VariantState) {
  const missing: { entityId: string; title: string; field?: string }[] = [];
  for (const e of doc.entities) {
    if (!variant.entityIds.includes(e.id)) {
      missing.push({ entityId: e.id, title: e.title });
      continue;
    }
    for (const f of Object.keys(e.fields)) {
      if (variant.hiddenFields.includes(`${e.id}:${f}`)) {
        missing.push({ entityId: e.id, title: e.title, field: f });
      }
    }
  }
  return missing;
}
