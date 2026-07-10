// Rasterizes the chosen badge (logo-C-bright.svg) into all app-icon / splash /
// brand-logo PNGs, using the bundled Jost font. Outputs to render-out/ for review.
const { Resvg } = require('@resvg/resvg-js');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const outDir = path.join(dir, 'render-out');
fs.mkdirSync(outDir, { recursive: true });

const badge = fs.readFileSync(path.join(dir, 'logo-C-bright.svg'), 'utf8');
const FONT = path.join(dir, 'Jost.ttf');
const INK = '#0c0c0e'; // app icon / adaptive background

// Embed the 360x360 badge as a nested <svg> inset into a 100x100 wrapper.
function wrap({ pad, ink }) {
  const inner = badge.replace('<svg ', `<svg x="${pad}" y="${pad}" width="${100 - 2 * pad}" height="${100 - 2 * pad}" `);
  const bg = ink ? `<rect width="100" height="100" fill="${INK}"/>` : '';
  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${bg}${inner}</svg>`;
}

function render(svg, px, file) {
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: px },
    font: { fontFiles: [FONT], loadSystemFonts: false, defaultFontFamily: 'Jost' },
  });
  fs.writeFileSync(path.join(outDir, file), r.render().asPng());
}

// Compositions
const FULL = wrap({ pad: 5, ink: true });   // full-bleed badge on black (legacy icon)
const FG = wrap({ pad: 20, ink: false });   // 60% badge, transparent (within adaptive safe zone)
const SPLASH = wrap({ pad: 24, ink: false }); // 52% badge, transparent (splash, centered on #0c0c0e)
const LOGO = wrap({ pad: 3, ink: false });  // near-full badge, transparent (brand logo)

// Source assets (1024)
render(FULL, 1024, 'icon.png');
render(FG, 1024, 'adaptive-icon.png');
render(SPLASH, 1024, 'splash.png');
render(LOGO, 512, 'logo.png');

// Android launcher mipmaps
const LEGACY = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const FGSZ = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
for (const [d, px] of Object.entries(LEGACY)) render(FULL, px, `ic_launcher-${d}.png`);
for (const [d, px] of Object.entries(FGSZ)) render(FG, px, `ic_fg-${d}.png`);

// Android splash (same 1024 in every density bucket)
render(SPLASH, 1024, 'splashscreen_image.png');

console.log('rendered icons/splash/logo to', outDir);
