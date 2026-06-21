// tsc 不产出 .css；本脚本在 tsc 后由编译产物生成 token CSS 到 dist。
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildTokensCss } from "../dist/design-system/css.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../dist/design-system/tokens.css");
writeFileSync(out, buildTokensCss(), "utf8");
console.log(`wrote ${out}`);
