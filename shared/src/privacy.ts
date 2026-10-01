import type { ExportPurpose, PrivacyLevel } from "./types.ts";

/**
 * Privacy projection rules per export purpose.
 *  - public_link      : only public fields
 *  - recruiter_email  : public + internal (no sensitive e.g. phone/id)
 *  - internal_archive : everything
 */
export const PURPOSE_LEVELS: Record<ExportPurpose, PrivacyLevel[]> = {
  public_link: ["public"],
  recruiter_email: ["public", "internal"],
  internal_archive: ["public", "internal", "sensitive"],
};

export const PURPOSE_LABEL: Record<ExportPurpose, string> = {
  public_link: "公开分享链接",
  recruiter_email: "招聘方邮件",
  internal_archive: "内部存档",
};

export const PRIVACY_LABEL: Record<PrivacyLevel, string> = {
  public: "公开",
  internal: "仅招聘方",
  sensitive: "敏感",
};

export function levelAllowed(level: PrivacyLevel | undefined, purpose: ExportPurpose): boolean {
  const effective: PrivacyLevel = level ?? "public";
  return PURPOSE_LEVELS[purpose].includes(effective);
}

/** Strip an object of values whose privacy level the purpose forbids. */
export function projectFields(
  fields: Record<string, string>,
  privacy: Record<string, PrivacyLevel>,
  purpose: ExportPurpose,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (levelAllowed(privacy[k], purpose)) out[k] = v;
  }
  return out;
}

/**
 * Returns the set of forbidden field keys.  Used by the share endpoint to
 * prove (in tests) that forbidden data was never serialised at all, rather
 * than hidden by the UI.
 */
export function forbiddenKeys(
  privacy: Record<string, PrivacyLevel>,
  purpose: ExportPurpose,
): Set<string> {
  const out = new Set<string>();
  for (const [k, level] of Object.entries(privacy)) {
    if (!levelAllowed(level, purpose)) out.add(k);
  }
  return out;
}
