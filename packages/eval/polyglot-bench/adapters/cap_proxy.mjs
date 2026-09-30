// A per-row proxy that gives Codex the output cap it has no setting for.
//
//   node cap_proxy.mjs <upstream base URL> <cap> <port file> <log file>
//
// The endpoint ends reasoning at three quarters of a request's output cap and never without one, so the cap is
// the one API parameter protocol v2 equalizes across the three harnesses. motifcode sends it from a flag and
// OpenCode from its model config; codex-cli 0.154 rejects every key that would set `max_output_tokens`. This adds
// the cap to a request that has none — `max_output_tokens` on /responses, `max_tokens` on /chat/completions — and
// changes nothing else. Streams are piped, never buffered: the responses route sends nothing while the model
// reasons, for minutes, so there is no idle timeout here either. One JSON line per request goes to the log file.
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const [upstreamArg, capArg, portFile, logFile] = process.argv.slice(2);
if (!upstreamArg || !capArg || !portFile || !logFile) {
  process.stderr.write("usage: cap_proxy.mjs <upstream base URL> <cap> <port file> <log file>\n");
  process.exit(2);
}
const upstream = new URL(upstreamArg);
const cap = Number(capArg);
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
    let injected = false;
    if (req.method === "POST" && body.length > 0) {
      try {
        const json = JSON.parse(body.toString("utf8"));
        if (req.url?.endsWith("/responses") && json.max_output_tokens == null) {
          json.max_output_tokens = cap;
          injected = true;
        } else if (req.url?.endsWith("/chat/completions") && json.max_tokens == null && json.max_completion_tokens == null) {
          json.max_tokens = cap;
          injected = true;
        }
        if (injected) body = Buffer.from(JSON.stringify(json), "utf8");
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
        answer.on("end", () => log({ path: req.url, injected, cap: injected ? cap : undefined, status: answer.statusCode }));
      },
    );
    up.on("error", (err) => {
      log({ path: req.url, injected, error: String(err) });
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
