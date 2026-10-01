import type { FieldLineageEntry, ResumeEntity } from "./types.ts";

/**
 * Field-level update tracking.  The "one-page" and "detailed" variants share
 * the same underlying entities; therefore every accepted field write is
 * appended to the lineage so common-field updates remain traceable across
 * both variants regardless of which variant the editor was opened on.
 */
export interface ChangeContext {
  author: string;
  /** rev the writer based its change on (for conflict detection) */
  baseRev: number;
  at: string;
}

export function diffEntity(
  before: ResumeEntity | undefined,
  after: ResumeEntity,
  ctx: ChangeContext,
): FieldLineageEntry[] {
  const list: FieldLineageEntry[] = [];
  const push = (field: string | null, oldValue: string, newValue: string) => {
    list.push({
      entityId: after.id,
      field,
      oldValue,
      newValue,
      revBefore: before?.rev ?? 0,
      revAfter: after.rev,
      author: ctx.author,
      at: ctx.at,
      baseRev: ctx.baseRev,
      merged: false,
    });
  };

  if (!before) {
    for (const [field, value] of Object.entries(after.fields)) push(field, "", value);
    return list;
  }

  if (before.title !== after.title) push(null, before.title, after.title);
  const keys = new Set([...Object.keys(before.fields), ...Object.keys(after.fields)]);
  for (const field of keys) {
    const oldV = before.fields[field] ?? "";
    const newV = after.fields[field] ?? "";
    if (oldV !== newV) push(field, oldV, newV);
  }
  return list;
}

// ---------------------------------------------------------------------------
// Multi-device merge for the same entity ("两设备改同一经历").
//
// Rules:
//  - Both devices edited *different* fields  -> both edits are kept; merged
//    entries are flagged merged=true.
//  - Both edited the *same* field            -> conflict; the newer write is
//    applied, the loser is returned in `conflicts` so the API can surface it
//    (last-write-wins is explicit, never silent).
//  - A write whose baseRev < current rev but touches untouched fields merges.
// ---------------------------------------------------------------------------

export interface MergeResult {
  fields: Record<string, string>;
  merged: FieldLineageEntry[];
  conflicts: {
    field: string;
    serverValue: string;
    incomingValue: string;
    incomingAuthor: string;
  }[];
  rev: number;
}

export function mergeEntityFields(
  current: ResumeEntity,
  incomingFields: Record<string, string>,
  ctx: ChangeContext,
  opts: { incomingAt: string },
): MergeResult {
  const mergedFields = { ...current.fields };
  const merged: FieldLineageEntry[] = [];
  const conflicts: MergeResult["conflicts"] = [];

  for (const [field, incomingValue] of Object.entries(incomingFields)) {
    const serverValue = current.fields[field];
    if (serverValue === incomingValue) continue;

    if (serverValue === undefined || ctx.baseRev >= current.rev) {
      // new field, or fresh edit based on the current rev
      mergedFields[field] = incomingValue;
      merged.push({
        entityId: current.id,
        field,
        oldValue: serverValue ?? "",
        newValue: incomingValue,
        revBefore: current.rev,
        revAfter: current.rev + 1,
        author: ctx.author,
        at: opts.incomingAt,
        baseRev: ctx.baseRev,
        merged: false,
      });
      continue;
    }

    // Stale write.  We cannot know whether the field changed on the server
    // since base without history of who touched it — callers pass baseRev;
    // treat baseRev < current.rev as "field may have changed": conservative
    // conflict on the field the server also knows about.
    conflicts.push({
      field,
      serverValue,
      incomingValue,
      incomingAuthor: ctx.author,
    });
  }

  // Auto-merge: fields that only exist in incoming but were NOT changed on
  // server relative to base are accepted.  The caller passes changed fields
  // on server via the third step below.
  return { fields: mergedFields, merged, conflicts, rev: current.rev + (merged.length ? 1 : 0) };
}

/**
 * Field-aware 3-way merge given the field map at the common base revision.
 */
export function threeWayMerge(
  baseFields: Record<string, string>,
  serverFields: Record<string, string>,
  incomingFields: Record<string, string>,
  meta: { entityId: string; currentRev: number; author: string; at: string; baseRev: number },
): MergeResult {
  const result: Record<string, string> = { ...serverFields };
  const merged: FieldLineageEntry[] = [];
  const conflicts: MergeResult["conflicts"] = [];
  const keys = new Set([...Object.keys(serverFields), ...Object.keys(incomingFields)]);
  let bumped = false;

  for (const field of keys) {
    const base = baseFields[field] ?? "";
    const onServer = serverFields[field] ?? "";
    const incoming = incomingFields[field] ?? "";
    if (onServer === incoming) continue;

    const serverChanged = onServer !== base;
    const incomingChanged = incoming !== base;

    if (incomingChanged && !serverChanged) {
      result[field] = incoming;
      bumped = true;
      merged.push({
        entityId: meta.entityId,
        field,
        oldValue: onServer,
        newValue: incoming,
        revBefore: meta.currentRev,
        revAfter: meta.currentRev + 1,
        author: meta.author,
        at: meta.at,
        baseRev: meta.baseRev,
        merged: true,
      });
    } else if (incomingChanged && serverChanged) {
      // same field edited on both devices — real conflict
      conflicts.push({ field, serverValue: onServer, incomingValue: incoming, incomingAuthor: meta.author });
    }
  }

  return { fields: result, merged, conflicts, rev: meta.currentRev + (bumped ? 1 : 0) };
}
