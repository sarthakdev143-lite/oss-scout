/**
 * Plugin module for both opencode lines. ONLY a default export: opencode V1 treats every named
 * export of a plugin module as a plugin function.
 *  - V2 (2.x) requires `{ id, setup }` and calls `setup(ctx)`.
 *  - V1 (>= 1.18.29) sees `id`/`server` on the default object and calls only `server(input, options)`.
 */
import { serverV1 } from "./v1.ts"
import { setupV2 } from "./v2.ts"

const plugin = { id: "oss-scout", setup: setupV2, server: serverV1 }

export default plugin
