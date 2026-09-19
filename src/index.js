// index.js — Worker entry. Two routes: create a room, upgrade to its socket.
// Everything else (round loop, matching, broadcasts) lives in the Room Durable
// Object (room.js) — this file is deliberately thin.

import { Room } from "./room.js";
import { generateRoomCode } from "./game-core.js";

export { Room };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = env.ALLOWED_ORIGIN || "*";
    const corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      const code = generateRoomCode();
      const id = env.ROOMS.idFromName(code);
      const stub = env.ROOMS.get(id);
      const res = await stub.fetch("https://room/create", {
        method: "POST",
        body: JSON.stringify({ code }),
        headers: { "content-type": "application/json" },
      });
      const body = await res.text();
      return new Response(body, {
        status: res.status,
        headers: { ...corsHeaders, "content-type": "application/json" },
      });
    }

    const socketMatch = url.pathname.match(/^\/api\/rooms\/(\d{6})\/socket$/);
    if (socketMatch) {
      const code = socketMatch[1];
      const id = env.ROOMS.idFromName(code);
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "content-type": "application/json" },
      });
    }

    return new Response("not found", { status: 404, headers: corsHeaders });
  },
};
