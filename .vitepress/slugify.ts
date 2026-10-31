/**
 * Heading ids: VitePress's own slug (from @mdit-vue/shared, copied below so it
 * cannot change under us), with two differences that keep the ids readable
 * and match how this site's links were already written:
 *
 *   - an apostrophe is dropped, not turned into a separator:
 *     "What's not here yet" is #whats-not-here-yet, not #what-s-not-here-yet;
 *   - a dash or an arrow outside ASCII separates words like a space does:
 *     "Batch — `POST /rpc/batch`" is #batch-post-rpc-batch, not
 *     #batch-—-post-rpc-batch, and "Constraint errors → `VALIDATION_ERROR`"
 *     is #constraint-errors-validation-error.
 *
 * Anything else is VitePress's rule: ASCII punctuation separates words, and an
 * id that starts with a digit gets a leading `_`. scripts/check-anchors.mjs
 * checks every internal #anchor against the ids this produces.
 */
const rControl = /[\u0000-\u001f]/g;
const rSpecial = /[\s~`!@#$%^&*()\-_+=[\]{}|\;:"'“”‘’<>,.?/]+/g;
const rCombining = /[̀-ͯ]/g;
const rApostrophe = /['‘’]/g;
const rDashOrArrow = /[‐-―←-⇿]/g;

export function slugify(heading: string): string {
  return heading
    .normalize("NFKD")
    .replace(rCombining, "")
    .replace(rControl, "")
    .replace(rApostrophe, "")
    .replace(rDashOrArrow, " ")
    .replace(rSpecial, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^(\d)/, "_$1")
    .toLowerCase();
}
