const BASE = '';
async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || res.statusText), { status: res.status, data });
  return data;
}

export const api = {
  createResume: (body) => req('/api/resumes', { method: 'POST', body }),
  getResume: (id) => req(`/api/resumes/${id}`),
  updateProfile: (id, profile) => req(`/api/resumes/${id}/profile`, { method: 'PUT', body: { profile } }),
  saveEntity: (id, body) => req(`/api/resumes/${id}/entities`, { method: 'POST', body }),
  setPrivacy: (id, fieldPath, purposes) =>
    req(`/api/resumes/${id}/privacy`, { method: 'PUT', body: { fieldPath, purposes } }),
  setItem: (id, key, body) => req(`/api/resumes/${id}/branches/${key}/items`, { method: 'POST', body }),
  saveBranchItems: (id, key, items, expectedVersion) =>
    req(`/api/resumes/${id}/branches/${key}`, { method: 'PUT', body: { items, expectedVersion } }),
  updateBranch: (id, key, patch, expectedVersion) =>
    req(`/api/resumes/${id}/branches/${key}`, { method: 'PUT', body: { ...patch, expectedVersion } }),
  measure: (id, key, body) => req(`/api/resumes/${id}/branches/${key}/measure`, { method: 'POST', body }),
  createShare: (id, body) => req(`/api/resumes/${id}/shares`, { method: 'POST', body }),
  revokeShare: (token) => req(`/api/shares/${token}`, { method: 'DELETE' }),
  readShare: (token) => req(`/api/shares/${token}`),
  export: (id, body) => req(`/api/resumes/${id}/exports`, { method: 'POST', body }),
  listExports: (id) => req(`/api/resumes/${id}/exports`),
  templates: () => req('/api/templates'),
};
