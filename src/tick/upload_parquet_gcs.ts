import "dotenv/config";
import { spawnSync } from "child_process";
import path from "path";

const PARQUET_ROOT = process.env.TICK_PARQUET_DIR ?? path.join("data", "parquet");
const GCS_URI = process.env.TICK_GCS_URI;
const GSUTIL_BIN = process.env.GSUTIL_BIN ?? "gsutil";

function main() {
  if (!GCS_URI) {
    throw new Error("Missing env: TICK_GCS_URI (example: gs://my-bucket/ticks)");
  }

  const args = ["-m", "rsync", "-r", PARQUET_ROOT, GCS_URI];
  const r = spawnSync(GSUTIL_BIN, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (r.status !== 0) {
    throw new Error(`gsutil rsync failed with exit=${r.status}`);
  }

  console.log("[tick-upload] done", { from: PARQUET_ROOT, to: GCS_URI });
}

try {
  main();
} catch (e: any) {
  console.error("[tick-upload] fatal:", e?.message ?? e);
  process.exit(1);
}
