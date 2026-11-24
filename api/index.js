const handler = require("./[...path].js");

module.exports = async (request, response) => {
  if (request.method === "OPTIONS") return handler(request, response);

  // Vercel's [...path] route delivers the path segments in request.query.path.
  // Some environments (or our SPA rewrite) may deliver the raw pathname instead,
  // so normalize so the handler always sees request.query.path populated.
  if (!request.query || !request.query.path) {
    request.query = request.query || {};
    const url = new URL(request.url, "http://localhost");
    const pathname = url.pathname || "";
    const match = pathname.match(/^\/api\/(.+)$/);
    if (match) {
      request.query.path = match[1].split("/").filter(Boolean);
    }
  }

  // Ensure body is available for POST/PUT/PATCH
  if (["POST", "PUT", "PATCH"].includes(request.method)) {
    const chunks = [];
    request.on("data", c => chunks.push(c));
    await new Promise(resolve => request.on("end", resolve));
    request.body = Buffer.concat(chunks);
  }

  return handler(request, response);
};