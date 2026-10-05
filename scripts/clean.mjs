import { rm } from "node:fs/promises";

const targets = [
  "apps/api/dist",
  "apps/web/dist",
  "packages/shared-types/dist",
  "packages/risk-engine/dist",
  "packages/attestor/dist",
  "packages/midnight-adapter/dist",
];

await Promise.all(targets.map((t) => rm(t, { recursive: true, force: true })));
console.log("cleaned dist folders");
