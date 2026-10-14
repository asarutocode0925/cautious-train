import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const TICK_MS = 50;          // 20Hz
const SPEED = 0.3;           // units per tick
const BOUND = 40;            // arena half-size
const HIT_RADIUS = 0.6;
const SHOT_RANGE = 60;
const MAX_HP = 100;
const DAMAGE = 25;
const RESPAWN_MS = 3000;

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const num = (v) => (Number.isFinite(+v) ? +v : 0);

// HTTP: ビルド済みクライアントを配信（本番用）
const app = express();
app.use(express.static(path.join(__dirname, "../dist")));

const http = createServer(app);
const io = new Server(http, { cors: { origin: "*" } });
const players = new Map();

function spawn(p) {
  p.x = (Math.random() - 0.5) * BOUND * 1.5;
  p.z = (Math.random() - 0.5) * BOUND * 1.5;
  p.hp = MAX_HP;
  p.alive = true;
}

io.on("connection", (socket) => {
  const p = { x: 0, z: 0, yaw: 0, hp: MAX_HP, alive: true, kills: 0, input: { x: 0, z: 0 } };
  spawn(p);
  players.set(socket.id, p);

  socket.on("input", ({ x, z, yaw }) => {
    p.input = { x: clamp(num(x), -1, 1), z: clamp(num(z), -1, 1) };
    p.yaw = num(yaw);
  });

  socket.on("shoot", ({ yaw }) => {
    if (!p.alive) return;
    p.yaw = num(yaw);
    const dx = -Math.sin(p.yaw);
    const dz = -Math.cos(p.yaw);

    let target = null;
    let best = SHOT_RANGE;
    for (const [id, o] of players) {
      if (id === socket.id || !o.alive) continue;
      const ox = o.x - p.x;
      const oz = o.z - p.z;
      const t = ox * dx + oz * dz;
      if (t < 0 || t > best) continue;
      const perp = Math.abs(ox * dz - oz * dx);
      if (perp < HIT_RADIUS) {
        best = t;
        target = { id, o };
      }
    }

    socket.emit("fired");
    if (!target) return;

    socket.emit("hitmark");
    io.to(target.id).emit("hurt");
    target.o.hp -= DAMAGE;

    if (target.o.hp <= 0) {
      target.o.alive = false;
      p.kills++;
      io.to(target.id).emit("died");
      const victim = target.o;
      setTimeout(() => {
        if (players.get(target.id) === victim) spawn(victim);
      }, RESPAWN_MS);
    }
  });

  socket.on("disconnect", () => players.delete(socket.id));
});

// 20Hzで移動を進め、全員の状態を配信
setInterval(() => {
  for (const p of players.values()) {
    if (!p.alive) continue;
    const { x: ix, z: iz } = p.input;
    if (!ix && !iz) continue;
    const dx = ix * Math.cos(p.yaw) - iz * Math.sin(p.yaw);
    const dz = -ix * Math.sin(p.yaw) - iz * Math.cos(p.yaw);
    const len = Math.hypot(dx, dz) || 1;
    p.x = clamp(p.x + (dx / len) * SPEED, -BOUND, BOUND);
    p.z = clamp(p.z + (dz / len) * SPEED, -BOUND, BOUND);
  }

  const snapshot = {};
  for (const [id, p] of players) {
    snapshot[id] = { x: p.x, z: p.z, yaw: p.yaw, hp: p.hp, alive: p.alive, kills: p.kills };
  }
  io.emit("state", snapshot);
}, TICK_MS);

http.listen(PORT, "0.0.0.0", () => console.log(`server listening on :${PORT}`));
