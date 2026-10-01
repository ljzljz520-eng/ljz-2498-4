// ---------------------------------------------------------------------------
// Core domain types shared by the Vue client and the Node server.
// Everything that crosses the network boundary or influences a rendered page
// is modelled here so the client prediction and the server measurement speak
// exactly the same language.
// ---------------------------------------------------------------------------

export type EntityCategory = "experience" | "project" | "education";

/** Privacy sensitivity of a single shared field. */
export type PrivacyLevel = "public" | "internal" | "sensitive";

/** Why an export is produced — decides which privacy levels survive. */
export type ExportPurpose = "public_link" | "recruiter_email" | "internal_archive";

/**
 * A resume entity. One logical row (experience / project / education) is
 * shared across every variant (one-page, detailed, ...).  Variants only pick
 * *which* entities they show and *which fields* stay visible; they never own
 * private copies of the facts.
 */
export interface ResumeEntity {
  id: string;
  category: EntityCategory;
  title: string;
  /** free-form display fields, keyed by field name */
  fields: Record<string, string>;
  /** privacy metadata for individual fields */
  privacy: Record<string, PrivacyLevel>;
  /** optimistic-concurrency token, bumped on every accepted write */
  rev: number;
  updatedAt: string;
}

export interface ResumeProfile {
  name: string;
  fields: Record<string, string>;
  privacy: Record<string, PrivacyLevel>;
  rev: number;
}

export interface ResumeDoc {
  id: string;
  title: string;
  profile: ResumeProfile;
  entities: ResumeEntity[];
}

// ---- Content branches ------------------------------------------------------

export type BranchKind = "main" | "draft";

export interface ContentBranch {
  id: string;
  resumeId: string;
  name: string;
  kind: BranchKind;
  parentCommitId: string | null;
  createdAt: string;
  archived: boolean;
}

export interface BranchCommit {
  id: string;
  branchId: string;
  parentId: string | null;
  docSnapshot: ResumeDoc;
  message: string;
  author: string;
  createdAt: string;
}

// ---- Variants (one-page / detailed / ...) ----------------------------------

export type VariantKind = "one_page" | "detailed";

/**
 * Visibility is an *allow* list of references.  Facts that are not listed are
 * simply not rendered — they are never deleted from the source document.
 */
export interface VariantState {
  id: string;
  resumeId: string;
  kind: VariantKind;
  name: string;
  branchId: string;
  /** entity ids included in this variant, in display order */
  entityIds: string[];
  /**
   * Field visibility keyed `${entityId}:${field}` — missing key means the
   * field default applies (title is always visible, others visible by
   * default unless hidden).  Profile fields use `profile:${field}`.
   */
  hiddenFields: string[];
  /** approved template version pin — null = track latest */
  pinnedTemplate: string | null;
  updatedAt: string;
}

export interface FieldLineageEntry {
  entityId: string;
  field: string | null; // null = the entity title / whole row
  oldValue: string;
  newValue: string;
  revBefore: number;
  revAfter: number;
  author: string;
  at: string;
  baseRev: number;
  merged: boolean;
}

// ---- Metrics ---------------------------------------------------------------

export type FontFamily = "sans" | "serif" | "mono";

export interface FontSpec {
  family: FontFamily;
  /** average glyph advance in px at 1px font-size */
  avgAdvance: number;
  /** per-character width overrides keyed by codepoint */
  advances: Record<string, number>;
  /** codepoints this font natively covers; missing ones trigger fallback */
  covers: string[];
  lineHeight: number;
}

export interface TextStyle {
  family: FontFamily;
  size: number;
  bold?: boolean;
}

export interface RenderBlock {
  key: string;
  entityId?: string;
  field?: string;
  privacy?: PrivacyLevel;
  style: TextStyle;
  /**
   * Text is kept as a list of runs so a single paragraph may mix fonts
   * (e.g. a long URL written in mono inside a sans paragraph).
   */
  runs: { text: string; style: TextStyle }[];
  /** paragraph protection: block may not be split across pages */
  keepTogether?: boolean;
  spacingAfter: number;
}

export interface RenderSection {
  id: string;
  title: string;
  category: EntityCategory | "profile";
  blocks: RenderBlock[];
}

export interface CompiledVariant {
  variantId: string;
  templateId: string;
  templateVersion: string;
  page: PageSpec;
  sections: RenderSection[];
}

export interface PageSpec {
  width: number; // px
  height: number; // px
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
}

export interface BlockMeasure {
  key: string;
  height: number;
  lines: number;
  pages: number[]; // page indices the block lands on
  fallbackGlyphs: string[]; // codepoints that required font fallback
  overflow: boolean; // keepTogether block did not fit on a single page
}

export interface MeasureResult {
  pageWidth: number;
  usableHeight: number;
  pageCount: number;
  blocks: BlockMeasure[];
  totalHeight: number;
  /** true when content exceeds the variant's page budget */
  exceeds: boolean;
  maxPages: number;
  fallbackGlyphs: string[];
  engine: "client" | "server";
  /** profile of measurer, surfaced in discrepancy reports */
  profile: string;
}

// ---- Overflow trade-offs ---------------------------------------------------

export type OverflowActionKind =
  | "move_to_detailed"   // one page -> hide entity here, keep in detailed
  | "hide_field"         // hide one non-fact-critical field
  | "shorten_url"        // visual truncation; full URL preserved
  | "tighten_spacing"    // template-level spacing reduction
  | "split_paragraph";   // explicitly allow the protected paragraph to break

export interface OverflowAction {
  kind: OverflowActionKind;
  label: string;
  /** estimated px saved, always computed by the *server* measurer */
  estimatedSavingPx: number;
  /** facts at risk — when non-empty the UI must show an explicit warning */
  factRisk: string[];
  targetEntityId?: string;
  targetField?: string;
  reversible: boolean;
}

export interface OverflowReport {
  overflowPx: number;
  pageCount: number;
  maxPages: number;
  /** actions that each alone resolve (or reduce) the overflow */
  actions: OverflowAction[];
  /** number of facts that exist but are not rendered — must never grow silently */
  hiddenFactCount: number;
}

// ---- Snapshots / shares / exports ------------------------------------------

export interface VariantSnapshot {
  id: string;
  variantId: string;
  resumeId: string;
  branchId: string;
  commitId: string;
  templateId: string;
  templateVersion: string; // LOCKED at snapshot time
  purpose: ExportPurpose;
  /** already privacy-projected compiled content — the only thing shares expose */
  compiled: CompiledVariant;
  metrics: MeasureResult;
  createdAt: string;
}

export interface ExportRecord {
  id: string;
  snapshotId: string;
  purpose: ExportPurpose;
  format: "pdf" | "html";
  status: "pending" | "succeeded" | "failed";
  path: string | null;
  error: string | null;
  /** monotonic token; a job whose token is below the latest is "late" */
  token: number;
  superseded: boolean;
  createdAt: string;
  finishedAt: string | null;
  bytes: number | null;
}

export interface ShareLink {
  token: string;
  snapshotId: string;
  revoked: boolean;
  createdAt: string;
}
