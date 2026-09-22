// Shared data rules: constants and query fragments that more than one module
// needs. Kept out of grid.js so the server does not depend on the client
// application to know what a referral is worth.

// World Class pays per referral they actually book — not per referral sent.
export const REFERRAL_FEE = 25;
