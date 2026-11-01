import { randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalJson, sha256Hex } from "./canonical";

/**
 * Salted hash commitment: H(salt || canonical(value)).
 * The commitment is public; the value and salt stay private until the owner
 * chooses to disclose one field (selective disclosure).
 */
export interface Opening {
  value: unknown;
  salt: string; // hex, 16 bytes
}

export function commit(value: unknown, salt: string = randomBytes(16).toString("hex")): {
  commitment: string;
  opening: Opening;
} {
  return { commitment: commitmentOf(value, salt), opening: { value, salt } };
}

export function commitmentOf(value: unknown, salt: string): string {
  return sha256Hex(`${salt}:${canonicalJson(value)}`);
}

export function openingMatches(commitment: string, opening: Opening): boolean {
  const expected = Buffer.from(commitmentOf(opening.value, opening.salt), "hex");
  const actual = Buffer.from(commitment, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
