// Generates circular "seal" logo samples: a slim gold ring with curved BLACK
// text (HRMS / Sequence / Surface) around the EXISTING app-icon mark (embedded
// from mobile/assets/icon.png), clipped into the centre circle.
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const iconB64 = fs.readFileSync(path.join(dir, '..', 'icon.png')).toString('base64');
const DATA = `data:image/png;base64,${iconB64}`;

const CX = 180, CY = 180;
const OUTER = 172;          // outer edge of the ring
const BANDW = 42;           // ring thickness (slimmed down from 66)
const RINGR = OUTER - BANDW / 2;   // stroke radius = 151
const INNER = OUTER - BANDW;       // inner edge / core radius = 130
const HRMS_R = 136;         // one shared baseline radius → consistent sizing
const SIDE_R = 136;
const IMG = 360;            // embedded-icon size (fills the bigger core)
const TEXT_FILL = '#0A0A0A';

const rad = (d) => (d * Math.PI) / 180;
const pt = (R, a) => `${(CX + R * Math.cos(rad(a))).toFixed(2)} ${(CY + R * Math.sin(rad(a))).toFixed(2)}`;
const arc = (R, a1, a2) => `M${pt(R, a1)} A${R} ${R} 0 0 1 ${pt(R, a2)}`;

// Wider side arcs (108deg) so the larger SEQUENCE / SURFACE fit; top stays 64deg.
const ARCS = { top: arc(HRMS_R, 238, 302), right: arc(SIDE_R, 306, 54), left: arc(SIDE_R, 126, 234) };

function seps(color) {
  return [313, 90, 226].map((a) => {
    const x = CX + RINGR * Math.cos(rad(a)), y = CY + RINGR * Math.sin(rad(a));
    return `<rect x="${(x - 3).toFixed(2)}" y="${(y - 3).toFixed(2)}" width="6" height="6" transform="rotate(45 ${x.toFixed(2)} ${y.toFixed(2)})" fill="${color}"/>`;
  }).join('');
}

function core(id) {
  return `<clipPath id="core-${id}"><circle cx="${CX}" cy="${CY}" r="${INNER}"/></clipPath>
  <g clip-path="url(#core-${id})">
    <rect x="${CX - INNER}" y="${CY - INNER}" width="${INNER * 2}" height="${INNER * 2}" fill="#0A0A0A"/>
    <image x="${CX - IMG / 2}" y="${CY - IMG / 2}" width="${IMG}" height="${IMG}" preserveAspectRatio="xMidYMid meet" xlink:href="${DATA}" href="${DATA}"/>
  </g>`;
}

function ring(o) {
  let s = `<circle cx="${CX}" cy="${CY}" r="${RINGR}" fill="none" stroke="${o.ringGrad ? `url(#ring-${o.id})` : o.ringFill}" stroke-width="${BANDW}"/>`;
  if (o.hairline) s += `<circle cx="${CX}" cy="${CY}" r="${OUTER}" fill="none" stroke="${o.hairline}" stroke-width="1.5"/><circle cx="${CX}" cy="${CY}" r="${INNER}" fill="none" stroke="${o.hairline}" stroke-width="1.5"/>`;
  if (o.doubleRing) s += `<circle cx="${CX}" cy="${CY}" r="${OUTER - 1}" fill="none" stroke="#A9863A" stroke-width="2.5"/><circle cx="${CX}" cy="${CY}" r="${INNER + 1}" fill="none" stroke="#A9863A" stroke-width="2"/>`;
  return s;
}

const FONT = "'Jost', 'Century Gothic', 'Segoe UI', system-ui, sans-serif";
function words(id, fill) {
  return `<g fill="${fill}" font-family="${FONT}" font-weight="600">
    <text font-size="40" letter-spacing="3"><textPath xlink:href="#top-${id}" href="#top-${id}" startOffset="50%" text-anchor="middle">HRMS</textPath></text>
    <text font-size="40" letter-spacing="3"><textPath xlink:href="#right-${id}" href="#right-${id}" startOffset="50%" text-anchor="middle">SEQUENCE</textPath></text>
    <text font-size="40" letter-spacing="3"><textPath xlink:href="#left-${id}" href="#left-${id}" startOffset="50%" text-anchor="middle">SURFACE</textPath></text>
  </g>`;
}

function defs(o) {
  return `<defs>${o.ringGrad ? `<linearGradient id="ring-${o.id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#EAC96E"/><stop offset="0.5" stop-color="#D6AE48"/><stop offset="1" stop-color="#B98A30"/></linearGradient>` : ''}<path id="top-${o.id}" d="${ARCS.top}"/><path id="right-${o.id}" d="${ARCS.right}"/><path id="left-${o.id}" d="${ARCS.left}"/></defs>`;
}

function badge(o) {
  return `<svg viewBox="0 0 360 360" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  ${defs(o)}
  ${ring(o)}
  ${core(o.id)}
  ${o.separators ? seps(TEXT_FILL) : ''}
  ${words(o.id, TEXT_FILL)}
</svg>`;
}

const variants = {
  'A-brand': { id: 'a', ringFill: '#C7A24C' },
  'B-gradient': { id: 'b', ringGrad: true, hairline: 'rgba(0,0,0,0.20)' },
  'C-bright': { id: 'c', ringFill: '#FDC500' },
  'D-coin': { id: 'd', ringFill: '#C7A24C', doubleRing: true },
};

const cards = [];
for (const [name, o] of Object.entries(variants)) {
  fs.writeFileSync(path.join(dir, `logo-${name}.svg`), badge(o));
  cards.push({ name, o });
}

const sprite = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><symbol id="coreImg" viewBox="0 0 ${INNER * 2} ${INNER * 2}"><clipPath id="cc"><circle cx="${INNER}" cy="${INNER}" r="${INNER}"/></clipPath><g clip-path="url(#cc)"><rect width="${INNER * 2}" height="${INNER * 2}" fill="#0A0A0A"/><image x="${INNER - IMG / 2}" y="${INNER - IMG / 2}" width="${IMG}" height="${IMG}" preserveAspectRatio="xMidYMid meet" xlink:href="${DATA}" href="${DATA}"/></g></symbol></svg>`;

function badgePreview(o) {
  return `<svg style="width:100%;height:auto;display:block" viewBox="0 0 360 360" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  ${defs(o)}
  ${ring(o)}
  <use xlink:href="#coreImg" href="#coreImg" x="${CX - INNER}" y="${CY - INNER}" width="${INNER * 2}" height="${INNER * 2}"/>
  ${o.separators ? seps(TEXT_FILL) : ''}
  ${words(o.id, TEXT_FILL)}</svg>`;
}

const LABELS = { 'A-brand': 'A · Brand gold', 'B-gradient': 'B · Gradient', 'C-bright': 'C · Bright yellow', 'D-coin': 'D · Coin' };
const HINTS = { 'A-brand': "App's brand gold", 'B-gradient': 'Brushed metallic', 'C-bright': 'Reference yellow', 'D-coin': 'Bordered coin' };

const style = `<style>
@import url('https://fonts.googleapis.com/css2?family=Jost:wght@400;500;600&display=swap');
:root{--bg:#f7f5ef;--card:#ffffff;--ink:#2a2720;--muted:#8a8272;--line:rgba(40,36,26,.12);--gold:#b78d33}
@media (prefers-color-scheme:dark){:root{--bg:#14130e;--card:#1d1b15;--ink:#ece8dc;--muted:#9c937f;--line:rgba(255,255,255,.12);--gold:#d6b25a}}
:root[data-theme="light"]{--bg:#f7f5ef;--card:#ffffff;--ink:#2a2720;--muted:#8a8272;--line:rgba(40,36,26,.12);--gold:#b78d33}
:root[data-theme="dark"]{--bg:#14130e;--card:#1d1b15;--ink:#ece8dc;--muted:#9c937f;--line:rgba(255,255,255,.12);--gold:#d6b25a}
.wrap{background:var(--bg);min-height:100%;padding:40px 20px;font-family:'Segoe UI',system-ui,-apple-system,Arial,sans-serif;color:var(--ink)}
.inner{max-width:760px;margin:0 auto}
.eyebrow{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:var(--gold);font-weight:600;margin:0 0 6px}
.title{font-size:26px;font-weight:600;margin:0 0 4px;letter-spacing:-.01em}
.lede{font-size:14px;color:var(--muted);margin:0 0 28px}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:18px}
@media (max-width:520px){.grid{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 18px 14px;text-align:center}
.badge{width:100%;max-width:230px;margin:0 auto}
.name{margin-top:12px;font-size:14px;font-weight:600;color:var(--ink)}
.hint{margin-top:2px;font-size:12px;color:var(--muted)}
</style>`;

const gallery = `${style}<div class="wrap"><div class="inner">
<p class="eyebrow">Sequence Surface · HRMS</p>
<h1 class="title">Choose a logo badge</h1>
<p class="lede">Slimmer gold ring with black curved wordmarks around your existing app-icon mark. Four ring treatments; tell me A, B, C or D.</p>
${sprite}
<div class="grid">
${cards.map((c) => `<div class="card"><div class="badge">${badgePreview(c.o)}</div><div class="name">${LABELS[c.name]}</div><div class="hint">${HINTS[c.name]}</div></div>`).join('\n')}
</div></div></div>`;
fs.writeFileSync(path.join(dir, 'gallery.html'), gallery);

console.log('wrote', cards.length, 'svgs (slim ring, black text) + gallery.html');
