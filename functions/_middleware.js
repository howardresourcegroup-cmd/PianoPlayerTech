// Pages deploys the whole repo root, so every committed file is servable.
// These are repo internals, not site: design docs, outreach drafts, the
// database schema, tests and tooling. Any dot-directory or dotfile is hidden
// too, except /.well-known/.
const PRIVATE_DIRS = new Set(["docs", "tests", "db", "tools", "node_modules"]);
const PRIVATE_FILES = new Set(["package.json", "package-lock.json", "eslint.config.mjs"]);

// The asset server decodes %XX and collapses repeated slashes before it looks
// up a file (verified live: /%64ocs/... and //docs/... both served the drafts),
// so match on the path the way it will resolve, not the way it was sent.
function isPrivate(pathname) {
  let path;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  const first = path.toLowerCase().split("/").find((s) => s !== "" && s !== ".") || "";
  if (first.startsWith(".")) return first !== ".well-known";
  return PRIVATE_DIRS.has(first) || PRIVATE_FILES.has(first);
}

// Other names for the production site. pianoplayertech.pages.dev serves the
// same pages, so without this it competes with the real domain in search.
// Branch previews are subdomains of it (abc123.pianoplayertech.pages.dev) and
// stay reachable: they are how a branch gets checked before it ships.
const ALIASES = new Set(["www.pianoplayertech.com", "pianoplayertech.pages.dev"]);

// Canonical host redirect: force the one real domain.
// 301s any request on an alias -> pianoplayertech.com, preserving the path
// and query string. Everything else passes through.
export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);

  if (ALIASES.has(url.hostname)) {
    url.hostname = "pianoplayertech.com";
    return Response.redirect(url.toString(), 301);
  }

  if (isPrivate(url.pathname)) {
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex" },
    });
  }

  return next();
}
