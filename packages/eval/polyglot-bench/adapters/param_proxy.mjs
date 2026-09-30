// A per-row proxy that gives Codex the API parameters protocol v2 fixes and Codex has no setting for.
//
//   node param_proxy.mjs <upstream base URL> <cap> <temperature> <top_p> <port file> <log file>
//
// Protocol v2 holds the output cap, temperature and top_p equal across the three harnesses. The endpoint ends
// reasoning at three quarters of a request's output cap and never without one, so the cap matters most. motifcode
// sends all three itself and OpenCode from its config; codex-cli 0.154 rejects every key that would set
// `max_output_tokens` and sends no temperature or top_p. This adds each of them to a request that lacks it — the cap
// as `max_output_tokens` on /responses and `max_tokens` on /chat/completions — and changes nothing else, nor any
// value a request already carries. Streams are piped, never buffered: the responses route sends nothing while the
// model reasons, for minutes, so there is no idle timeout here either. One JSON line per request goes to the log
// file, naming what was added.
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const [upstreamArg, capArg, temperatureArg, topPArg, portFile, logFile] = process.argv.slice(2);
if (!upstreamArg || !capArg || !temperatureArg || !topPArg || !portFile || !logFile) {
  process.stderr.write("usage: param_proxy.mjs <upstream base URL> <cap> <temperature> <top_p> <port file> <log file>\n");
  process.exit(2);
}
const upstream = new URL(upstreamArg);
const cap = Number(capArg);
const sampling = { temperature: Number(temperatureArg), top_p: Number(topPArg) };
const send = upstream.protocol === "http:" ? httpRequest : httpsRequest;
const log = (entry) => {
  try {
    appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // Evidence only.
  }
};

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = Buffer.concat(chunks);
    const added = {};
    if (req.method === "POST" && body.length > 0) {
      try {
        const json = JSON.parse(body.toString("utf8"));
        const responses = req.url?.endsWith("/responses");
        const chat = req.url?.endsWith("/chat/completions");
        if (responses && json.max_output_tokens == null) added.max_output_tokens = cap;
        if (chat && json.max_tokens == null && json.max_completion_tokens == null) added.max_tokens = cap;
        if (responses || chat) for (const [k, v] of Object.entries(sampling)) if (json[k] == null) added[k] = v;
        if (Object.keys(added).length > 0) body = Buffer.from(JSON.stringify({ ...json, ...added }), "utf8");
      } catch {
        // Not JSON: forwarded untouched.
      }
    }
    const headers = { ...req.headers, host: upstream.host, "content-length": String(body.length) };
    delete headers.connection;
    const basePath = upstream.pathname.replace(/\/$/, "");
    const up = send(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === "http:" ? 80 : 443),
        method: req.method,
        path: `${basePath}${req.url}`,
        headers,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
        answer.on("end", () => log({ path: req.url, added, status: answer.statusCode }));
      },
    );
    up.on("error", (err) => {
      log({ path: req.url, added, error: String(err) });
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(String(err));
    });
    // The client went away: so does the upstream request.
    res.on("close", () => up.destroy());
    up.end(body);
  });
});

server.listen(0, "127.0.0.1", () => {
  writeFileSync(portFile, String(server.address().port));
});
