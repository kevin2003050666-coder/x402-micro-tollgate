import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Runtime package version — keep MCP / discovery strings honest with package.json. */
export const PACKAGE_VERSION: string = (
  require("../package.json") as { version: string }
).version;
