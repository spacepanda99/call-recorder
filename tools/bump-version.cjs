// Bump the release version everywhere (footer, ?v= script URLs, service-worker cache).
// Run before every deploy: node tools/bump-version.cjs 1.8.1
const fs = require("fs");
const D = "C:/Mikes Stuff/call-recorder/";
const V = process.argv[2]; if (!V) throw new Error("version?");
const rd = (f) => fs.readFileSync(D + f, "utf8").replace(/\r\n/g, "\n");
let h = rd("index.html"), a = rd("app.js"), w = rd("sw.js");
const must = (s, x) => { if (!s.includes(x)) throw new Error("miss " + x.slice(0, 50)); };

// index.html: versioned script URL, version meta, footer
h = h.replace(/<script src="app\.js(\?v=[^"]*)?"><\/script>/, `<script src="app.js?v=${V}"></script>`);
if (h.includes('<meta name="app-version"')) h = h.replace(/<meta name="app-version" content="[^"]*">/, `<meta name="app-version" content="${V}">`);
else { must(h, "<title>GabLab</title>"); h = h.replace("<title>GabLab</title>", `<title>GabLab</title>\n<meta name="app-version" content="${V}">`); }
if (h.includes('id="ver"')) h = h.replace(/<footer id="ver" class="ver">[^<]*<\/footer>/, `<footer id="ver" class="ver">GabLab v${V}</footer>`);
else {
  must(h, "</main>");
  h = h.replace("</main>", `  <footer id="ver" class="ver">GabLab v${V}</footer>\n</main>`);
  h = h.replace("</style>", "  .ver { text-align:center; color:var(--muted); font-size:12px; opacity:.7; margin:28px 0 4px; letter-spacing:.04em; }\n</style>");
}

// app.js: VERSION constant, versioned worker, self-heal if the page and script disagree
if (/^const VERSION = /m.test(a)) a = a.replace(/^const VERSION = "[^"]*";/m, `const VERSION = "${V}";`);
else {
  must(a, '"use strict";\n');
  a = a.replace('"use strict";\n', `"use strict";
const VERSION = "${V}";
// If the page and this script come from different releases (a phone cached one of them),
// reload once to pull matching files.
(() => {
  const pageV = (document.querySelector('meta[name="app-version"]') || {}).content;
  try {
    if (pageV && pageV !== VERSION && sessionStorage.getItem("gablab-reloaded") !== VERSION) {
      sessionStorage.setItem("gablab-reloaded", VERSION); location.reload(); return;
    }
  } catch (e) {}
})();
`);
}
a = a.replace(/new Worker\("rec-worker\.js(\?v=[^"]*)?"\)/, `new Worker("rec-worker.js?v=" + VERSION)`);

// sw.js: new cache name per release, always revalidate with the server
w = w.replace(/const CACHE = "[^"]*";/, `const CACHE = "gablab-${V}";`);
w = w.replace(`const SHELL = ["./", "index.html", "app.js",`, `const SHELL = ["./", "index.html", "app.js?v=${V}",`).replace(/"app\.js\?v=[^"]*",/, `"app.js?v=${V}",`);
w = w.replace("e.respondWith(fetch(e.request).then(", 'e.respondWith(fetch(e.request, { cache: "no-cache" }).then(');
fs.writeFileSync(D + "index.html", h); fs.writeFileSync(D + "app.js", a); fs.writeFileSync(D + "sw.js", w);
console.log("version", V);
