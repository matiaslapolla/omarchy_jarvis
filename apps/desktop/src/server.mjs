import { createServer } from "node:http";

const GATEWAY = process.env.GATEWAY_URL ?? "http://127.0.0.1:8787";
const PORT = Number(process.env.DESKTOP_PORT ?? 8788);

const html = `<!doctype html><meta charset="utf-8"><title>Jarvis (Phase-1 stub)</title>
<body style="font-family:system-ui;max-width:640px;margin:2rem auto">
<h1>Jarvis — text runtime check</h1>
<input id="q" style="width:80%" placeholder="hola jarvis"><button id="go">send</button>
<pre id="out"></pre>
<script>
go.onclick = async () => {
  const id = crypto.randomUUID();
  const res = await fetch("${GATEWAY}/v1/input", {method:"POST",headers:{"content-type":"application/json"},
    body: JSON.stringify({id, sessionId:"desktop-1", source:"desktop", content: q.value})});
  out.textContent = await res.text();
};
</script>`;

createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" }).end(html);
}).listen(PORT, "127.0.0.1", () => console.log(`desktop stub on http://127.0.0.1:${PORT} -> ${GATEWAY}`));
