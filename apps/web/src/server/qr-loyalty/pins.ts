import { hashPassword, verifyPassword } from "better-auth/crypto";

/**
 * Brand PIN hashing for the multi-tenant QR loyalty flow.
 *
 * PINs are stored only as a hash (`qr_brand.pin_hash`) — never plaintext. The
 * `verifyPassword` compare is constant-time and salt is embedded in the hash,
 * so a leaked row cannot be reversed into the terminal PIN.
 */
export async function hashPin(pin: string): Promise<string> {
  return hashPassword(pin);
}

export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  if (!pin || !hash) return false;
  try {
    return await verifyPassword({ hash, password: pin });
  } catch {
    return false;
  }
}
