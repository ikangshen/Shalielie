// Renders README.md and README.zh-CN.md into web/about.html and web/about.zh.html, the
// "About this page" pages of the browser build. Run by the Pages workflow before upload;
// the outputs are not committed.
//
//   GITHUB_TOKEN=$(gh auth token) node tools/render-about.mjs     # local preview
//
// Uses GitHub's own Markdown renderer, so the pages read exactly like the repo's README.
// Links to the other README become links to the other about page; links to any other repo
// file go to GitHub.

import { readFileSync, writeFileSync } from "node:fs";

const REPO = "nathanatgit/Shalielie";
const BLOB = `https://github.com/${REPO}/blob/master/`;
const PAGES = [
  { src: "README.md", out: "web/about.html", lang: "en", title: "About · Photographic Style Port",
    back: "Back to the converter", other: "中文", otherHref: "about.zh.html" },
  { src: "README.zh-CN.md", out: "web/about.zh.html", lang: "zh-Hans", title: "关于 · 风格调色板移植工具",
    back: "返回转换页面", other: "English", otherHref: "about.html" },
];
const RENAMED = { "README.md": "about.html", "README.zh-CN.md": "about.zh.html" };

const token = process.env.GITHUB_TOKEN;
if (!token) { console.error("GITHUB_TOKEN is not set"); process.exit(1); }

async function render(text) {
  const res = await fetch("https://api.github.com/markdown", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    body: JSON.stringify({ text, mode: "markdown" })  // as github.com renders a README,
  });
  if (!res.ok) throw new Error(`GitHub markdown API: ${res.status} ${await res.text()}`);
  return res.text();
}

// The API leaves headings without ids (github.com adds them with script), so give each one
// the slug GitHub would, for the README's own #anchors (its table of contents).
function addHeadingIds(html) {
  const seen = new Map();
  const text = (s) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return html.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/g, (m, n, attrs, inner) => {
    let slug = text(inner).trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
      .replace(/ /g, "-");
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    if (count) slug += `-${count}`;
    return `<h${n} id="${slug}"${attrs}>${inner}</h${n}>`;
  });
}

function fixLinks(html) {
  html = addHeadingIds(html);
  html = html.replace(/href="#([^"]*)"/g, (m, frag) => `href="#${decodeURIComponent(frag)}"`);
  return html.replace(/(href|src)="([^"#:][^":]*?)"/g, (m, attr, path) => {
    const [file, hash = ""] = path.replace(/^\.\//, "").split("#");
    if (RENAMED[file]) return `${attr}="${RENAMED[file]}${hash && "#" + hash}"`;
    return `${attr}="${BLOB}${path.replace(/^\.\//, "")}${attr === "src" ? "?raw=true" : ""}"`;
  });
}

const page = (p, body) => `<!doctype html>
<html lang="${p.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${p.title}</title>
<link rel="icon" href="icons/icon-192.png">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5.8.1/github-markdown.min.css">
<style>
  :root { color-scheme: light dark; --bg: #ffffff; --line: #d1d9e0; --link: #0969da; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --line: #3d444d; --link: #4493f8; } }
  body { margin: 0; background: var(--bg); }
  .bar { max-width: 980px; margin: 0 auto; padding: 14px 16px; display: flex; justify-content: space-between;
         gap: 12px; border-bottom: 1px solid var(--line);
         font: 600 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", "PingFang SC",
               "Microsoft YaHei UI", sans-serif; }
  .bar a { color: var(--link); text-decoration: none; }
  .bar a:hover { text-decoration: underline; }
  .markdown-body { box-sizing: border-box; max-width: 980px; margin: 0 auto; padding: 24px 16px 48px; }
</style>
</head>
<body>
<nav class="bar"><a href="./">← ${p.back}</a><a href="${p.otherHref}">${p.other}</a></nav>
<article class="markdown-body">
${body}
</article>
</body>
</html>
`;

for (const p of PAGES) {
  const html = fixLinks(await render(readFileSync(p.src, "utf8")));
  writeFileSync(p.out, page(p, html));
  console.log(`${p.src} -> ${p.out}`);
}
