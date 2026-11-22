// A @netlify/database look-alike that sends the API's real SQL to a local Postgres through psql.
// Values are inlined as escaped literals (test double only; the real client uses bound parameters).
import { spawn } from "node:child_process";

class Session {
  constructor() {
    this.p = spawn("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=0"], { stdio: ["pipe", "pipe", "pipe"] });
    this.out = ""; this.err = ""; this.cur = null; this.chain = Promise.resolve();
    this.p.stdout.on("data", (d) => { this.out += d; this.tick(); });
    this.p.stderr.on("data", (d) => { this.err += d; this.tick(); });
  }
  tick() {
    const c = this.cur;
    if (!c || !this.out.includes(c.mark) || !this.err.includes(c.mark)) return;
    this.cur = null;
    const out = this.out.replace(c.mark, "").trim(), err = this.err.replace(c.mark, "").trim();
    this.out = ""; this.err = "";
    /ERROR:/.test(err) ? c.reject(new Error(err)) : c.resolve(out);
  }
  run(sql) {
    const job = this.chain.then(() => new Promise((resolve, reject) => {
      const mark = "@@" + Math.random().toString(36).slice(2) + "@@";
      this.cur = { mark, resolve, reject };
      this.p.stdin.write(sql + ";\n\\echo " + mark + "\n\\warn " + mark + "\n");
    }));
    this.chain = job.catch(() => {});
    return job;
  }
  close() { try { this.p.stdin.end(); } catch {} }
}

const lit = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return v.length ? `ARRAY[${v.map(lit).join(",")}]` : "'{}'";
  if (v && typeof v === "object" && "__raw" in v) return v.__raw;
  return `'${String(v).replace(/'/g, "''")}'`;
};
const wrap = (sql) => {
  const t = sql.trim().replace(/;+$/, "");
  if (/^select\b/i.test(t)) return `SELECT coalesce(json_agg(q),'[]'::json) FROM (${t}) q`;
  if (/\breturning\b/i.test(t)) return `WITH q AS (${t}) SELECT coalesce(json_agg(q),'[]'::json) FROM q`;
  return t;
};
const exec = async (session, sql) => {
  const text = await session.run(wrap(sql));
  return text ? JSON.parse(text) : [];
};

const sessions = [];
const main = new Session();
sessions.push(main);
export const endAll = () => sessions.forEach((s) => s.close());

const sql = (strings, ...vals) => exec(main, strings.reduce((a, s, i) => a + s + (i < vals.length ? lit(vals[i]) : ""), ""));
sql.raw = (s) => ({ __raw: s });

export const getDatabase = () => ({
  sql,
  pool: {
    connect: async () => {
      const s = new Session();
      sessions.push(s);
      return {
        query: async (text, params = []) => {
          let q = text;
          for (let i = params.length; i >= 1; i--) q = q.replaceAll("$" + i, lit(params[i - 1]));
          const rows = await exec(s, q);
          return { rows, rowCount: rows.length };
        },
        release() { s.close(); },
      };
    },
  },
});
