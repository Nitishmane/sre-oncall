import { auth } from "./auth.ts";

/**
 * Guards every page and API route. Only the sign-in page, the Auth.js callback
 * routes, and Next's own assets are reachable unauthenticated — so an
 * unauthenticated visitor cannot reach the harness proxy at all, not even to
 * probe it.
 */
export default auth((req) => {
  if (req.auth) return;

  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/api/")) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const signin = new URL("/signin", req.nextUrl.origin);
  return Response.redirect(signin);
});

export const config = {
  matcher: [
    // Everything except Next internals, the sign-in page, and the auth routes.
    "/((?!api/auth|signin|_next/static|_next/image|favicon.ico).*)",
  ],
};
