// harness.mjs — tiny multi-client driver for protocol tests against a running
// `wrangler dev`. Each Client is one simulated player with its own socket.

export const BASE = process.env.MATCHIT_BASE || "http://localhost:8787";
const WS_BASE = BASE.replace(/^http/, "ws");

export async function createRoom() {
  const res = await fetch(BASE + "/api/rooms", { method: "POST" });
  if (!res.ok) throw new Error("create failed: " + res.status);
  return (await res.json()).code;
}

export class Client {
  constructor(name) {
    this.name = name;
    this.pid = null;
    this.state = null;
    this.reveals = [];
    this.errors = [];
    this.closed = false;
    this.closeCode = null;
    this.waiters = [];
  }

  connect(code, pid = this.pid) {
    const qs = new URLSearchParams({ nickname: this.name });
    if (pid) qs.set("pid", pid);
    this.closed = false;
    this.ws = new WebSocket(`${WS_BASE}/api/rooms/${code}/socket?${qs}`);
    this.ws.addEventListener("message", (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === "welcome") this.pid = data.playerId;
      if (data.type === "state") this.state = data;
      if (data.type === "reveal") this.reveals.push(data);
      if (data.type === "error") this.errors.push(data);
      this.flush();
    });
    this.ws.addEventListener("close", (ev) => { this.closed = true; this.closeCode = ev.code; this.flush(); });
    this.ws.addEventListener("error", () => { this.closed = true; this.flush(); });
    return this.waitFor(() => this.pid && this.state, "welcome+state");
  }

  flush() {
    this.waiters = this.waiters.filter((w) => {
      if (w.pred()) { w.resolve(); return false; }
      return true;
    });
  }

  waitFor(pred, label = "condition", ms = 4000) {
    if (pred()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        if (this.waiters.includes(w)) reject(new Error(`${this.name}: timed out waiting for ${label}`));
      }, ms);
    });
  }

  send(payload) { this.ws.send(JSON.stringify(payload)); }
  close() { this.ws.close(); }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
