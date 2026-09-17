/**
 * Every call the task module makes, in one place.
 *
 * The pages talk to this rather than to `api` directly, for three reasons that
 * only show up once a module has twenty endpoints:
 *
 *   - a URL is written ONCE. A route renamed on the server is one edit here
 *     rather than a search across six pages;
 *   - the multipart calls (submit, comment, attachment, extension) all have to
 *     build a FormData in exactly the same way, and a page that builds it
 *     slightly differently is how an upload silently loses its remarks;
 *   - the detail page needs the same reload after fourteen different actions,
 *     so the actions return the fresh task and the page does not have to
 *     remember.
 */
import api from './client';

// ===== reading =====

/** The list, with every filter the server understands. */
export const listTasks = (params = {}) => api.get('/tasks', { params }).then((r) => r.data);

/** The same tasks, grouped into Kanban columns. */
export const taskBoard = (params = {}) => api.get('/tasks/board', { params }).then((r) => r.data);

/** One task with its trail, submissions, comments, time and workflow. */
export const getTask = (id) => api.get(`/tasks/${id}`).then((r) => r.data);

/** The catalogues and lists the forms need — statuses, workflows, templates. */
export const taskMeta = () => api.get('/tasks/meta').then((r) => r.data);

/** The signed-in person's own tasks. */
export const myTasks = (params = {}) => api.get('/tasks/me', { params }).then((r) => r.data);

/** The counts an employee's dashboard shows. */
export const mySummary = () => api.get('/tasks/me/summary').then((r) => r.data);

/** Everything waiting on this person to decide. */
export const myApprovals = () => api.get('/tasks/approvals').then((r) => r.data);

// NO taskCalendar HERE. Task deadlines appear on the portal's ONE calendar
// (pages/Calendar.jsx, fed by GET /celebrations/calendar), not on a second grid
// of their own — user decision, 2026-09-17.

/** Organisation-wide metrics. */
export const taskAnalytics = (params = {}) => api.get('/tasks/analytics', { params }).then((r) => r.data);

/** Per-employee load. */
export const workload = (params = {}) => api.get('/tasks/workload', { params }).then((r) => r.data);

export const taskActivity = (id, params = {}) => api.get(`/tasks/${id}/activity`, { params }).then((r) => r.data);
export const taskTimesheet = (id) => api.get(`/tasks/${id}/timesheet`).then((r) => r.data);
export const taskComments = (id) => api.get(`/tasks/${id}/comments`).then((r) => r.data);

// ===== writing =====

export const createTask = (body) => api.post('/tasks', body).then((r) => r.data);
export const updateTask = (id, body) => api.patch(`/tasks/${id}`, body).then((r) => r.data);
export const deleteTask = (id, hard = false) =>
  api.delete(`/tasks/${id}${hard ? '?hard=true' : ''}`).then((r) => r.data);
export const bulkTasks = (body) => api.post('/tasks/bulk', body).then((r) => r.data);

// ===== the lifecycle =====

export const changeStatus = (id, status, note) =>
  api.post(`/tasks/${id}/status`, { status, note }).then((r) => r.data);
export const acceptTask = (id, body = {}) => api.post(`/tasks/${id}/accept`, body).then((r) => r.data);
export const declineTask = (id, reason) => api.post(`/tasks/${id}/decline`, { reason }).then((r) => r.data);
export const startTask = (id, body = {}) => api.post(`/tasks/${id}/start`, body).then((r) => r.data);
export const beginReview = (id) => api.post(`/tasks/${id}/review`).then((r) => r.data);
export const approveTask = (id, body = {}) => api.post(`/tasks/${id}/approve`, body).then((r) => r.data);
export const rejectTask = (id, note) => api.post(`/tasks/${id}/reject`, { note }).then((r) => r.data);
export const decideStep = (id, stepKey, decision, note) =>
  api.post(`/tasks/${id}/steps/${stepKey}/decide`, { decision, note }).then((r) => r.data);

/**
 * Hand a task back, with whatever it was required to carry.
 *
 * Multipart, because evidence is files. The non-file fields go in as plain
 * form entries and the two that are structures — `urls` and `fieldValues` —
 * are JSON-encoded, which is what the server parses them back from. Doing that
 * here rather than in the page is the point of this module: a page that forgot
 * to stringify would send "[object Object]" and the server would read no URLs
 * at all, with no error anywhere.
 *
 * @param {string} id
 * @param {{remarks?:string, files?:File[], urls?:string[], fieldValues?:object,
 *          location?:{lat:number,lng:number,accuracy?:number}, signatureName?:string}} payload
 */
export function submitTask(id, payload = {}) {
  const fd = new FormData();
  if (payload.remarks) fd.append('remarks', payload.remarks);
  if (payload.signatureName) fd.append('signatureName', payload.signatureName);
  if (payload.urls && payload.urls.length) fd.append('urls', JSON.stringify(payload.urls));
  if (payload.fieldValues) fd.append('fieldValues', JSON.stringify(payload.fieldValues));
  appendLocation(fd, payload.location);
  for (const f of payload.files || []) fd.append('files', f);
  return api.post(`/tasks/${id}/submit`, fd).then((r) => r.data);
}

/** Where the person is, flattened the way every task route reads it. */
function appendLocation(fd, loc) {
  if (!loc || loc.lat == null) return;
  fd.append('lat', String(loc.lat));
  fd.append('lng', String(loc.lng));
  if (loc.accuracy != null) fd.append('accuracy', String(loc.accuracy));
  if (loc.address) fd.append('address', loc.address);
}

// ===== working on it =====

export const setChecklistItem = (id, itemId, done) =>
  api.patch(`/tasks/${id}/checklist/${itemId}`, { done }).then((r) => r.data);
export const setProgress = (id, progress) =>
  api.patch(`/tasks/${id}/progress`, { progress }).then((r) => r.data);

export const addAssignee = (id, assignees) =>
  api.post(`/tasks/${id}/assignees`, { assignees }).then((r) => r.data);
export const removeAssignee = (id, userId) =>
  api.delete(`/tasks/${id}/assignees/${userId}`).then((r) => r.data);
export const handover = (id, body) => api.post(`/tasks/${id}/handover`, body).then((r) => r.data);

// ===== time =====

export const myTimer = () => api.get('/tasks/me/timer').then((r) => r.data);
export const myTimesheet = (params = {}) => api.get('/tasks/me/timesheet', { params }).then((r) => r.data);
export const startTimer = (id, note) => api.post(`/tasks/${id}/timer/start`, { note }).then((r) => r.data);
export const timerAction = (id, action, body = {}) =>
  api.post(`/tasks/${id}/timer/${action}`, body).then((r) => r.data);
export const addManualTime = (id, body) => api.post(`/tasks/${id}/time-entry`, body).then((r) => r.data);
export const decideTimeEntry = (entryId, decision, note) =>
  api.patch(`/tasks/time-entries/${entryId}`, { decision, note }).then((r) => r.data);

// ===== talking about it =====

/**
 * Add a remark, with optional files.
 * @param {string} id
 * @param {{body:string, context?:string, internal?:boolean, files?:File[], mentions?:string[]}} payload
 */
export function addComment(id, payload = {}) {
  const fd = new FormData();
  fd.append('body', payload.body || '');
  if (payload.context) fd.append('context', payload.context);
  if (payload.internal) fd.append('internal', 'true');
  if (payload.mentions && payload.mentions.length) fd.append('mentions', JSON.stringify(payload.mentions));
  for (const f of payload.files || []) fd.append('files', f);
  return api.post(`/tasks/${id}/comments`, fd).then((r) => r.data);
}

// ===== deadlines =====

export function requestExtension(id, payload = {}) {
  const fd = new FormData();
  fd.append('requestedDueDate', payload.requestedDueDate);
  fd.append('reason', payload.reason || '');
  for (const f of payload.files || []) fd.append('files', f);
  return api.post(`/tasks/${id}/extensions`, fd).then((r) => r.data);
}

export const decideExtension = (extensionId, body) =>
  api.patch(`/tasks/extensions/${extensionId}`, body).then((r) => r.data);

// ===== files =====

export function addAttachments(id, files) {
  const fd = new FormData();
  for (const f of files || []) fd.append('files', f);
  return api.post(`/tasks/${id}/attachments`, fd).then((r) => r.data);
}

/** The URL a file is served from — for an <img>, or an AuthImage. */
export const fileUrl = (taskId, fileId, download = false) =>
  `/tasks/${taskId}/files/${fileId}${download ? '?download=true' : ''}`;

// ===== incentives =====

export const listIncentives = (params = {}) => api.get('/tasks/incentives', { params }).then((r) => r.data);
export const decideIncentive = (awardId, body) =>
  api.patch(`/tasks/incentives/${awardId}`, body).then((r) => r.data);

// ===== configuration =====

export const listWorkflows = (params = {}) => api.get('/task-workflows', { params }).then((r) => r.data);
export const getWorkflow = (id) => api.get(`/task-workflows/${id}`).then((r) => r.data);
export const createWorkflow = (body) => api.post('/task-workflows', body).then((r) => r.data);
export const updateWorkflow = (id, body) => api.patch(`/task-workflows/${id}`, body).then((r) => r.data);
export const publishWorkflow = (id, note) =>
  api.post(`/task-workflows/${id}/publish`, { note }).then((r) => r.data);
export const simulateWorkflow = (id, body) =>
  api.post(`/task-workflows/${id}/simulate`, body).then((r) => r.data);
export const deleteWorkflow = (id) => api.delete(`/task-workflows/${id}`).then((r) => r.data);

export const listTemplates = (params = {}) => api.get('/task-workflows/templates', { params }).then((r) => r.data);
export const getTemplate = (id) => api.get(`/task-workflows/templates/${id}`).then((r) => r.data);
export const createTemplate = (body) => api.post('/task-workflows/templates', body).then((r) => r.data);
export const updateTemplate = (id, body) => api.patch(`/task-workflows/templates/${id}`, body).then((r) => r.data);
export const deleteTemplate = (id) => api.delete(`/task-workflows/templates/${id}`).then((r) => r.data);
export const previewTemplate = (id, body) =>
  api.post(`/task-workflows/templates/${id}/preview`, body).then((r) => r.data);

export const listRecurring = (params = {}) => api.get('/task-workflows/recurring', { params }).then((r) => r.data);
export const createRecurring = (body) => api.post('/task-workflows/recurring', body).then((r) => r.data);
export const updateRecurring = (id, body) => api.patch(`/task-workflows/recurring/${id}`, body).then((r) => r.data);
export const deleteRecurring = (id) => api.delete(`/task-workflows/recurring/${id}`).then((r) => r.data);
export const runRecurringNow = (id) => api.post(`/task-workflows/recurring/${id}/run`).then((r) => r.data);

/**
 * Ask the browser where we are, for a task that captures location.
 *
 * Resolves to null rather than rejecting when the person says no or the device
 * cannot tell: a task that merely CAPTURES location should still be submittable
 * without it, and the server is the one that refuses when it is genuinely
 * required. Refusing here would make a permission prompt into a dead end.
 *
 * @param {number} [timeoutMs]
 * @returns {Promise<{lat:number,lng:number,accuracy:number}|null>}
 */
export function currentPosition(timeoutMs = 10000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: Math.round(pos.coords.accuracy || 0),
      }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 }
    );
  });
}
