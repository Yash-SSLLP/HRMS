/**
 * The bills on a cashbook entry, as the API describes them (2026-09-28: an
 * entry may carry several). Mirrors backend/utils/bills.publicBills.
 *
 * A server from before the change sends only `hasAttachment` / `attachmentName`
 * / `attachmentMime` — that reads as a list of one, so every page works against
 * either.
 */

/** Every bill on the entry: `[{ i, name, mime }]`, `[]` when there is none. */
export function billList(entry) {
  if (entry?.attachments?.length) return entry.attachments;
  return entry?.hasAttachment
    ? [{ i: 0, name: entry.attachmentName || 'Bill', mime: entry.attachmentMime || '' }]
    : [];
}

/** The API path of bill `i` on an employee-ledger (khata) entry. */
export const khataBillPath = (id, i = 0) => `/khata/entries/${id}/receipt?i=${i}`;

/** The API path of receipt `i` on a company cashbook entry. */
export const cashbookBillPath = (id, i = 0) => `/cashbook/entries/${id}/receipt?i=${i}`;
