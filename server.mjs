import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import QRCode from "qrcode";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const PORT = Number(process.env.PORT) || 4173;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_TTL_MS = 45 * 60 * 1000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

const rooms = new Map();

function lanIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

function makeCode() {
  for (let i = 0; i < 20; i++) {
    const bytes = randomBytes(4);
    let code = "";
    for (const b of bytes) code += ALPHABET[b % ALPHABET.length];
    if (!rooms.has(code)) return code;
  }
  throw new Error("Não deu pra gerar sala");
}

function publicOrigin(req) {
  const host = String(req.headers.host || `127.0.0.1:${PORT}`);
  const forwarded = req.headers["x-forwarded-proto"];
  const proto = forwarded || (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "http");
  const hostname = host.split(":")[0];
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return `http://${lanIPv4()}:${PORT}`;
  }
  return `${proto}://${host}`;
}

async function joinPayload(code, origin) {
  const joinUrl = `${origin}/?sala=${code}`;
  const qrDataUrl = await QRCode.toDataURL(joinUrl, {
    width: 360,
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#11110e", light: "#f5c518" },
  });
  return { joinUrl, qrDataUrl, lanUrl: origin };
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function otherIn(room, me) {
  return room.peers.find((p) => p.ws !== me);
}

function leave(ws) {
  const code = ws.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;
  room.peers = room.peers.filter((p) => p.ws !== ws);
  ws.roomCode = null;
  const leftover = room.peers[0];
  if (leftover) send(leftover.ws, { type: "peer-left" });
  if (room.peers.length === 0) rooms.delete(code);
}

function touch(room) {
  room.expires = Date.now() + ROOM_TTL_MS;
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.expires < now) {
      for (const p of room.peers) {
        send(p.ws, { type: "expired" });
        p.ws.roomCode = null;
      }
      rooms.delete(code);
    }
  }
}, 60_000).unref();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }

  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const root = path.resolve(PUBLIC);
  const resolved = path.resolve(path.join(PUBLIC, rel));
  const sameDrive = resolved.toLowerCase().startsWith(root.toLowerCase() + path.sep) || resolved.toLowerCase() === root.toLowerCase();
  if (!sameDrive) {
    res.writeHead(403);
    res.end();
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(err.code === "ENOENT" ? 404 : 500);
      res.end(err.code === "ENOENT" ? "Not found" : "Error");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(resolved)] ?? "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000);
heartbeat.unref();

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  ws.roomCode = null;
  ws.peerId = randomBytes(6).toString("hex");
  ws.deviceName = "Aparelho";

  const origin = publicOrigin(req);

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    try {
      if (msg.type === "create") {
        leave(ws);
        const code = makeCode();
        const room = { peers: [{ ws, name: msg.name || "Aparelho" }], expires: 0 };
        touch(room);
        rooms.set(code, room);
        ws.roomCode = code;
        ws.deviceName = msg.name || "Aparelho";
        send(ws, { type: "created", code, peerId: ws.peerId, ...(await joinPayload(code, origin)) });
        return;
      }

      if (msg.type === "join") {
        const code = String(msg.code || "").trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          send(ws, { type: "missing" });
          return;
        }
        if (room.peers.some((p) => p.ws === ws)) return;
        if (room.peers.length >= 2) {
          send(ws, { type: "full" });
          return;
        }
        leave(ws);
        const host = room.peers[0];
        ws.roomCode = code;
        ws.deviceName = msg.name || "Aparelho";
        room.peers.push({ ws, name: ws.deviceName });
        touch(room);
        send(ws, {
          type: "joined",
          code,
          peerId: ws.peerId,
          initiator: false,
          remoteName: host.name,
          ...(await joinPayload(code, origin)),
        });
        send(host.ws, { type: "peer", initiator: true, remoteName: ws.deviceName });
        return;
      }

      if (msg.type === "signal") {
        const room = rooms.get(ws.roomCode);
        const dest = room && otherIn(room, ws);
        if (dest) send(dest.ws, { type: "signal", data: msg.data });
        return;
      }

      if (msg.type === "rename") {
        ws.deviceName = String(msg.name || "Aparelho").slice(0, 40);
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        const me = room.peers.find((p) => p.ws === ws);
        if (me) me.name = ws.deviceName;
        const dest = otherIn(room, ws);
        if (dest) send(dest.ws, { type: "peer-name", remoteName: ws.deviceName });
        return;
      }
    } catch (err) {
      send(ws, { type: "error", message: err.message || "Falha no servidor" });
    }
  });

  ws.on("close", () => leave(ws));
  ws.on("error", () => leave(ws));
});

server.listen(PORT, () => {
  const ip = lanIPv4();
  console.log(`Passe no ar`);
  console.log(`  neste PC   http://localhost:${PORT}`);
  console.log(`  na rede    http://${ip}:${PORT}`);
});
