// Renders media/logo.svg to media/icon.png (the extension's marketplace icon).
// Usage: npm run icon

import { readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const svg = readFileSync(new URL("../media/logo.svg", import.meta.url));
const png = new Resvg(svg, { fitTo: { mode: "width", value: 256 } }).render().asPng();
writeFileSync(new URL("../media/icon.png", import.meta.url), png);
console.log(`wrote media/icon.png (${png.length} bytes)`);
