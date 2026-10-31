/*
 * JutsuNexus Viewer — opens JutsuNexus packages and technique links entirely in the browser.
 *
 * Nothing is uploaded. A package is read straight from the file the visitor picks: the ZIP's
 * central directory is parsed here, and each entry is a lazy slice of that file. The app writes
 * packages with STORE (no compression), so a video entry is played directly from its slice
 * without copying it into memory — which is what keeps a phone browser (iPhone included) from
 * running out of memory on a package full of clips. DEFLATE entries (older Kotlin-app packages)
 * are inflated with pako.
 *
 * Technique links carry the technique in the URL fragment (#t1.<data>). Browsers never send the
 * fragment to the server, so the page host never sees it. Format: JSON with short keys → raw
 * DEFLATE → base64url, identical to src/utils/techniqueLink.ts in the app. Change both or neither.
 */
'use strict';

// --- tiny DOM helper --------------------------------------------------------------------------

/** Builds elements from data without ever passing package text through innerHTML. */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

/** replaceChildren that skips null/false; the DOM's own turns a null into the text "null". */
function fill(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c != null && c !== false));
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  folder: 'M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
  technique: 'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
  play: 'M8 5v14l11-7z',
  link: 'M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z',
  youtube: 'M21.58 7.19c-.23-.86-.91-1.54-1.77-1.77C18.25 5 12 5 12 5s-6.25 0-7.81.42c-.86.23-1.54.91-1.77 1.77C2 8.75 2 12 2 12s0 3.25.42 4.81c.23.86.91 1.54 1.77 1.77C5.75 19 12 19 12 19s6.25 0 7.81-.42c.86-.23 1.54-.91 1.77-1.77C22 15.25 22 12 22 12s0-3.25-.42-4.81zM10 15V9l5.2 3L10 15z',
  doc: 'M6 2c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6H6zm7 7V3.5L18.5 9H13z',
  zip: 'M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-2 6h-2v2h2v2h-2v2h-2v-2h2v-2h-2v-2h2v-2h-2V8h2v2h2v2z',
};
function icon(name, size = 24) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

// --- ZIP reading (central directory + lazy slices) ------------------------------------------

const utf8 = new TextDecoder('utf-8');

// A "source" is where package bytes come from: a file the visitor picked, or a link. The ZIP code
// only ever asks for byte ranges, so a linked package is read the same lazy way as a local one —
// the index first, then each photo or video only when it is looked at.

function fileSource(file) {
  return {
    name: file.name,
    read: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()),
    readTail: async (n) =>
      new Uint8Array(await file.slice(Math.max(0, file.size - n), file.size).arrayBuffer()),
    // A zero-copy slice of the picked file: video plays from it without entering memory.
    blob: async (start, end, type) => file.slice(start, end, type || ''),
  };
}

/**
 * The same link rewriting the app does (src/data/transfer/remotePackage.ts): Drive share links →
 * the usercontent download endpoint, Dropbox → dl=1, GitHub blob → raw.
 *
 * GOOGLE DRIVE CANNOT BE READ FROM A WEB PAGE. Its download endpoint does send
 * Access-Control-Allow-Origin: *, but answers 403 to any request carrying
 * `Sec-Fetch-Site: cross-site` — a header every browser adds and no page can remove (measured
 * 2026-09-29 with curl, header by header, and in Chromium and WebKit). The app is not a browser,
 * so it downloads Drive links fine; here a Drive link gets download instructions instead.
 * raw.githubusercontent.com does allow it, with Range.
 */
function resolveDownloadUrl(input) {
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (/(^|\.)(drive|docs|drive\.usercontent)\.google\.com$/.test(url.hostname)) {
    const m = /\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(url.pathname);
    const id = m ? m[1] : url.searchParams.get('id');
    if (id) return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
  }
  if (/(^|\.)dropbox\.com$/.test(url.hostname)) {
    url.searchParams.set('dl', '1');
    return url.toString();
  }
  if (url.hostname === 'github.com') {
    const m = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname);
    if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  }
  return url.toString();
}

function sourceName(link) {
  try {
    const u = new URL(link);
    if (/google\.com$/.test(u.hostname)) return 'Package from Google Drive';
    if (/dropbox/.test(u.hostname)) return 'Package from Dropbox';
    const last = decodeURIComponent(u.pathname.split('/').pop() || '');
    return last || u.hostname;
  } catch {
    return 'Package';
  }
}

const DRIVE_MESSAGE =
  'Google Drive doesn’t let web pages read its files, so a Drive link can’t be opened here directly. ' +
  'Open the link, tap Download, then come back and tap “Open a package” to pick the downloaded .zip.';

function isDriveLink(url) {
  return /^https:\/\/drive\.usercontent\.google\.com\//.test(url || '');
}

async function urlSource(link) {
  const url = resolveDownloadUrl(link);
  if (!url) throw new Error('That is not a web link.');
  if (isDriveLink(url)) throw new Error(DRIVE_MESSAGE);
  const fetchRange = async (range) => {
    let r;
    try {
      r = await fetch(url, { headers: { Range: range } });
    } catch {
      throw new Error('That link can’t be read from a web page. Download the .zip and open it here instead.');
    }
    if (r.status === 401 || r.status === 403) throw new Error('The link is not public. In Drive, set sharing to “Anyone with the link”.');
    if (r.status === 404) throw new Error('Nothing is at that link any more.');
    if (!r.ok) throw new Error(`The link answered with an error (HTTP ${r.status}).`);
    if (/text\/html/i.test(r.headers.get('content-type') || '')) {
      throw new Error('That link opens a web page, not a package. If it is a Drive link, set sharing to “Anyone with the link”.');
    }
    return r;
  };

  // A server that ignores Range sends the whole file back: then just hold it as a local file.
  const tailResponse = await fetchRange('bytes=-65557');
  if (tailResponse.status === 200) {
    const blob = await tailResponse.blob();
    return fileSource(new File([blob], sourceName(link)));
  }
  const tail = new Uint8Array(await tailResponse.arrayBuffer());
  const read = async (start, end) =>
    new Uint8Array(await (await fetchRange(`bytes=${start}-${end - 1}`)).arrayBuffer());
  return {
    name: sourceName(link),
    link,
    read,
    readTail: async () => tail,
    blob: async (start, end, type) => new Blob([await read(start, end)], { type: type || '' }),
  };
}

/** u64 little-endian as a Number; exact below 2^53, which no phone file approaches. */
function u64(view, at) {
  return view.getUint32(at, true) + view.getUint32(at + 4, true) * 2 ** 32;
}

async function openZip(src) {
  const tail = await src.readTail(22 + 65535);
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This file is not a ZIP package.');

  let count = tv.getUint16(eocd + 10, true);
  let cdSize = tv.getUint32(eocd + 12, true);
  let cdOffset = tv.getUint32(eocd + 16, true);

  // ZIP64: the real numbers live in a separate record the locator points at.
  if (cdOffset === 0xffffffff || count === 0xffff || cdSize === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || tv.getUint32(loc, true) !== 0x07064b50) throw new Error('Unsupported ZIP layout.');
    const z64At = u64(tv, loc + 8);
    const zb = await src.read(z64At, z64At + 56);
    const z = new DataView(zb.buffer, zb.byteOffset, zb.byteLength);
    if (z.getUint32(0, true) !== 0x06064b50) throw new Error('Damaged ZIP64 record.');
    count = u64(z, 32);
    cdSize = u64(z, 40);
    cdOffset = u64(z, 48);
  }

  const cd = await src.read(cdOffset, cdOffset + cdSize);
  const v = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const entries = new Map();
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    let compSize = v.getUint32(p + 20, true);
    let size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    let offset = v.getUint32(p + 42, true);
    const name = utf8.decode(cd.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 extra field: only the values that overflowed are present, in this order.
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = v.getUint16(e, true);
      const len = v.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = u64(v, q); q += 8; }
        if (compSize === 0xffffffff) { compSize = u64(v, q); q += 8; }
        if (offset === 0xffffffff) { offset = u64(v, q); }
      }
      e += 4 + len;
    }
    entries.set(name.replace(/\\/g, '/'), { name, method, compSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** A Blob of one entry's contents. For a picked file, STORE entries are zero-copy slices. */
async function entryBlob(src, entry, type) {
  const hb = await src.read(entry.offset, entry.offset + 30);
  const head = new DataView(hb.buffer, hb.byteOffset, hb.byteLength);
  if (head.getUint32(0, true) !== 0x04034b50) throw new Error(`Damaged entry: ${entry.name}`);
  const start = entry.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
  const raw = await src.blob(start, start + entry.compSize, type);
  if (entry.method === 0) return raw;
  if (entry.method === 8) {
    const out = pako.inflateRaw(new Uint8Array(await raw.arrayBuffer()));
    return new Blob([out], { type: type || '' });
  }
  throw new Error(`Unsupported compression in ${entry.name}`);
}

// --- state ------------------------------------------------------------------------------------

const $main = document.getElementById('main');
const $crumbs = document.getElementById('crumbs');
const $back = document.getElementById('back');
const $openOther = document.getElementById('open-other');
const $fileInput = document.getElementById('file-input');

/** The open package, or null. */
let pkg = null;
/** Object URLs handed out for the open package; revoked when another one is opened. */
let objectUrls = new Map();

async function urlFor(entryName, type) {
  if (objectUrls.has(entryName)) return objectUrls.get(entryName);
  const entry = pkg.entries.get(entryName);
  if (!entry) return null;
  const url = URL.createObjectURL(await entryBlob(pkg.source, entry, type));
  objectUrls.set(entryName, url);
  return url;
}

function releaseUrls() {
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls = new Map();
}

function guessMime(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    heic: 'image/heic', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
    webm: 'video/webm', '3gp': 'video/3gpp', pdf: 'application/pdf',
  }[ext] || '';
}

/** `open` is a source, or a promise of one (a link still being resolved). */
async function loadPackage(open, label) {
  showLoading(`Opening ${label}…`);
  try {
    const source = await open;
    const entries = await openZip(source);
    const read = async (name) => {
      const entry = entries.get(name);
      if (!entry) return null;
      return JSON.parse(await (await entryBlob(source, entry)).text());
    };
    const manifest = await read('manifest.json');
    if (!manifest) throw new Error('This ZIP is not a JutsuNexus package (manifest.json is missing).');
    const content = (await read('content.json')) || {};

    const groups = content.groups || [];
    const techniques = content.techniques || [];
    const media = content.media || [];
    const groupIds = new Set(groups.map((g) => g.id));
    const parentOf = (g) => (g.parentId != null && groupIds.has(g.parentId) ? g.parentId : null);
    const groupOf = (t) => (t.groupId != null && groupIds.has(t.groupId) ? t.groupId : null);

    const childGroups = new Map();
    for (const g of groups) push(childGroups, parentOf(g), g);
    const childTechniques = new Map();
    for (const t of techniques) push(childTechniques, groupOf(t), t);
    const mediaByTechnique = new Map();
    for (const m of media) push(mediaByTechnique, m.techniqueId, m);
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    for (const list of childGroups.values()) list.sort(byName);
    for (const list of childTechniques.values()) list.sort(byName);
    for (const [id, list] of mediaByTechnique) mediaByTechnique.set(id, videosFirst(list));

    releaseUrls();
    pkg = {
      source,
      name: source.name,
      entries,
      manifest,
      groups: new Map(groups.map((g) => [g.id, g])),
      techniques: new Map(techniques.map((t) => [t.id, t])),
      childGroups,
      childTechniques,
      mediaByTechnique,
      parentOf,
      groupOf,
    };

    // A single-technique package opens on the technique; everything else on its top level.
    const roots = childGroups.get(null) || [];
    const rootTechs = childTechniques.get(null) || [];
    const start =
      roots.length === 0 && rootTechs.length === 1
        ? { view: 'technique', id: rootTechs[0].id }
        : roots.length === 1 && rootTechs.length === 0
          ? { view: 'group', id: roots[0].id }
          : { view: 'group', id: null };
    // A linked package keeps its link in the address, so the page can be bookmarked or shared.
    history.pushState(start, '', source.link ? `${location.pathname}?open=${encodeURIComponent(source.link)}` : location.pathname);
    render(start);
  } catch (err) {
    pkg = null;
    renderHome(err.message || String(err));
  }
}

function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Same order as the app's grid: videos, then photos, then documents; stored order within. */
function videosFirst(list) {
  const rank = { VIDEO: 0, IMAGE: 1 };
  return list
    .map((m, i) => ({ m, i }))
    .sort((a, b) =>
      (rank[a.m.type] ?? 2) - (rank[b.m.type] ?? 2) ||
      (a.m.sortOrder ?? 0) - (b.m.sortOrder ?? 0) ||
      a.i - b.i)
    .map((x) => x.m);
}

// --- rendering --------------------------------------------------------------------------------

function showLoading(text) {
  $crumbs.hidden = true;
  fill($main, h('p', { class: 'loading' }, text));
}

function setChrome({ back, other }) {
  $back.hidden = !back;
  $openOther.hidden = !other;
}

function render(state) {
  window.scrollTo(0, 0);
  if (state && state.view === 'link') return renderLink(state.token);
  if (!pkg || !state || state.view === 'home') return renderHome();
  if (state.view === 'technique' && pkg.techniques.has(state.id)) return renderTechnique(pkg.techniques.get(state.id));
  return renderGroup(state.id != null && pkg.groups.has(state.id) ? state.id : null);
}

function renderHome(error) {
  setChrome({ back: false, other: false });
  $crumbs.hidden = true;
  const drop = h('div', { class: 'dropzone', id: 'dropzone' },
    h('button', { class: 'btn', type: 'button', onclick: () => $fileInput.click() },
      icon('zip', 20), 'Open a package'),
    h('p', {}, 'Pick the .zip someone sent you. You can also drop it here.'));
  fill($main, 
    h('section', { class: 'hero' },
      h('img', { src: 'logo.png', alt: 'JutsuNexus', width: 600, height: 307 }),
      h('p', {}, 'Look through martial-arts techniques shared from the JutsuNexus app: groups, steps, notes, links, photos and videos.')),
    error ? h('div', { class: 'card error-box' }, h('p', {}, error)) : null,
    linkForm(),
    drop,
    h('div', { class: 'card' },
      h('h2', {}, 'Nothing leaves your device'),
      h('p', {}, 'The package is opened by this page inside your browser. It is never uploaded — this site has no server that could receive it.')),
    h('div', { class: 'card' },
      h('h2', {}, 'On an iPhone'),
      h('ol', {},
        h('li', {}, 'Got a Google Drive link? Open it and tap Download — it lands in Files.'),
        h('li', {}, 'Got a .zip in WhatsApp or Mail? Open it and tap Share → Save to Files.'),
        h('li', {}, 'Come back here, tap “Open a package” and pick it in Files.'),
        h('li', {}, 'Don’t tap the .zip inside the Files app first — iOS unzips it into a folder, and a folder can’t be opened here.')),
      h('p', { class: 'small' }, 'Big packages can be too much for a phone browser. Ask for a single technique or group rather than a whole library.')),
    h('div', { class: 'card' },
      h('h2', {}, 'Have the app?'),
      h('p', {}, 'On Android, open the .zip with JutsuNexus instead to keep it in your own library.')));
  wireDrop(drop);
}

function linkForm() {
  const input = h('input', {
    type: 'url', id: 'link-input', class: 'link-input', inputmode: 'url', autocomplete: 'off',
    placeholder: 'https://… link to a .zip', 'aria-label': 'Package link',
  });
  const submit = (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    const token = /(t1\.[A-Za-z0-9_-]+)/.exec(value);
    if (token) { location.hash = token[1]; return; }
    loadPackage(urlSource(value), sourceName(resolveDownloadUrl(value) || value));
  };
  return h('form', { class: 'card link-form', onsubmit: submit },
    h('h2', {}, 'Got a link?'),
    h('p', {}, 'Paste a link to a package on GitHub, Dropbox or another open web address. Only the parts you look at are downloaded.'),
    h('p', { class: 'small' }, 'A Google Drive link? Drive blocks web pages from reading it: open the link, tap Download, then use “Open a package” below.'),
    h('div', { class: 'link-row' }, input, h('button', { class: 'btn', type: 'submit' }, 'Open')));
}

function wireDrop(zone) {
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter', 'dragover'].forEach((t) => zone.addEventListener(t, (e) => { stop(e); zone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((t) => zone.addEventListener(t, (e) => { stop(e); zone.classList.remove('drag'); }));
  zone.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (file) loadPackage(fileSource(file), file.name);
  });
}

function crumbsFor(groupId, leaf) {
  const chain = [];
  let id = groupId;
  let guard = 0;
  while (id != null && guard++ < 64) {
    const g = pkg.groups.get(id);
    if (!g) break;
    chain.unshift(g);
    id = pkg.parentOf(g);
  }
  const parts = [h('button', { type: 'button', onclick: () => go({ view: 'group', id: null }) }, 'Package')];
  chain.forEach((g, i) => {
    parts.push(h('span', { 'aria-hidden': 'true' }, '›'));
    const isLast = i === chain.length - 1 && !leaf;
    parts.push(isLast
      ? h('span', { class: 'current' }, g.name)
      : h('button', { type: 'button', onclick: () => go({ view: 'group', id: g.id }) }, g.name));
  });
  if (leaf) {
    parts.push(h('span', { 'aria-hidden': 'true' }, '›'));
    parts.push(h('span', { class: 'current' }, leaf));
  }
  $crumbs.replaceChildren(...parts);
  $crumbs.hidden = false;
}

function go(state) {
  history.pushState(state, '', location.pathname);
  render(state);
}

function countTechniques(groupId) {
  let n = (pkg.childTechniques.get(groupId) || []).length;
  for (const g of pkg.childGroups.get(groupId) || []) n += countTechniques(g.id);
  return n;
}

function thumbFor(coverEntry, kind) {
  const box = h('span', { class: `thumb ${kind}` }, icon(kind === 'group' ? 'folder' : 'technique', 28));
  if (coverEntry) {
    urlFor(coverEntry, guessMime(coverEntry)).then((url) => {
      if (url) box.replaceChildren(h('img', { src: url, alt: '', loading: 'lazy' }));
    }).catch(() => {});
  }
  return box;
}

function renderGroup(groupId) {
  setChrome({ back: groupId != null, other: true });
  crumbsFor(groupId);
  const group = groupId != null ? pkg.groups.get(groupId) : null;
  const groups = pkg.childGroups.get(groupId) || [];
  const techniques = pkg.childTechniques.get(groupId) || [];
  const m = pkg.manifest;

  const header = group
    ? h('div', { class: 'tech-head' },
        h('h1', {}, group.name),
        group.description ? h('p', { class: 'muted' }, group.description) : null,
        tagChips(group.tags))
    : h('div', { class: 'tech-head' },
        h('h1', {}, pkg.name.replace(/\.zip$/i, '').replace(/_/g, ' ')),
        h('p', { class: 'pkg-summary' },
          `${m.groupCount ?? 0} groups • ${m.techniqueCount ?? 0} techniques • ${m.mediaCount ?? 0} media` +
          (m.exportedAt ? ` • exported ${new Date(m.exportedAt).toLocaleDateString()}` : '') +
          (m.includesMedia === false ? ' • without media' : '')));

  const list = h('div', { class: 'list' },
    groups.map((g) => {
      const sub = (pkg.childGroups.get(g.id) || []).length;
      const tech = countTechniques(g.id);
      return h('button', { class: 'item', type: 'button', onclick: () => go({ view: 'group', id: g.id }) },
        thumbFor(g.coverEntry, 'group'),
        h('span', { class: 'item-body' },
          h('span', { class: 'item-title' }, g.name),
          h('span', { class: 'item-meta' },
            `${sub} ${sub === 1 ? 'group' : 'groups'} • ${tech} ${tech === 1 ? 'technique' : 'techniques'}`)));
    }),
    techniques.map((t) => {
      const count = (pkg.mediaByTechnique.get(t.id) || []).length;
      return h('button', { class: 'item', type: 'button', onclick: () => go({ view: 'technique', id: t.id }) },
        thumbFor(t.coverEntry, 'technique'),
        h('span', { class: 'item-body' },
          h('span', { class: 'item-title' }, t.name),
          h('span', { class: 'item-meta' },
            ['Technique', count > 0 ? `${count} media` : null, t.position || null].filter(Boolean).join(' • ')),
          difficultyBar(t.difficulty)));
    }));

  const empty = groups.length === 0 && techniques.length === 0
    ? h('p', { class: 'empty' }, 'Nothing in here.') : null;
  fill($main, header, empty || list);
}

const DIFFICULTY = { BEGINNER: 1, INTERMEDIATE: 2, ADVANCED: 3, EXPERT: 4 };
const DIFFICULTY_LABEL = { BEGINNER: 'Beginner', INTERMEDIATE: 'Intermediate', ADVANCED: 'Advanced', EXPERT: 'Expert' };
const CLASSIFICATION = { OFFENSE: 'Offense', DEFENSE: 'Defense', COUNTER: 'Counter', TRANSITION: 'Transition' };

function difficultyBar(d, withLabel) {
  const level = DIFFICULTY[d];
  if (!level) return null;
  return h('span', { class: 'difficulty', title: DIFFICULTY_LABEL[d] },
    [1, 2, 3, 4].map((i) => h('i', { class: i <= level ? 'on' : '' })),
    withLabel ? h('span', { style: 'margin-left:6px' }, DIFFICULTY_LABEL[d]) : null);
}

function tagChips(tags) {
  if (!tags || tags.length === 0) return null;
  return h('div', { class: 'chips' }, tags.map((t) => h('span', { class: 'chip' }, t)));
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return null;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function safeHref(url) {
  const u = String(url || '').trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (/^[\w-]+(\.[\w-]+)+/.test(u)) return `https://${u}`;
  return null;
}

function isYouTube(url) {
  return /(^|\/\/)(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(url || '');
}

function linkTitle(l) {
  if (l.title && l.title.trim()) return l.title;
  try { return new URL(safeHref(l.url)).hostname.replace(/^www\./, ''); } catch { return l.url; }
}

/** The text part of a technique, shared by package techniques and technique links. */
function techniqueSections(t) {
  const out = [];
  if (t.description) out.push(section('Description', h('p', {}, t.description)));
  if (t.steps && t.steps.length) {
    out.push(section('Execution steps',
      h('ol', { class: 'steps' }, t.steps.map((s, i) => h('li', {}, h('span', { class: 'n' }, i + 1), h('span', {}, s))))));
  }
  if (t.notes) out.push(section('Notes', h('p', {}, t.notes)));
  if (t.links && t.links.length) {
    out.push(section('Links', h('div', { class: 'links' }, t.links.map((l) => {
      const href = safeHref(l.url);
      const yt = isYouTube(l.url);
      return h(href ? 'a' : 'div', { class: `link${yt ? ' yt' : ''}`, href, target: '_blank', rel: 'noopener noreferrer' },
        icon(yt ? 'youtube' : 'link', 22),
        h('div', {}, h('b', {}, linkTitle(l)), h('small', {}, l.url)));
    }))));
  }
  return out;
}

function section(title, body) {
  return h('section', { class: 'section' }, h('h2', {}, title), body);
}

function techniqueHead(t) {
  const meta = [
    CLASSIFICATION[t.classification] || null,
    t.position || null,
  ].filter(Boolean);
  return h('div', { class: 'tech-head' },
    h('h1', {}, t.name),
    h('div', { class: 'meta-row' }, meta.map((m) => h('span', {}, m)), difficultyBar(t.difficulty, true)),
    tagChips(t.tags));
}

function renderTechnique(t) {
  setChrome({ back: true, other: true });
  crumbsFor(pkg.groupOf(t), t.name);
  const media = pkg.mediaByTechnique.get(t.id) || [];

  const cover = t.coverEntry ? h('img', { class: 'cover', alt: '' }) : null;
  if (cover) urlFor(t.coverEntry, guessMime(t.coverEntry)).then((u) => { if (u) cover.src = u; else cover.remove(); });

  const parts = [cover, techniqueHead(t)];
  if (media.length > 0) {
    parts.push(section(`Media (${media.length})`, h('div', { class: 'media-grid' },
      media.map((m, i) => mediaTile(m, () => openLightbox(media, i))))));
  } else if (pkg.manifest.includesMedia === false) {
    parts.push(h('p', { class: 'muted small section' }, 'This package was shared without media.'));
  }
  parts.push(...techniqueSections(t));
  fill($main, ...parts);
}

function mediaTile(m, onOpen) {
  const tile = h('button', { class: 'tile', type: 'button', 'aria-label': m.fileName, onclick: onOpen });
  const type = m.mimeType || guessMime(m.fileName);
  if (!pkg.entries.has(m.zipEntry)) {
    tile.append(h('span', { class: 'doc' }, 'Missing from package'));
    tile.disabled = true;
    return tile;
  }
  if (m.type === 'IMAGE') {
    urlFor(m.zipEntry, type).then((u) => u && tile.prepend(h('img', { src: u, alt: '', loading: 'lazy' })));
  } else if (m.type === 'VIDEO') {
    // "#t=0.1" makes Safari paint a first frame instead of a black box.
    urlFor(m.zipEntry, type).then((u) => u && tile.prepend(
      h('video', { src: `${u}#t=0.1`, muted: true, playsinline: true, preload: 'metadata' })));
    tile.append(h('span', { class: 'badge' }, icon('play', 12), formatDuration(m.durationMs) || 'Video'));
  } else {
    tile.append(h('span', { class: 'doc' }, icon('doc', 28), h('br'), m.fileName));
  }
  return tile;
}

// --- lightbox --------------------------------------------------------------------------------

const $lightbox = document.getElementById('lightbox');
const $stage = document.getElementById('lightbox-stage');
const $caption = document.getElementById('lightbox-caption');
let lightboxItems = [];
let lightboxIndex = 0;

async function showLightboxItem() {
  const m = lightboxItems[lightboxIndex];
  const type = m.mimeType || guessMime(m.fileName);
  $caption.textContent = `${lightboxIndex + 1}/${lightboxItems.length} · ${m.fileName}`;
  document.getElementById('lightbox-prev').hidden = lightboxItems.length < 2;
  document.getElementById('lightbox-next').hidden = lightboxItems.length < 2;
  $stage.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  const url = await urlFor(m.zipEntry, type);
  if (!url) { $stage.replaceChildren(h('p', { class: 'muted' }, 'Missing from package')); return; }
  if (m.type === 'VIDEO') {
    $stage.replaceChildren(h('video', { src: url, controls: true, playsinline: true, autoplay: true }));
  } else if (m.type === 'IMAGE') {
    $stage.replaceChildren(h('img', { src: url, alt: m.fileName }));
  } else {
    $stage.replaceChildren(h('a', { class: 'btn', href: url, download: m.fileName }, `Download ${m.fileName}`));
  }
}

function openLightbox(items, index) {
  lightboxItems = items;
  lightboxIndex = index;
  $lightbox.hidden = false;
  document.body.style.overflow = 'hidden';
  showLightboxItem();
}

function closeLightbox() {
  $lightbox.hidden = true;
  $stage.replaceChildren();
  document.body.style.overflow = '';
}

document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
document.getElementById('lightbox-prev').addEventListener('click', () => {
  lightboxIndex = (lightboxIndex - 1 + lightboxItems.length) % lightboxItems.length;
  showLightboxItem();
});
document.getElementById('lightbox-next').addEventListener('click', () => {
  lightboxIndex = (lightboxIndex + 1) % lightboxItems.length;
  showLightboxItem();
});
document.addEventListener('keydown', (e) => {
  if ($lightbox.hidden) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') document.getElementById('lightbox-prev').click();
  if (e.key === 'ArrowRight') document.getElementById('lightbox-next').click();
});

// --- technique links (#t1.…) -------------------------------------------------------------------

function fromBase64Url(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeTechniqueToken(token) {
  if (!token.startsWith('t1.')) throw new Error('This technique link was made by a newer version of JutsuNexus.');
  let p;
  try {
    p = JSON.parse(pako.inflateRaw(fromBase64Url(token.slice(3)), { to: 'string' }));
  } catch {
    throw new Error('This technique link is damaged — it may have been cut off when it was copied.');
  }
  if (!p || typeof p.n !== 'string') throw new Error('This technique link has no technique in it.');
  return {
    name: p.n,
    description: p.d || '',
    steps: Array.isArray(p.s) ? p.s : [],
    difficulty: p.df || 'UNSPECIFIED',
    position: p.p || '',
    classification: p.c || 'UNSPECIFIED',
    tags: Array.isArray(p.tg) ? p.tg : [],
    notes: p.no || '',
    links: Array.isArray(p.l) ? p.l.map(([title, url]) => ({ title, url })) : [],
  };
}

// --- direct-send links (#s1.…) -------------------------------------------------------------------

/**
 * A link sent from the app's "Send by link". Messaging apps only make web addresses tappable, so
 * this page is the step between WhatsApp and the app. The download itself happens in the app,
 * straight from the sender's phone; the code stays in the fragment, which browsers never send.
 */
function renderDirectLink(code) {
  setChrome({ back: false, other: false });
  $crumbs.hidden = true;
  document.title = 'Techniques for you · JutsuNexus';
  const isAndroid = /Android/i.test(navigator.userAgent);
  fill($main,
    h('div', { class: 'card add-box' },
      h('h2', {}, 'Someone is sending you techniques'),
      h('p', {}, isAndroid
        ? 'Open this in JutsuNexus 1.3 or newer to download it straight from the sender’s phone. Their phone has to be online with the send still running.'
        : 'This comes straight from the sender’s phone into the JutsuNexus app, which is Android only. Open this link on an Android phone.'),
      isAndroid ? h('div', { class: 'row', style: 'margin-top:12px' },
        h('a', { class: 'btn block', href: `jutsunexus://receive?c=${code}` }, 'Open in JutsuNexus')) : null),
    h('p', { class: 'section' },
      'Don’t have the app, or nothing happens? ',
      h('a', { href: 'https://ehudsuryano.github.io/jutsunexus-app/' }, 'Get the latest JutsuNexus'), '.'));
}

function renderLink(token) {
  setChrome({ back: false, other: false });
  $crumbs.hidden = true;
  let t;
  try {
    t = decodeTechniqueToken(token);
  } catch (err) {
    fill($main, h('div', { class: 'card error-box' }, h('p', {}, err.message)));
    return;
  }
  document.title = `${t.name} · JutsuNexus`;
  const isAndroid = /Android/i.test(navigator.userAgent);
  const copyBtn = h('button', {
    class: 'btn tonal block', type: 'button',
    onclick: async () => {
      try { await navigator.clipboard.writeText(location.href); copyBtn.textContent = 'Link copied'; }
      catch { copyBtn.textContent = 'Copy the address bar instead'; }
    },
  }, 'Copy link');
  fill($main, 
    techniqueHead(t),
    ...techniqueSections(t),
    h('div', { class: 'card add-box' },
      h('h2', {}, 'Keep this technique'),
      h('p', {}, isAndroid
        ? 'With JutsuNexus installed, “Add to JutsuNexus” opens it in the app so you can save it to your library.'
        : 'JutsuNexus is an Android app. On this device you can keep the link and open it here any time.'),
      h('div', { class: 'row', style: 'margin-top:12px' },
        isAndroid ? h('a', { class: 'btn block', href: `jutsunexus://technique?d=${token}` }, 'Add to JutsuNexus') : null,
        copyBtn)),
    h('p', { class: 'muted small section' },
      'Shared from JutsuNexus as text only — photos and videos travel in a package. ',
      'The technique is inside the link itself; this page never sends it anywhere.'),
    h('p', { class: 'section' }, h('a', { href: location.pathname }, 'Open a package instead')));
}

// --- boot ---------------------------------------------------------------------------------------

$fileInput.addEventListener('change', () => {
  const file = $fileInput.files && $fileInput.files[0];
  $fileInput.value = '';
  if (file) loadPackage(fileSource(file), file.name);
});
$openOther.addEventListener('click', () => $fileInput.click());
$back.addEventListener('click', () => history.back());
document.getElementById('home-link').addEventListener('click', (e) => {
  e.preventDefault();
  history.pushState({ view: 'home' }, '', location.pathname);
  pkg = null;
  releaseUrls();
  renderHome();
});
window.addEventListener('popstate', (e) => {
  if (!$lightbox.hidden) closeLightbox();
  render(e.state);
});
window.addEventListener('hashchange', boot);

function boot() {
  const direct = /^#?s1\.([0-9a-f]{64})$/.exec(location.hash);
  if (direct) {
    renderDirectLink(direct[1]);
    return;
  }
  const token = /^#?(t1\.[A-Za-z0-9_-]+)/.exec(location.hash);
  if (token) {
    history.replaceState({ view: 'link', token: token[1] }, '', location.href);
    renderLink(token[1]);
  } else {
    document.title = 'JutsuNexus Viewer';
    const open = new URLSearchParams(location.search).get('open');
    if (open && !pkg) {
      loadPackage(urlSource(open), sourceName(resolveDownloadUrl(open) || open));
    } else {
      render(pkg ? history.state : null);
    }
  }
}

boot();
