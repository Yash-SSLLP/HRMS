/**
 * Bundle the Markdown guides into the web and mobile apps.
 *
 * The in-app Help screen reads its content from `src/content/guides.js` in each
 * app rather than from the Markdown files, because neither bundler can import a
 * .md file and the mobile app has to work offline. This script is what keeps
 * those two generated copies in step with `docs/` — run it after editing either
 * guide, or the apps will keep serving the previous text:
 *
 *   node scripts/build-guides.js
 *
 * HR can also override a guide from inside the app (saved server-side); the
 * bundled copy here is the default that ships and the fallback when no override
 * exists or the backend is unreachable.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const SOURCES = {
  employeeGuide: path.join(ROOT, 'docs', 'HRMS-Employee-Guide.md'),
  hrGuide: path.join(ROOT, 'docs', 'HRMS-HR-Admin-Guide.md'),
};

const TARGETS = [
  path.join(ROOT, 'frontend', 'src', 'content', 'guides.js'),
  path.join(ROOT, 'mobile', 'src', 'content', 'guides.js'),
];

const HEADER = [
  '// AUTO-GENERATED from docs/HRMS-*-Guide.md — do not edit by hand.',
  '// Regenerate with `node scripts/build-guides.js` after editing either guide.',
  '',
].join('\n');

// JSON.stringify does the escaping (quotes, backslashes, newlines) correctly for
// a JS string literal. The one thing it leaves alone is `</script`, which would
// close the tag early if the bundle were ever inlined into an HTML page.
const literal = (s) => JSON.stringify(s).replace(/<\/script/gi, '<\\/script');

const body = Object.entries(SOURCES)
  .map(([name, file]) => {
    const md = fs.readFileSync(file, 'utf8');
    const emoji = md.match(/\p{Extended_Pictographic}/gu);
    if (emoji) {
      // The guides use `[!NOTE]`-style tags so the apps can draw real icons; a
      // stray emoji means someone edited the Markdown without that convention.
      console.warn(`  ! ${path.basename(file)} contains ${emoji.length} emoji: ${[...new Set(emoji)].join(' ')}`);
    }
    console.log(`  ${path.basename(file)} → ${name} (${md.length.toLocaleString()} chars)`);
    return `export const ${name} = ${literal(md)};`;
  })
  .join('\n\n');

const out = `${HEADER}${body}\n`;

for (const target of TARGETS) {
  fs.writeFileSync(target, out);
  console.log(`  wrote ${path.relative(ROOT, target)}`);
}

console.log('Guides bundled.');
