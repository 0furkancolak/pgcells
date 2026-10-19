/** Imported password hashes: type classification (which runtime can verify them) and non-Bun bcrypt verification. */
import { expect, test } from "bun:test";
import { compare } from "bcryptjs";
import { hashPassword } from "better-auth/crypto";
import { passwordHashKind } from "../../core/tools/import-users";

test("classifies Better Auth scrypt, bcrypt and argon2 hashes per auth runtime", async () => {
  const bcrypt = await Bun.password.hash("secret", "bcrypt");
  const argon2 = await Bun.password.hash("secret", "argon2id");
  expect(passwordHashKind(await hashPassword("secret"))).toBe("scrypt");
  expect(passwordHashKind(bcrypt)).toBe("bcrypt");
  expect(passwordHashKind(bcrypt.replace("$2b$", "$2y$"), "workers")).toBe("bcrypt");
  expect(passwordHashKind(argon2)).toBe("argon2");
  expect(passwordHashKind(argon2, "workers")).toBe("unsupported");
  for (const hash of ["5f4dcc3b5aa765d61d8327deb882cf99", "pbkdf2_sha256$260000$salt$hash", "$2b$10$short"]) expect(passwordHashKind(hash)).toBe("unsupported");
});

test("bcryptjs (used without Bun) verifies Bun bcrypt hashes, including PHP $2y$ written as $2b$", async () => {
  const hash = await Bun.password.hash("secret", "bcrypt");
  expect(await compare("secret", hash)).toBe(true);
  expect(await compare("wrong", hash)).toBe(false);
  expect(await compare("secret", hash.replace("$2b$", "$2y$").replace(/^\$2y\$/, "$2b$"))).toBe(true);
});
