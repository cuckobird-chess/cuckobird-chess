#!/usr/bin/env node

import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const distDirectory = path.join(projectRoot, "dist");

await mkdir(distDirectory, { recursive: true });
await Promise.all([
  cp(path.join(projectRoot, "src", "index.html"), path.join(distDirectory, "index.html")),
  cp(path.join(projectRoot, "src", "styles.css"), path.join(distDirectory, "styles.css")),
  cp(path.join(projectRoot, "logo.png"), path.join(distDirectory, "logo.png"))
]);
