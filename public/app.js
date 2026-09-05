const CHUNK = 256 * 1024;
const READ = 2 * 1024 * 1024;
const HIGH_WATER = 8 * 1024 * 1024;
const UI_MS = 250;
const ACCEPT_MS = 3000;
const ICE = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
  ],
};

const $ = (id) => document.getElementById(id);

const ui = {
  code: $("room-code"),
  qr: $("qr"),
  ticket: $("ticket"),
  ticketSub: $("ticket-sub"),
  stage: $("stage"),
  status: $("top-status"),
  hint: $("path-hint"),
  foot: $("foot-note"),
  me: $("me-name"),
  them: $("them-name"),
  rail: $("rail"),
  drop: $("drop"),
  transfers: $("transfers"),
  toastEl: $("toast"),
  join: $("join-code"),
};

let joinUrl = "";
let roomCode = "";
let myName = deviceName();
let remoteName = "";
let socket = null;
let link = null;
let pipe = null;
let reconnectTimer = 0;
let pendingSignals = [];

ui.me.textContent = myName;

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  if (/Win/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return "Aparelho";
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function displayName(file) {
  return file.relativePath || file.webkitRelativePath || file.name;
}

function fileKey(file) {
  return `${displayName(file)}:${file.size}:${file.lastModified}`;
}

function toast(text) {
  ui.toastEl.hidden = false;
  ui.toastEl.textContent = text;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    ui.toastEl.hidden = true;
  }, 2600);
}

function setStatus(state, text) {
  ui.status.dataset.state = state;
  ui.status.textContent = text;
}

function setPath(kind) {
  ui.rail.dataset.path = kind;
  if (kind === "lan") {
    ui.hint.textContent = "Mesma rede · caminho rápido";
    ui.foot.textContent = "Os dois estão no mesmo Wi‑Fi. O arquivo vai direto, sem nuvem.";
  } else if (kind === "net") {
    ui.hint.textContent = "Pela internet · limitado pelo upload de quem envia";
    ui.foot.textContent = "Não estão na mesma rede. Ainda sem nuvem, mas a velocidade é a do upload.";
  } else if (kind === "busy") {
    ui.rail.dataset.path = "busy";
  } else {
    ui.hint.textContent = "Nada fica salvo. Direto de um aparelho ao outro.";
  }
}

async function detectPath(pc) {
  const stats = await pc.getStats();
  const local = new Map();
  const remote = new Map();
  let pair;
  stats.forEach((r) => {
    if (r.type === "local-candidate") local.set(r.id, r);
    if (r.type === "remote-candidate") remote.set(r.id, r);
    if (r.type === "candidate-pair" && r.state === "succeeded") pair = r;
  });
  if (!pair) return "unknown";
  const a = local.get(pair.localCandidateId);
  const b = remote.get(pair.remoteCandidateId);
  if (a?.candidateType === "host" && b?.candidateType === "host") return "lan";
  return "net";
}

class MemorySink {
  constructor(meta, start = 0) {
    this.meta = meta;
    this.parts = [];
    this.received = start;
    this.kind = "mem";
  }

  write(buf) {
    this.parts.push(buf);
    this.received += buf.byteLength;
  }

  async toBlob() {
    return new Blob(this.parts, { type: this.meta.mime || "application/octet-stream" });
  }
}

class OpfsSink {
  constructor(meta, handle, writable, start) {
    this.meta = meta;
    this.handle = handle;
    this.writable = writable;
    this.received = start;
    this.kind = "opfs";
  }

  static async open(meta, start = 0) {
    const root = await navigator.storage.getDirectory();
    const key = String(meta.id || meta.fileId || meta.name || "file");
    const handle = await root.getFileHandle(`passe-${key.replace(/[^\w.-]+/g, "_")}`, {
      create: true,
    });
    const writable = await handle.createWritable({ keepExistingData: start > 0 });
    if (start > 0) await writable.seek(start);
    return new OpfsSink(meta, handle, writable, start);
  }

  async write(buf) {
    await this.writable.write(buf);
    this.received += buf.byteLength;
  }

  async toBlob() {
    await this.writable.close();
    this.writable = null;
    return this.handle.getFile();
  }
}

async function openSink(meta, start = 0) {
  if (meta.size > 32 * 1024 * 1024 && navigator.storage?.getDirectory) {
    try {
      return await OpfsSink.open(meta, start);
    } catch {
      /* cai no memória */
    }
  }
  return new MemorySink(meta, start);
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name.split("/").pop();
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8_000);
}

const rows = new Map();

function paintRow(rec, row) {
  rec.painted = performance.now();
  rec.pending = null;
  rec.li.classList.toggle("recv", row.dir === "recv");
  rec.li.classList.toggle("ok", row.state === "ok");
  rec.li.classList.toggle("bad", row.state === "bad");
  rec.title.textContent = row.name;
  rec.dir.textContent =
    row.state === "ok" ? "pronto" : row.state === "bad" ? "falhou" : row.dir === "send" ? "enviando" : "recebendo";
  const pct = row.size ? Math.min(100, (row.done / row.size) * 100) : 0;
  rec.bar.style.width = `${pct}%`;
  const speed = row.speed ? ` · ${bytes(row.speed)}/s` : "";
  const eta =
    row.speed && row.size > row.done ? ` · ~${Math.max(1, Math.round((row.size - row.done) / row.speed))}s` : "";
  rec.meta.textContent = `${bytes(row.done)} / ${bytes(row.size)}${speed}${eta}`;
}

function renderItem(row, force = false) {
  let rec = rows.get(row.key);
  if (!rec) {
    const li = document.createElement("li");
    li.className = "item";
    li.innerHTML = `<div><h3></h3><p class="meta"></p></div><span class="dir"></span><div class="bar"><i></i></div>`;
    rec = {
      li,
      title: li.querySelector("h3"),
      meta: li.querySelector(".meta"),
      dir: li.querySelector(".dir"),
      bar: li.querySelector("i"),
      painted: 0,
      pending: null,
      raf: 0,
    };
    rows.set(row.key, rec);
    ui.transfers.prepend(li);
  }
  if (!force && row.state === "run" && rec.painted && performance.now() - rec.painted < UI_MS) {
    rec.pending = row;
    if (!rec.raf) {
      rec.raf = requestAnimationFrame(() => {
        rec.raf = 0;
        if (rec.pending) paintRow(rec, rec.pending);
      });
    }
    return;
  }
  paintRow(rec, row);
}

class Pipe {
  constructor(channel, onBusy) {
    this.ch = channel;
    this.ch.binaryType = "arraybuffer";
    this.onBusy = onBusy;
    this.queue = [];
    this.sending = false;
    this.waitingAccept = false;
    this.acceptTimer = 0;
    this.recv = null;
    this.partials = new Map();
    this.inbox = Promise.resolve();
    this.ch.onmessage = (ev) => {
      const data = ev.data;
      this.inbox = this.inbox.then(() => this.onMessage(data)).catch((err) => {
        console.warn("passe: mensagem", err);
      });
    };
  }

  sendJson(msg) {
    if (this.ch.readyState === "open") this.ch.send(JSON.stringify(msg));
  }

  enqueue(files) {
    for (const file of files) {
      this.queue.push({
        id: fileKey(file),
        name: displayName(file),
        size: file.size,
        mime: file.type,
        file,
      });
    }
    this.offer();
  }

  offer() {
    if (this.sending || !this.queue.length || this.ch.readyState !== "open") return;
    this.sending = true;
    this.waitingAccept = true;
    this.batch = this.queue.splice(0, this.queue.length);
    this.sendJson({
      type: "offer-files",
      files: this.batch.map(({ file, ...meta }) => meta),
    });
    this.onBusy?.(true);
    clearTimeout(this.acceptTimer);
    this.acceptTimer = setTimeout(() => {
      if (!this.waitingAccept) return;
      this.waitingAccept = false;
      this.sending = false;
      this.onBusy?.(false);
      console.warn("passe: timeout accept-files");
      toast("O outro aparelho não aceitou o envio. Tenta de novo.");
    }, ACCEPT_MS);
  }

  resumeMap() {
    const resume = {};
    for (const [id, sink] of this.partials) resume[id] = sink.received;
    return resume;
  }

  async onMessage(data) {
    if (typeof data === "string") {
      const msg = JSON.parse(data);
      if (msg.type === "hello") {
        remoteName = msg.name || remoteName;
        ui.them.textContent = remoteName;
        this.sendJson({ type: "resume-state", resume: this.resumeMap() });
        return;
      }
      if (msg.type === "resume-state") {
        this.remoteResume = msg.resume || {};
        return;
      }
      if (msg.type === "offer-files") {
        for (const meta of msg.files) await this.prepareRecv(meta);
        this.sendJson({ type: "accept-files", resume: this.resumeMap() });
        return;
      }
      if (msg.type === "accept-files") {
        this.waitingAccept = false;
        clearTimeout(this.acceptTimer);
        this.sendBatch(msg.resume || {}).catch((err) => {
          console.warn("passe: lote", err);
        });
        return;
      }
      if (msg.type === "file-start") {
        this.beginRecv(msg);
        return;
      }
      if (msg.type === "file-end") {
        await this.finishRecv(msg);
        return;
      }
      return;
    }

    if (!this.recv) {
      console.warn("passe: chunk sem file-start");
      return;
    }
    const buf = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
    const written = this.recv.sink.write(buf);
    if (written && typeof written.then === "function") await written;
    this.tickRecv();
  }

  async prepareRecv(meta) {
    const start = this.partials.get(meta.id)?.received || 0;
    renderItem(
      { key: `r:${meta.id}`, name: meta.name, size: meta.size, done: start, dir: "recv", state: "run" },
      true,
    );
    if (this.partials.has(meta.id)) return;
    const sink = await openSink({ ...meta, fileId: meta.id }, start);
    this.partials.set(meta.id, sink);
  }

  beginRecv(msg) {
    let sink = this.partials.get(msg.fileId);
    if (!sink) {
      sink = new MemorySink(msg, msg.offset || 0);
      this.partials.set(msg.fileId, sink);
    }
    this.recv = {
      meta: msg,
      sink,
      t0: performance.now(),
      last: sink.received,
    };
    this.onBusy?.(true);
    console.log("passe: file-start", msg.name, msg.size);
    renderItem(
      { key: `r:${msg.fileId}`, name: msg.name, size: msg.size, done: sink.received, dir: "recv", state: "run" },
      true,
    );
  }

  tickRecv() {
    const r = this.recv;
    const now = performance.now();
    const dt = (now - r.t0) / 1000;
    renderItem({
      key: `r:${r.meta.fileId}`,
      name: r.meta.name,
      size: r.meta.size,
      done: r.sink.received,
      speed: dt > 0.2 ? (r.sink.received - r.last) / dt : 0,
      dir: "recv",
      state: "run",
    });
    if (dt > UI_MS / 1000) {
      r.t0 = now;
      r.last = r.sink.received;
    }
  }

  async finishRecv(msg) {
    const r = this.recv;
    if (!r) {
      console.warn("passe: file-end sem file-start", msg.fileId);
      return;
    }
    const got = r.sink.received;
    const expect = r.meta.size;
    console.log("passe: file-end", r.meta.name, got, "/", expect);
    try {
      if (got !== expect) {
        renderItem(
          { key: `r:${msg.fileId}`, name: r.meta.name, size: expect, done: got, dir: "recv", state: "bad" },
          true,
        );
        toast("Arquivo incompleto. Pede pra mandar de novo.");
        this.partials.delete(msg.fileId);
        this.recv = null;
        this.onBusy?.(false);
        return;
      }
      const blob = await r.sink.toBlob();
      saveBlob(blob, r.meta.name);
      this.partials.delete(msg.fileId);
      renderItem(
        { key: `r:${msg.fileId}`, name: r.meta.name, size: expect, done: expect, dir: "recv", state: "ok" },
        true,
      );
    } catch (err) {
      console.warn("passe: finish falhou", err);
      renderItem(
        { key: `r:${msg.fileId}`, name: r.meta.name, size: expect, done: got, dir: "recv", state: "bad" },
        true,
      );
      toast("Não deu pra salvar o arquivo.");
    }
    this.recv = null;
    this.onBusy?.(false);
  }

  async sendBatch(resume) {
    for (const item of this.batch) {
      try {
        await this.sendFile(item, resume[item.id] || 0);
      } catch (err) {
        console.warn("passe: send falhou", item.name, err);
        renderItem(
          { key: `s:${item.id}`, name: item.name, size: item.size, done: 0, dir: "send", state: "bad" },
          true,
        );
        toast(`Não deu pra enviar ${item.name}`);
      }
    }
    this.sending = false;
    this.onBusy?.(false);
    this.offer();
  }

  waitBuffer() {
    this.ch.bufferedAmountLowThreshold = HIGH_WATER / 2;
    if (this.ch.bufferedAmount <= HIGH_WATER) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.ch.removeEventListener("bufferedamountlow", done);
        resolve();
      };
      this.ch.addEventListener("bufferedamountlow", done);
      if (this.ch.bufferedAmount <= HIGH_WATER / 2) done();
    });
  }

  async sendFile(item, start) {
    const offset0 = Math.min(item.size, Math.floor(start / CHUNK) * CHUNK);
    let offset = offset0;
    this.sendJson({
      type: "file-start",
      fileId: item.id,
      name: item.name,
      size: item.size,
      mime: item.mime,
      offset: offset0,
    });
    console.log("passe: send", item.name, item.size, "from", offset0);
    renderItem(
      { key: `s:${item.id}`, name: item.name, size: item.size, done: offset0, dir: "send", state: "run" },
      true,
    );

    let t0 = performance.now();
    let last = offset;
    const readBlock = (off) => item.file.slice(off, Math.min(item.size, off + READ)).arrayBuffer();
    let prefetch = offset < item.size ? readBlock(offset) : null;

    while (offset < item.size) {
      if (this.ch.readyState !== "open") throw new Error("conexao");
      await this.waitBuffer();
      const block = await prefetch;
      const next = offset + block.byteLength;
      prefetch = next < item.size ? readBlock(next) : null;
      const bytes = new Uint8Array(block);
      for (let i = 0; i < bytes.byteLength; i += CHUNK) {
        if (this.ch.readyState !== "open") throw new Error("conexao");
        await this.waitBuffer();
        const end = Math.min(bytes.byteLength, i + CHUNK);
        this.ch.send(bytes.buffer.slice(bytes.byteOffset + i, bytes.byteOffset + end));
        offset += end - i;
        const now = performance.now();
        const dt = (now - t0) / 1000;
        if (dt >= UI_MS / 1000 || offset >= item.size) {
          renderItem({
            key: `s:${item.id}`,
            name: item.name,
            size: item.size,
            done: offset,
            speed: dt > 0.2 ? (offset - last) / dt : 0,
            dir: "send",
            state: "run",
          });
          t0 = now;
          last = offset;
        }
      }
    }

    this.sendJson({ type: "file-end", fileId: item.id, size: item.size });
    console.log("passe: file-end sent", item.name, item.size);
    renderItem(
      { key: `s:${item.id}`, name: item.name, size: item.size, done: item.size, dir: "send", state: "ok" },
      true,
    );
  }
}

class Link {
  constructor({ initiator, sendSignal, onChannel, onState }) {
    this.sendSignal = sendSignal;
    this.onChannel = onChannel;
    this.onState = onState;
    this.pc = new RTCPeerConnection(ICE);
    this.iceWait = [];
    this.pc.onicecandidate = (e) => {
      if (e.candidate) sendSignal({ kind: "ice", candidate: e.candidate });
    };
    this.pc.onconnectionstatechange = () => onState(this.pc.connectionState);
    this.pc.ondatachannel = (e) => this.hook(e.channel);

    if (initiator) {
      const ch = this.pc.createDataChannel("passe", { ordered: true });
      this.hook(ch);
      this.offer();
    }
  }

  hook(channel) {
    channel.binaryType = "arraybuffer";
    if (channel.readyState === "open") this.onChannel(channel);
    else channel.onopen = () => this.onChannel(channel);
  }

  async offer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.sendSignal({ kind: "sdp", sdp: this.pc.localDescription });
  }

  async ingest(data) {
    if (data.kind === "sdp") {
      await this.pc.setRemoteDescription(data.sdp);
      for (const c of this.iceWait) await this.pc.addIceCandidate(c);
      this.iceWait = [];
      if (data.sdp.type === "offer") {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.sendSignal({ kind: "sdp", sdp: this.pc.localDescription });
      }
      return;
    }
    if (data.kind === "ice") {
      if (!this.pc.remoteDescription) this.iceWait.push(data.candidate);
      else await this.pc.addIceCandidate(data.candidate);
    }
  }

  async path() {
    return detectPath(this.pc);
  }

  close() {
    try {
      this.pc.close();
    } catch {
      /* já fechou */
    }
  }
}

function showRoom(info) {
  roomCode = info.code;
  joinUrl = info.joinUrl;
  ui.code.textContent = info.code;
  ui.qr.src = info.qrDataUrl;
  history.replaceState(null, "", `/?sala=${info.code}`);
}

function liveUi() {
  ui.ticket.classList.add("live");
  ui.stage.hidden = false;
  ui.them.textContent = remoteName || "Outro aparelho";
}

function resetLink() {
  pipe = null;
  if (link) {
    link.close();
    link = null;
  }
}

function bindChannel(channel) {
  pipe = new Pipe(channel, (busy) => {
    if (busy) setPath("busy");
    else if (link) link.path().then(setPath);
  });
  pipe.sendJson({ type: "hello", name: myName });
  liveUi();
  setStatus("on", "conectado");
  if (link) link.path().then(setPath);
}

function startRtc(initiator) {
  resetLink();
  setStatus("wait", "conectando");
  link = new Link({
    initiator,
    sendSignal: (data) => socket?.send(JSON.stringify({ type: "signal", data })),
    onChannel: bindChannel,
    onState: (state) => {
      if (state === "connected") setStatus("on", "conectado");
      if (state === "failed" || state === "disconnected") {
        setStatus("bad", "caiu");
        setPath("unknown");
      }
    },
  });
  for (const data of pendingSignals) link.ingest(data);
  pendingSignals = [];
}

function connectSocket() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}`);

  socket.onopen = () => {
    const want = new URLSearchParams(location.search).get("sala");
    if (want) socket.send(JSON.stringify({ type: "join", code: want, name: myName }));
    else socket.send(JSON.stringify({ type: "create", name: myName }));
  };

  socket.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "created") {
      showRoom(msg);
      setStatus("wait", "aguardando o outro");
      ui.ticketSub.textContent = "Abre no outro aparelho e aponta a câmera";
      return;
    }
    if (msg.type === "joined") {
      showRoom(msg);
      remoteName = msg.remoteName || "";
      ui.them.textContent = remoteName || "Outro aparelho";
      setStatus("wait", "conectando");
      ui.ticketSub.textContent = "Achou a sala. Abrindo o túnel…";
      if (!msg.initiator) startRtc(false);
      return;
    }
    if (msg.type === "peer") {
      remoteName = msg.remoteName || "";
      ui.them.textContent = remoteName || "Outro aparelho";
      if (msg.initiator) startRtc(true);
      return;
    }
    if (msg.type === "peer-name") {
      remoteName = msg.remoteName;
      ui.them.textContent = remoteName;
      return;
    }
    if (msg.type === "signal") {
      if (link) link.ingest(msg.data);
      else pendingSignals.push(msg.data);
      return;
    }
    if (msg.type === "peer-left") {
      pendingSignals = [];
      resetLink();
      ui.stage.hidden = true;
      ui.ticket.classList.remove("live");
      setStatus("wait", "o outro saiu");
      setPath("unknown");
      ui.ticketSub.textContent = "Sala ainda aberta. Espera alguém entrar de novo.";
      return;
    }
    if (msg.type === "missing") {
      toast("Sala não existe. Criei uma nova pra você.");
      socket.send(JSON.stringify({ type: "create", name: myName }));
      return;
    }
    if (msg.type === "full") {
      toast("Essa sala já está com duas pessoas.");
      socket.send(JSON.stringify({ type: "create", name: myName }));
      return;
    }
    if (msg.type === "expired") {
      toast("Sala expirou.");
      socket.send(JSON.stringify({ type: "create", name: myName }));
    }
  };

  socket.onclose = () => {
    setStatus("bad", "servidor caiu");
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectSocket, 1200);
  };
}

async function collectDropped(dt) {
  const files = [];
  const items = [...(dt.items || [])];
  if (items.some((i) => i.webkitGetAsEntry)) {
    for (const item of items) {
      const entry = item.webkitGetAsEntry?.();
      if (entry) await walk(entry, files);
      else if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    return files;
  }
  return [...dt.files];
}

async function walk(entry, out, prefix = "") {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    file.relativePath = prefix + file.name;
    out.push(file);
    return;
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    const all = [];
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      all.push(...batch);
    }
    for (const child of all) await walk(child, out, `${prefix}${entry.name}/`);
  }
}

function sendFiles(files) {
  const list = [...files].filter((f) => f && f.size >= 0 && f.name !== ".DS_Store");
  if (!list.length) return;
  if (!pipe || pipe.ch.readyState !== "open") {
    toast("Espera os dois aparelhos conectarem.");
    return;
  }
  pipe.enqueue(list);
}

$("copy-code").onclick = async () => {
  if (!roomCode) return;
  await navigator.clipboard.writeText(roomCode);
  toast("Código copiado");
};

$("copy-link").onclick = async () => {
  if (!joinUrl) return;
  await navigator.clipboard.writeText(joinUrl);
  toast("Link copiado · abre no outro aparelho");
};

$("join-form").onsubmit = (e) => {
  e.preventDefault();
  const code = ui.join.value.trim().toUpperCase();
  if (!code || !socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "join", code, name: myName }));
};

$("pick-files").onclick = (e) => {
  e.preventDefault();
  e.stopPropagation();
  $("file-input").click();
};

$("pick-folder").onclick = (e) => {
  e.preventDefault();
  e.stopPropagation();
  $("folder-input").click();
};

$("file-input").onchange = () => {
  sendFiles($("file-input").files);
  $("file-input").value = "";
};

$("folder-input").onchange = () => {
  sendFiles($("folder-input").files);
  $("folder-input").value = "";
};

ui.drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  ui.drop.classList.add("over");
});

ui.drop.addEventListener("dragleave", () => ui.drop.classList.remove("over"));

ui.drop.addEventListener("drop", async (e) => {
  e.preventDefault();
  ui.drop.classList.remove("over");
  sendFiles(await collectDropped(e.dataTransfer));
});

window.addEventListener("beforeunload", (e) => {
  if (pipe?.sending || pipe?.recv) {
    e.preventDefault();
    e.returnValue = "";
  }
});

connectSocket();
