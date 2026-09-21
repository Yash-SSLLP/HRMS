/**
 * Every call the task module makes, in one place.
 *
 * REWRITTEN 2026-09-21 alongside the module. Twenty-eight functions became
 * twelve, because there are twelve things a task can have done to it.
 *
 * THE MULTIPART BUILDER IS THE POINT OF THIS FILE. Four calls can carry a voice
 * note and files — assign, edit, move, remark — and each of them has to build
 * the same FormData in the same way: JSON-encode the arrays, put the recording
 * under `voice`, put everything else under `files`. A page that builds it
 * slightly differently is how an upload silently loses its remarks, which is
 * exactly what happened in the module this replaces. `toFormData` below is the
 * single place that knows.
 */
import api from './client';

/**
 * The one way a task-shaped body becomes a request.
 *
 * Sends plain JSON when there is nothing to upload — a JSON body is smaller,
 * and the server parses it without the string-decoding dance multipart forces.
 * The moment there IS a recording or a file, everything goes multipart and the
 * arrays and objects are JSON-encoded, which is what taskController.parseBody
 * expects on the other side.
 */
function toFormData(body = {}, { voice, files } = {}) {
  const hasUpload = Boolean(voice) || Boolean(files?.length);
  if (!hasUpload) return { data: body, config: undefined };

  const fd = new FormData();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    if (value instanceof Date) fd.append(key, value.toISOString());
    else if (typeof value === 'object') fd.append(key, JSON.stringify(value));
    else fd.append(key, String(value));
  }
  // The recording goes under its own field name so the server can tell it from
  // an .mp3 somebody happened to attach — see models/Task's voiceNote.
  if (voice) {
    fd.append('voice', voice.blob, voice.name || 'voice-note.webm');
    if (voice.durationMs) fd.set('voiceDurationMs', String(Math.round(voice.durationMs)));
  }
  for (const f of files || []) fd.append('files', f, f.name);

  // No explicit Content-Type: the browser has to set the multipart boundary
  // itself, and naming the header without it produces a body the server cannot
  // parse. Axios does the right thing when handed a FormData and left alone.
  return { data: fd, config: undefined };
}

// ===== Reading =====

/** The list, its counters, and the paging — one call. */
export const listTasks = (params = {}) => api.get('/tasks', { params }).then((r) => r.data);

/** The counters alone, for a badge. */
export const taskCounters = (params = {}) => api.get('/tasks/counters', { params }).then((r) => r.data);

/** One task, its whole feed, and what the caller may do to it. */
export const getTask = (id) => api.get(`/tasks/${id}`).then((r) => r.data);

/** More of the feed, for paging it. */
export const taskFeed = (id, params = {}) => api.get(`/tasks/${id}/updates`, { params }).then((r) => r.data);

/** People, categories, defaults — everything the assign form needs, in one call. */
export const taskMeta = () => api.get('/tasks/meta').then((r) => r.data);

/** The dashboard: view = employee | category | trend | mine | delegated. */
export const dashboard = (params = {}) => api.get('/tasks/dashboard', { params }).then((r) => r.data);
export const overdueReport = (params = {}) => api.get('/tasks/dashboard/overdue', { params }).then((r) => r.data);

// ===== Writing =====

/** Hand work over. The server decides whether it is a task or a request. */
export const createTask = (body, upload) => {
  const { data } = toFormData(body, upload);
  return api.post('/tasks', data).then((r) => r.data);
};

export const updateTask = (id, body, upload) => {
  const { data } = toFormData(body, upload);
  return api.patch(`/tasks/${id}`, data).then((r) => r.data);
};

/**
 * Move it. `to` is the target status; `note` is what they said about it.
 * The ONE endpoint that moves anything — see routes/taskRoutes.
 */
export const changeStatus = (id, to, { note, mentions, voice, files } = {}) => {
  const { data } = toFormData({ to, note, mentions }, { voice, files });
  return api.post(`/tasks/${id}/status`, data).then((r) => r.data);
};

/** A remark, with or without a recording. */
export const addUpdate = (id, { note, mentions, voice, files } = {}) => {
  const { data } = toFormData({ note, mentions }, { voice, files });
  return api.post(`/tasks/${id}/updates`, data).then((r) => r.data);
};

/**
 * Remove it.
 *
 * Archiving by default — the row keeps its feed, its files and any points it
 * credited and simply stops appearing. `purge` really deletes it: SuperAdmin
 * only, and the server refuses it once points have been credited.
 */
export const deleteTask = (id, { purge } = {}) =>
  api.delete(`/tasks/${id}`, { params: purge ? { purge: 1 } : {} }).then((r) => r.data);

// ===== The doer's three answers =====

/** Take it on. An acknowledgement — the task stays Pending until somebody starts. */
export const acceptTask = (id, note) =>
  api.post(`/tasks/${id}/accept`, { note }).then((r) => r.data);

/** Refuse it. The reason is REQUIRED — see services/taskEngine.decline. */
export const declineTask = (id, reason) =>
  api.post(`/tasks/${id}/decline`, { reason }).then((r) => r.data);

/**
 * Pass your own piece to somebody else.
 *
 * Not the same as reassigning (`updateTask`): this is the DOER handing their
 * job on, the direction rule still applies, and they keep being notified about
 * it afterwards.
 */
export const delegateTask = (id, to, note) =>
  api.post(`/tasks/${id}/delegate`, { to, note }).then((r) => r.data);

// ===== Subtasks =====

/** `items` is `[{ title, assignee? }]`. No assignee = anybody on the task. */
export const addSubtasks = (id, items) =>
  api.post(`/tasks/${id}/subtasks`, { items }).then((r) => r.data);

export const setSubtask = (id, subId, done) =>
  api.patch(`/tasks/${id}/subtasks/${subId}`, { done }).then((r) => r.data);

export const removeSubtask = (id, subId) =>
  api.delete(`/tasks/${id}/subtasks/${subId}`).then((r) => r.data);

// ===== Categories =====

/** `{ withCounts: 1 }` adds each category's task count, for the manage list. */
export const listCategories = (params = {}) =>
  api.get('/tasks/categories', { params }).then((r) => r.data);

export const createCategory = (name) => api.post('/tasks/categories', { name }).then((r) => r.data);

/** SuperAdmin only. The tasks filed under it are renamed with it. */
export const renameCategory = (id, name) =>
  api.patch(`/tasks/categories/${id}`, { name }).then((r) => r.data);

/**
 * SuperAdmin only.
 *
 * `moveTo` refiles the tasks into another category first — the honest way to
 * merge two that should have been one. `force` removes the row even though
 * tasks still carry its name; without it the server HIDES a category in use
 * rather than deleting it, and says which it did in `message`.
 */
export const deleteCategory = (id, { moveTo, force } = {}) => {
  const params = {};
  if (moveTo) params.moveTo = moveTo;
  if (force) params.force = 1;
  return api.delete(`/tasks/categories/${id}`, { params }).then((r) => r.data);
};

// ===== Templates & the directory =====

export const listTemplates = () => api.get('/tasks/templates').then((r) => r.data);
export const createTemplate = (body) => api.post('/tasks/templates', body).then((r) => r.data);
export const copyTemplate = (id) => api.post(`/tasks/templates/${id}/copy`).then((r) => r.data);
export const templatePrefill = (id) => api.get(`/tasks/templates/${id}/prefill`).then((r) => r.data);
export const updateTemplate = (id, body) => api.patch(`/tasks/templates/${id}`, body).then((r) => r.data);
export const deleteTemplate = (id) => api.delete(`/tasks/templates/${id}`).then((r) => r.data);

// ===== Repeating schedules =====

export const listRecurring = () => api.get('/tasks/recurring').then((r) => r.data);
export const updateRecurring = (id, body) => api.patch(`/tasks/recurring/${id}`, body).then((r) => r.data);
export const deleteRecurring = (id) => api.delete(`/tasks/recurring/${id}`).then((r) => r.data);
export const runRecurringNow = (id) => api.post(`/tasks/recurring/${id}/run`).then((r) => r.data);

// ===== Files =====

/**
 * Where an attachment or a recording is served from.
 *
 * A URL rather than a fetch, because an <audio> and an <img> want a src. It
 * goes through the api instance's base so it carries the same origin, and the
 * auth token rides on the request the way every other media URL in this portal
 * does (see components/AuthImage).
 */
export const fileUrl = (taskId, fileId) => `/tasks/${taskId}/files/${fileId}`;
export const taskVoiceUrl = (taskId) => `/tasks/${taskId}/files/voice`;
export const updateVoiceUrl = (taskId, updateId) => `/tasks/${taskId}/updates/${updateId}/voice`;

/** Fetch a protected media file as an object URL the browser can play. */
export async function blobUrl(path) {
  const res = await api.get(path, { responseType: 'blob' });
  return URL.createObjectURL(res.data);
}
