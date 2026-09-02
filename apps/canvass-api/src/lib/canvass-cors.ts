import { allowedCanvassOrigin } from "@savvy/core";

// CORS headers for the canvass field-app endpoints (separate origin).
// Allowlist via CANVASS_ALLOWED_ORIGINS; Authorization is allowed so the app
// can send its bearer session token.
export function canvassCors(req: Request, methods = "POST, OPTIONS"): Record<string, string> {
  const allow = allowedCanvassOrigin(req.headers.get("origin"), process.env.CANVASS_ALLOWED_ORIGINS);
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (allow) h["Access-Control-Allow-Origin"] = allow;
  return h;
}
