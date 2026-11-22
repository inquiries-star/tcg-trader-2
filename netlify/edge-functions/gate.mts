import type { Config, Context } from "@netlify/edge-functions";

// Private-by-default gate. The whole site (pages and API) asks for a password
// unless you explicitly opt in to a public site with ALLOW_PUBLIC=true.
export default async (req: Request, context: Context) => {
  const password = Netlify.env.get("SITE_PASSWORD");

  if (!password) {
    if (Netlify.env.get("ALLOW_PUBLIC") === "true") return context.next();
    return new Response(
      "This site is locked. Set SITE_PASSWORD in your Netlify environment variables, then redeploy.",
      { status: 503, headers: { "content-type": "text/plain" } },
    );
  }

  const header = req.headers.get("authorization") || "";
  if (header.startsWith("Basic ")) {
    let given = "";
    try {
      const decoded = atob(header.slice(6));
      given = decoded.slice(decoded.indexOf(":") + 1);
    } catch {
      /* fall through to 401 */
    }
    // Compare without exiting early on the first mismatch.
    let diff = given.length ^ password.length;
    for (let i = 0; i < password.length; i++) diff |= (given.charCodeAt(i) || 0) ^ password.charCodeAt(i);
    if (diff === 0) return context.next();
  }

  return new Response("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="TCG Trader (private demo)"' },
  });
};

export const config: Config = { path: "/*", excludedPath: ["/.netlify/*", "/api/shippo-webhook"] };
