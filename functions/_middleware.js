// Canonical host redirect: force non-www.
// 301s any request to www.pianoplayertech.com -> pianoplayertech.com,
// preserving the path and query string. Everything else passes through.
export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);

  if (url.hostname === "www.pianoplayertech.com") {
    url.hostname = "pianoplayertech.com";
    return Response.redirect(url.toString(), 301);
  }

  return next();
}
