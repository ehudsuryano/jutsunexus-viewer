# JutsuNexus Viewer

A static page that opens [JutsuNexus](https://github.com/ehudsuryano) technique packages and
technique links in any browser, including on an iPhone, without the app.

**Live:** https://ehudsuryano.github.io/jutsunexus-viewer/

## Nothing is uploaded

- **Packages (.zip):** the file you pick is read by this page inside your browser. The ZIP index is
  parsed in JavaScript, and each photo or video is a slice of your own file, so nothing is sent
  anywhere and large videos never have to be copied into memory.
- **Technique links (`#t1.…`):** the technique's text is inside the link's `#fragment`. Browsers
  never send the fragment to the server, so GitHub Pages never sees it.
- **Links to a package** (`?open=<url>`, GitHub/Dropbox/any host that allows cross-site reads):
  only the ranges being looked at are fetched, straight from that host into the browser.
  Google Drive refuses reads from web pages (it returns 403 to any request carrying
  `Sec-Fetch-Site: cross-site`), so Drive links show download instructions instead.

## Files

| File | What it is |
| --- | --- |
| `index.html`, `style.css`, `app.js` | The viewer. No build step, no framework. |
| `pako_inflate.min.js` | [pako](https://github.com/nodeca/pako) 2.1.0 inflate (MIT/Zlib), for DEFLATE entries and technique links. |

The technique-link format must stay identical to `src/utils/techniqueLink.ts` in the app:
JSON with short keys → raw DEFLATE → base64url, prefixed `t1.`.
