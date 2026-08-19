import { hash, verify } from "@node-rs/argon2";
import { config } from "../config.js";

/** argon2id, OWASP-baseline params (config.ts). Prebuilt native binding, no
 * node-gyp / build toolchain required at install time. */
export async function hashPassword(password: string): Promise<string> {
  return hash(password, {
    memoryCost: config.argon2MemoryCostKib,
    timeCost: config.argon2TimeCost,
    parallelism: config.argon2Parallelism,
  });
}

/** Never throws -- a malformed stored hash (shouldn't happen, but this is an
 * auth boundary) fails closed as "wrong password", not an unhandled 500. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
