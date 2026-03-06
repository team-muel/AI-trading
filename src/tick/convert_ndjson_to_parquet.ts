import "dotenv/config";
import fs from "fs";
import path from "path";
import { runDuckdbSql, sqlString } from "./duckdb_cli";

const RAW_ROOT = process.env.TICK_RAW_DIR ?? path.join("data", "raw");
const PARQUET_ROOT = process.env.TICK_PARQUET_DIR ?? path.join("data", "parquet");
const ARCHIVE_ROOT = process.env.TICK_RAW_ARCHIVE_DIR ?? path.join("data", "raw-archived");
const ARCHIVE_ENABLED = (process.env.TICK_ARCHIVE_AFTER_CONVERT ?? "true") === "true";
const DUCKDB_FILE = process.env.TICK_DUCKDB_FILE ?? path.join("data", "ticks.duckdb");

function listHourDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];

  const out: string[] = [];
  const symbols = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const s of symbols) {
    const symbolDir = path.join(root, s.name);
    const dates = fs.readdirSync(symbolDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const d of dates) {
      const dateDir = path.join(symbolDir, d.name);
      const hours = fs.readdirSync(dateDir, { withFileTypes: true }).filter((x) => x.isDirectory());
      for (const h of hours) {
        out.push(path.join(dateDir, h.name));
      }
    }
  }
  return out;
}

function hasNdjson(dir: string) {
  return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith(".ndjson"));
}

function moveDirContents(fromDir: string, toDir: string) {
  fs.mkdirSync(toDir, { recursive: true });
  const files = fs.readdirSync(fromDir);
  for (const f of files) {
    const src = path.join(fromDir, f);
    const dst = path.join(toDir, f);
    if (fs.existsSync(dst)) fs.unlinkSync(dst);
    fs.renameSync(src, dst);
  }
}

function removeEmptyAncestors(dir: string, stopAt: string) {
  let cur = dir;
  const stop = path.resolve(stopAt);

  while (path.resolve(cur).startsWith(stop)) {
    if (!fs.existsSync(cur)) break;
    const files = fs.readdirSync(cur);
    if (files.length > 0) break;
    fs.rmdirSync(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
}

function normalizeSlash(p: string) {
  return p.replace(/\\/g, "/");
}

function toArchivePath(hourDir: string) {
  const rel = path.relative(RAW_ROOT, hourDir);
  return path.join(ARCHIVE_ROOT, rel);
}

function convertHourDir(hourDir: string) {
  const glob = normalizeSlash(path.join(hourDir, "*.ndjson"));

  const sql = `
    INSTALL json;
    LOAD json;
    COPY (
      SELECT
        CAST(exchange AS VARCHAR) AS exchange,
        CAST(symbol AS VARCHAR) AS symbol,
        CAST(market_id AS VARCHAR) AS market_id,
        CAST(ts_ms AS BIGINT) AS ts_ms,
        CAST(ts_iso AS VARCHAR) AS ts_iso,
        CAST(exchange_trade_id AS VARCHAR) AS exchange_trade_id,
        CAST(price AS DOUBLE) AS price,
        CAST(qty AS DOUBLE) AS qty,
        CAST(side AS VARCHAR) AS side,
        CAST(date AS VARCHAR) AS date,
        CAST(hour AS VARCHAR) AS hour
      FROM read_ndjson_auto(${sqlString(glob)})
    ) TO ${sqlString(normalizeSlash(PARQUET_ROOT))}
      (FORMAT PARQUET, COMPRESSION ZSTD, PARTITION_BY (symbol, date, hour), OVERWRITE_OR_IGNORE 1);
  `;

  runDuckdbSql({ databasePath: DUCKDB_FILE, sql });
}

function main() {
  fs.mkdirSync(PARQUET_ROOT, { recursive: true });
  fs.mkdirSync(path.dirname(DUCKDB_FILE), { recursive: true });

  const hourDirs = listHourDirs(RAW_ROOT).filter(hasNdjson).sort();
  if (hourDirs.length === 0) {
    console.log("[tick-convert] no ndjson files found");
    return;
  }

  console.log(`[tick-convert] start hourDirs=${hourDirs.length}`);

  let converted = 0;
  for (const dir of hourDirs) {
    convertHourDir(dir);
    converted += 1;

    if (ARCHIVE_ENABLED) {
      const to = toArchivePath(dir);
      moveDirContents(dir, to);
      removeEmptyAncestors(dir, RAW_ROOT);
    }

    console.log(`[tick-convert] converted ${converted}/${hourDirs.length} ${dir}`);
  }

  console.log(`[tick-convert] done converted=${converted}`);
}

try {
  main();
} catch (e: any) {
  console.error("[tick-convert] fatal:", e?.message ?? e);
  process.exit(1);
}
