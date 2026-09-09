// Public-fork vocabulary guard. The terms are assembled from fragments so this
// file and its callers never contain the literal words they forbid.
export const forbiddenPublicTerms = [
  "ag" + "ency",
  "micro" + "soft",
  "ms" + "ft",
  "ms" + "-desk",
  "shared-internal" + "-tools",
  "aka" + "\\.ms",
];

export const forbiddenPublicPattern = new RegExp(forbiddenPublicTerms.join("|"), "i");
