/**
 * services/translate.js with a stubbed Claude client and stubbed collections —
 * no network, no database, no API key needed. `npm run test:translate`.
 */
const assert = require('assert');
const TextTranslation = require('../models/TextTranslation');
const TranslationUsage = require('../models/TranslationUsage');
const T = require('../services/translate');

const stored = new Map();
TextTranslation.find = (q) => ({
  select: () => ({ lean: async () => q.key.$in.filter((k) => stored.has(k)).map((k) => ({ key: k, text: stored.get(k) })) }),
});
TextTranslation.bulkWrite = async (ops) => { ops.forEach((o) => stored.set(o.updateOne.filter.key, o.updateOne.update.$set.text)); };
const usage = [];
TranslationUsage.updateOne = (q, u) => { usage.push(u.$inc); return Promise.resolve(); };
T.setEnabled(true);

// One letter of each script, so a stub answer passes the script check.
const MARK = { Hindi: 'क', Tamil: 'க', Kannada: 'ಕ', Telugu: 'క', Malayalam: 'ക' };
const langOfPrompt = (system) => Object.keys(MARK).find((n) => system.includes(n));
const expect = (tag, lang, s) => `${tag}${MARK[lang]}:${s}`;

const calls = [];
let mode = 'ok';
T._setClient({
  messages: {
    create: async (req) => {
      calls.push(req);
      assert.strictEqual(req.model, 'claude-haiku-4-5');
      assert.strictEqual(req.output_config.format.type, 'json_schema');
      const items = JSON.parse(req.messages[0].content.slice(req.messages[0].content.lastIndexOf('{"items"'))).items;
      const reply = (list) => ({
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [{ type: 'text', text: JSON.stringify({ items: list }) }],
      });
      if (mode === 'short') return reply(items.slice(1));
      if (mode === 'refusal') return { stop_reason: 'refusal', content: [], usage: {} };
      if (mode === 'slow') await new Promise((r) => { setTimeout(r, 300); });
      const lang = langOfPrompt(req.system);
      // Wrong script on the first try, right on the retry.
      if (mode === 'mixedOnce') {
        if (!req.system.includes('IMPORTANT')) return reply(items.map((s) => `साइट ${s}`));
        return reply(items.map((s) => expect('R', lang, s)));
      }
      // Wrong script every time.
      if (mode === 'mixedAlways') return reply(items.map((s) => `साइट ${s}`));
      const tag = req.system.startsWith("You write people's names") ? 'N' : 'T';
      return reply(items.map((s) => expect(tag, lang, s)));
    },
  },
});
const req = (lang) => ({ get: (h) => (h === 'x-app-lang' ? lang : undefined) });

(async () => {
  // 1. English reader: nothing touched, no call.
  const en = { title: 'Check stock', createdByName: 'Piyush Lunia' };
  await T.localise(req(undefined), en);
  assert.deepStrictEqual(en, { title: 'Check stock', createdByName: 'Piyush Lunia' });
  assert.strictEqual(calls.length, 0);

  // 2. Hindi reader: titles translated, names transliterated, files/codes/links left alone.
  const task = {
    title: 'Check stock', description: 'Count the cement bags', code: 'TSK-2026-01721',
    createdByName: 'Piyush Lunia',
    assignees: [{ name: 'Yash Kumar Roy', user: { firstName: 'Yash' } }],
    attachments: [{ name: 'bill.jpg' }], links: [{ title: 'Drive folder' }],
    lastExtension: { status: 'PENDING', requestedByName: 'Yash Kumar Roy' },
  };
  const updates = [{ note: 'Please hurry', byName: 'Piyush Lunia' }, { note: '12345' }];
  await T.localise(req('hi'), task, updates);
  assert.strictEqual(task.title, expect('T', 'Hindi', 'Check stock'));
  assert.strictEqual(task.description, expect('T', 'Hindi', 'Count the cement bags'));
  assert.strictEqual(task.code, 'TSK-2026-01721');
  assert.strictEqual(task.createdByName, expect('N', 'Hindi', 'Piyush Lunia'));
  assert.strictEqual(task.assignees[0].name, expect('N', 'Hindi', 'Yash Kumar Roy'));
  assert.strictEqual(task.lastExtension.requestedByName, expect('N', 'Hindi', 'Yash Kumar Roy'));
  assert.strictEqual(task.attachments[0].name, 'bill.jpg');
  assert.strictEqual(task.links[0].title, 'Drive folder');
  assert.strictEqual(updates[0].note, expect('T', 'Hindi', 'Please hurry'));
  assert.strictEqual(updates[1].note, '12345', 'numbers are not sent');
  assert.strictEqual(calls.length, 2, 'one call per kind');
  assert.strictEqual(usage.length, 2, 'each call is counted');
  assert.deepStrictEqual(usage[0], { calls: 1, strings: usage[0].strings, inputTokens: 100, outputTokens: 50 });

  // 3. Same strings again: served from memory, no new call.
  const again = { title: 'Check stock', createdByName: 'Piyush Lunia' };
  await T.localise(req('hi'), again);
  assert.strictEqual(again.title, expect('T', 'Hindi', 'Check stock'));
  assert.strictEqual(calls.length, 2);

  // 4. From the collection after a restart (memory cleared).
  T._memory.clear();
  const fromDb = { title: 'Check stock' };
  await T.localise(req('hi'), fromDb);
  assert.strictEqual(fromDb.title, expect('T', 'Hindi', 'Check stock'));
  assert.strictEqual(calls.length, 2, 'the collection answered');

  // 5. A reply of the wrong length or a refusal: English stays, nothing stored.
  mode = 'short';
  const bad = { title: 'Wrong length one', description: 'and another' };
  await T.localise(req('ta'), bad);
  assert.deepStrictEqual(bad, { title: 'Wrong length one', description: 'and another' });
  mode = 'refusal';
  const ref = { title: 'Refused text' };
  await T.localise(req('ta'), ref);
  assert.strictEqual(ref.title, 'Refused text');

  // 6. The script check: Hindi letters in a Tamil answer are asked for again…
  mode = 'mixedOnce';
  let n = calls.length;
  const mixed = { title: 'Send the photo' };
  await T.localise(req('ta'), mixed);
  assert.strictEqual(mixed.title, expect('R', 'Tamil', 'Send the photo'), 'the retry answer is used');
  assert.strictEqual(calls.length - n, 2, 'one retry');
  // …and when the retry is wrong too, the English is kept and remembered (no third call ever).
  mode = 'mixedAlways';
  n = calls.length;
  const stubborn = { title: 'Count the bags' };
  await T.localise(req('ta'), stubborn);
  assert.strictEqual(stubborn.title, 'Count the bags');
  assert.strictEqual(calls.length - n, 2);
  const stubbornAgain = { title: 'Count the bags' };
  await T.localise(req('ta'), stubbornAgain);
  assert.strictEqual(calls.length - n, 2, 'not paid for again');

  // 7. scriptOk itself — the three faults the first live Tamil run produced.
  assert.ok(T.scriptOk('சரிபார்', 'ta'));
  assert.ok(!T.scriptOk('साइट B ல்', 'ta'), 'Devanagari inside Tamil');
  assert.ok(!T.scriptOk('சாண্ডबॉக்ஸ்', 'ta'), 'Bengali inside Tamil');
  assert.ok(!T.scriptOk('஫ோட்டோ', 'ta'), 'an unassigned code point');
  assert.ok(!T.scriptOk('Check', 'ta'), 'left in English');
  assert.ok(!T.scriptOk('௫ ரூ', 'ta'), "the script's own digits");
  assert.ok(T.scriptOk('TSK-2026-01721 के लिए ₹6,000।', 'hi'), 'codes, amounts and the danda are fine');

  // 8. Slow API: the read answers in English after the wait, and the next read has it.
  mode = 'slow';
  const map1 = await T.translateStrings(['Slow title'], 'kn', 'text', { waitMs: 50 });
  assert.strictEqual(map1.size, 0, 'answered without waiting for it');
  await new Promise((r) => { setTimeout(r, 400); });
  const map2 = await T.translateStrings(['Slow title'], 'kn', 'text', { waitMs: 50 });
  assert.strictEqual(map2.get('Slow title'), expect('T', 'Kannada', 'Slow title'), 'finished in the background');

  // 9. Unknown language header: ignored.
  const xx = { title: 'Check stock' };
  await T.localise(req('fr'), xx);
  assert.strictEqual(xx.title, 'Check stock');

  // 10. Many strings are chunked (40 per call).
  mode = 'ok';
  n = calls.length;
  await T.translateStrings(Array.from({ length: 95 }, (_, i) => `Task number ${i} title`), 'ml', 'text');
  assert.strictEqual(calls.length - n, 3);

  // 11. The Super Admin switch: off = English and no call, even for new text.
  T.setEnabled(false);
  n = calls.length;
  const off = { title: 'A brand new title', createdByName: 'Someone New' };
  await T.localise(req('te'), off);
  assert.deepStrictEqual(off, { title: 'A brand new title', createdByName: 'Someone New' });
  assert.strictEqual((await T.translateStrings(['Push title'], 'te')).size, 0, 'pushes too');
  assert.strictEqual(calls.length, n, 'no call while off');
  T.setEnabled(true);

  console.log('translate: all checks passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
