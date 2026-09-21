/**
 * What a document category is CALLED on screen.
 *
 * Every page that shows a document used to carry its own
 * `humanize = c => c.replace(/([a-z])([A-Z])/g, '$1 $2')`, which is fine right
 * up to the first category whose real name is not its enum key split at the
 * capitals. "PassportPhoto" is asked for as a **Passport Size Photo**, and
 * "ExperienceLetter" covers the relieving letter too — six copies of a regex
 * cannot know either, and they drifted apart the moment one of them was told.
 *
 * MIRRORS backend/models/Document.js CATEGORY_LABELS / categoryLabel(). The
 * server sends the same map on GET /documents/categories (and on the public
 * submission link) as `labels`, so a page that has fetched it should prefer
 * what the server said — `docLabel(c, labels)` does exactly that, and falls
 * back to this copy for the screens that never load it.
 */

/** Keys whose on-screen name is not the camelCase split. Short by design. */
export const CATEGORY_LABELS = {
  PassportPhoto: 'Passport Size Photo',
  ExperienceLetter: 'Experience / Relieving Letter',
  PAN: 'PAN',
  NDA: 'NDA',
};

/**
 * The on-screen name of a category.
 * @param {string} c - enum key, e.g. 'PassportPhoto'
 * @param {Object} [serverLabels] - the `labels` map from the API, when the page has it
 * @returns {string}
 */
export function docLabel(c, serverLabels) {
  const key = String(c || '');
  return (serverLabels && serverLabels[key])
    || CATEGORY_LABELS[key]
    || key.replace(/([a-z])([A-Z])/g, '$1 $2')
    || key;
}

export default docLabel;
