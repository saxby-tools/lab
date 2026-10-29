// Offline security scan for bake-off answers. FOSS only:
// eslint (MIT), typescript-eslint (MIT), eslint-plugin-security
// (Apache-2.0). No network at run time.

import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";

// ---- Crypto misuse the plugin does not cover --------------------------

// Each entry is an AST selector and the message ESLint reports. They
// match string literals and calls, so they flag the choice, not the
// spelling of a variable.
const CRYPTO_MISUSE = [
  {
    selector: "Literal[value=/^(MD5|SHA-1|SHA1)$/i]",
    message: "crypto/weak-hash: MD5 or SHA-1 named",
  },
  {
    selector: "Literal[value=/^AES-(CBC|CTR)$/i]",
    message: "crypto/unauthenticated-cipher: AES without integrity",
  },
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
    message: "crypto/math-random: Math.random is not a secure source",
  },
  {
    selector: "Literal[value=/^none$/i]",
    message: "crypto/alg-none: the 'none' algorithm is named",
  },
];

export default [
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    plugins: { security },
    rules: {
      ...security.configs.recommended.rules,
      "no-restricted-syntax": ["warn", ...CRYPTO_MISUSE],
    },
  },
];
