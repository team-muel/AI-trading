import { spawnSync } from "child_process";

function quoteSql(s: string) {
  return `'${s.replace(/'/g, "''")}'`;
}

function oneLineSql(sql: string) {
  return sql
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join(" ");
}

export function runDuckdbSql(params: {
  databasePath: string;
  sql: string;
  duckdbBin?: string;
}) {
  const bin = params.duckdbBin ?? process.env.DUCKDB_BIN ?? "duckdb";
  const commandSql = oneLineSql(params.sql);

  const r = spawnSync(bin, [params.databasePath, "-c", commandSql], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || "").trim();
    throw new Error(`duckdb failed: ${msg}`);
  }

  return {
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
  };
}

export function sqlString(s: string) {
  return quoteSql(s);
}
