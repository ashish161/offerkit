/**
 * Guard for the public QR Loyalty merchant endpoints (/api/scan).
 *
 * POC: intentionally permissive so the flow can be demoed without setup.
 * The only call site is handleScan() — flipping this to a real check
 * (shared PIN, dashboard session, API key, IP allowlist) is a one-file
 * change and automatically covers every public scan entry point.
 */
export async function authorizeScan(request: Request): Promise<void> {
  void request;
  // POC: open access. Later: verify a merchant PIN/session and throw
  // Response with 401 (or an ORPCError-compatible error) on failure.
}
