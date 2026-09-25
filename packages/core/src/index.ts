/**
 * @inboxlink/core — shared types and vault crypto helpers.
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Etienne Fokou
 */

export type * from "./types.js";
export { sealSecret, openSecret, randomToken, createPkcePair, newId } from "./crypto.js";
