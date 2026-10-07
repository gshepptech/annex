// Opens Annex in your browser with its key, which the page keeps from then on. Run it once per
// browser (or after the key file is replaced).
//
//   npm run open

import { execFileSync } from "node:child_process";
import { loadOrCreateKey, openLink } from "../server/key.ts";

const port = Number(process.env.ANNEX_PORT ?? 4300);
const link = openLink(port, loadOrCreateKey());
execFileSync("open", [link]);
console.log(`Opened Annex at http://127.0.0.1:${port} with its key.`);
