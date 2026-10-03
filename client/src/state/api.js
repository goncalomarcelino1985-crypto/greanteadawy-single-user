// REST client. A 401 anywhere means the session ended -> the app shows the sign-in screen.
let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function req(method, url, body, { isForm = false, quiet401 = false } = {}) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body && !isForm ? { 'content-type': 'application/json' } : {},
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (res.status === 401 && !quiet401) onUnauthorized();
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
  return data;
}

const e = encodeURIComponent;

export const api = {
  // auth
  authStatus: () => req('GET', '/api/auth/status'),
  setup: (body) => req('POST', '/api/auth/setup', body, { quiet401: true }),
  login: (body) => req('POST', '/api/auth/login', body, { quiet401: true }),
  register: (body) => req('POST', '/api/auth/register', body, { quiet401: true }),
  logout: () => req('POST', '/api/auth/logout', {}, { quiet401: true }),
  me: () => req('GET', '/api/me'),
  updateMe: (patch) => req('PATCH', '/api/me', patch),
  changePassword: (currentPassword, newPassword) => req('POST', '/api/me/password', { currentPassword, newPassword }),
  getToken: () => req('GET', '/api/me/token'),
  generateToken: () => req('POST', '/api/me/token', {}),
  deleteToken: () => req('DELETE', '/api/me/token'),
  // admin
  adminUsers: () => req('GET', '/api/admin/users'),
  adminCreateUser: (body) => req('POST', '/api/admin/users', body),
  adminUpdateUser: (id, patch) => req('PATCH', `/api/admin/users/${e(id)}`, patch),
  adminDeleteUser: (id) => req('DELETE', `/api/admin/users/${e(id)}`),
  adminSettings: () => req('GET', '/api/admin/settings'),
  adminUpdateSettings: (patch) => req('PATCH', '/api/admin/settings', patch),
  // projects
  status: () => req('GET', '/api/status'),
  listProjects: () => req('GET', '/api/projects'),
  getProject: (id) => req('GET', `/api/projects/${e(id)}`),
  createProject: (body) => req('POST', '/api/projects', body),
  deleteProject: (id) => req('DELETE', `/api/projects/${e(id)}`),
  duplicateProject: (id, name) => req('POST', `/api/projects/${e(id)}/duplicate`, { name }),
  listVersions: (id) => req('GET', `/api/projects/${e(id)}/versions`),
  saveVersion: (id, name) => req('POST', `/api/projects/${e(id)}/versions`, { name }),
  restoreVersion: (id, vid) => req('POST', `/api/projects/${e(id)}/versions/${e(vid)}/restore`, {}),
  deleteVersion: (id, vid) => req('DELETE', `/api/projects/${e(id)}/versions/${e(vid)}`),
  // samples
  listSamples: () => req('GET', '/api/samples'),
  /** Upload a File/Blob (`name` = file name for a Blob); opts.folderId files it, opts.title names it. */
  uploadSample: (file, { folderId = null, title, name = file.name } = {}) => {
    const fd = new FormData();
    if (folderId) fd.append('folderId', folderId);
    if (title) fd.append('name', title);
    fd.append('file', file, name);
    return req('POST', '/api/samples', fd, { isForm: true });
  },
  /** New audio for an existing sample (same id: every project using it hears the change). */
  replaceSampleFile: (id, blob, name = 'edit.wav') => {
    const fd = new FormData();
    fd.append('file', blob, name);
    return req('PUT', `/api/samples/${e(id)}/file`, fd, { isForm: true });
  },
  updateSample: (id, patch) => req('PATCH', `/api/samples/${e(id)}`, patch),
  deleteSample: (id) => req('DELETE', `/api/samples/${e(id)}`),
  deleteSamples: (ids) => req('POST', '/api/samples/delete', { ids }),
  moveSamples: (ids, folderId) => req('POST', '/api/samples/move', { ids, folderId }),
  sampleUsage: (ids) => req('POST', '/api/samples/usage', { ids }),
  listSampleFolders: () => req('GET', '/api/samples/folders'),
  createSampleFolder: (name) => req('POST', '/api/samples/folders', { name }),
  renameSampleFolder: (id, name) => req('PATCH', `/api/samples/folders/${e(id)}`, { name }),
  deleteSampleFolder: (id) => req('DELETE', `/api/samples/folders/${e(id)}`),
  // exports & jobs
  listExports: () => req('GET', '/api/exports'),
  uploadExport: (form) => req('POST', '/api/exports', form, { isForm: true }),
  deleteExport: (name) => req('DELETE', `/api/exports/${e(name)}`),
  exportFormats: () => req('GET', '/api/exports/formats'),
  // plugins
  listPlugins: () => req('GET', '/api/plugins'),
  inspectPlugin: (form) => req('POST', '/api/plugins/inspect', form, { isForm: true }),
  installPlugin: (token) => req('POST', '/api/plugins/install', { token, trust: true }),
  setPluginEnabled: (id, enabled) => req('PATCH', `/api/plugins/${e(id)}`, { enabled }),
  removePlugin: (id) => req('DELETE', `/api/plugins/${e(id)}`),
  pluginCode: async (id) => {
    const res = await fetch(`/api/plugins/${e(id)}/code`, { credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(`Could not load the generator (${res.status})`, res.status);
    return res.text();
  },
  refreshFfmpeg: () => req('POST', '/api/system/ffmpeg/refresh', {}),
  convertExport: (name, body) => req('POST', `/api/exports/${e(name)}/convert`, body),
  jobResult: (jobId, form) => req('POST', `/api/jobs/${e(jobId)}/result`, form, { isForm: true }),
  jobFile: (jobId, form) => req('POST', `/api/jobs/${e(jobId)}/files`, form, { isForm: true }),
  templates: () => req('GET', '/api/templates')
};
