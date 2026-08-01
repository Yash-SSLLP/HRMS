/**
 * Gate for the chat module.
 *
 * Chat is an org-wide switch a SuperAdmin controls (Setting.chatEnabled, off by
 * default). The clients hide their entry points when it is off, but the API has
 * to refuse too — a saved URL or an old mobile deep link would otherwise still
 * reach it.
 *
 * Note this only guards chat proper. `/chat/directory` is mounted ahead of it
 * because the Complaints people-picker depends on it, and the SuperAdmin
 * transcript export must keep working on archived conversations.
 */
const Setting = require('../models/Setting');

/**
 * Whether the chat module is currently switched on.
 * @returns {Promise<boolean>} false if the setting can't be read
 */
async function isChatEnabled() {
  try {
    const s = await Setting.getSettings();
    return !!s.chatEnabled;
  } catch (_) {
    return false;
  }
}

/** Express middleware: 403 unless chat is switched on. */
async function requireChatEnabled(req, res, next) {
  if (await isChatEnabled()) return next();
  res.status(403);
  return next(new Error('Chat is currently switched off for this organisation'));
}

module.exports = { isChatEnabled, requireChatEnabled };
