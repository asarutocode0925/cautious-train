import * as THREE from "three";
import { io } from "socket.io-client";

// 開発時は別ポートのサーバーへ、本番（ビルド後）は同じオリジンへ接続
const SERVER_URL = import.meta.env.DEV ? "http://localhost:3000" : undefined;
const FIRE_COOLDOWN_MS = 250;
const STICK_R = 60;
const LOOK_SENS_MOUSE = 0.002;
const LOOK_SENS_TOUCH = 0.006;

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const isTouch = matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
if (isTouch) document.body.classList.add("touch");

// ---- Three.js ----
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1d24);
scene.fog = new THREE.Fog(0x1a1d24, 40, 120);

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 300);
camera.rotation.order = "YXZ";

scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(10, 20, 10);
scene.add(sun);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(100, 100),
  new THREE.MeshStandardMaterial({ color: 0x2a2f3a })
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
scene.add(new THREE.GridHelper(100, 50, 0x445566, 0x2a3140));

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---- UI ----
const hud = document.getElementById("hud");
const msg = document.getElementById("msg");
const cross = document.getElementById("cross");
const hint = document.getElementById("hint");
const stick = document.getElementById("stick");
const knob = document.getElementById("knob");
const fireBtn = document.getElementById("fire");

function flashMsg(text) {
  msg.textContent = text;
  msg.style.opacity = 1;
  clearTimeout(flashMsg.t);
  flashMsg.t = setTimeout(() => (msg.style.opacity = 0), 1200);
}

// ---- Robot model ----
function makeRobot() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xc0c8d4, metalness: 0.6, roughness: 0.4 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.0, 0.6), mat);
  body.position.y = 1.0;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, 0.6), mat);
  head.position.y = 1.9;
  const eye = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.1, 0.05),
    new THREE.MeshStandardMaterial({ color: 0xff3322, emissive: 0xff3322 })
  );
  eye.position.set(0, 1.95, -0.33);
  g.add(body, head, eye);
  return g;
}

// ---- Networking ----
const socket = io(SERVER_URL);
const meshes = new Map();
let self = null;
let yaw = 0;
let pitch = 0;
let lastShot = 0;

socket.on("state", (state) => {
  for (const [id, p] of Object.entries(state)) {
    let m = meshes.get(id);
    if (!m) {
      m = makeRobot();
      scene.add(m);
      meshes.set(id, m);
    }
    m.position.set(p.x, 0, p.z);
    m.rotation.y = p.yaw;
    m.visible = p.alive && id !== socket.id;
  }
  for (const id of [...meshes.keys()]) {
    if (!state[id]) {
      scene.remove(meshes.get(id));
      meshes.delete(id);
    }
  }

  self = state[socket.id] ?? null;
  if (self) {
    hud.innerHTML = `HP: ${self.alive ? self.hp : 0}<br>KILLS: ${self.kills}`;
  }
});

socket.on("hitmark", () => {
  cross.classList.add("hit");
  setTimeout(() => cross.classList.remove("hit"), 150);
});

socket.on("died", () => flashMsg("撃破された！ 3秒後に復活"));

// ---- Keyboard / mouse ----
const keys = {};
addEventListener("keydown", (e) => (keys[e.code] = true));
addEventListener("keyup", (e) => (keys[e.code] = false));

const canvas = renderer.domElement;
canvas.addEventListener("click", () => {
  if (isTouch) return; // タッチ端末は射撃ボタンを使う
  if (document.pointerLockElement !== canvas) {
    canvas.requestPointerLock();
  } else {
    shoot();
  }
});

document.addEventListener("pointerlockchange", () => {
  hint.style.display = document.pointerLockElement === canvas ? "none" : "block";
});

document.addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== canvas) return;
  yaw -= e.movementX * LOOK_SENS_MOUSE;
  pitch = clamp(pitch - e.movementY * LOOK_SENS_MOUSE, -1.4, 1.4);
});

// ---- Touch ----
const touchMove = { x: 0, z: 0 };
let stickId = null;
let lookId = null;
let fireId = null;
let fireHeld = false;
let lastLook = { x: 0, y: 0 };

function updateStick(t) {
  const r = stick.getBoundingClientRect();
  let dx = t.clientX - (r.left + r.width / 2);
  let dy = t.clientY - (r.top + r.height / 2);
  const d = Math.hypot(dx, dy);
  if (d > STICK_R) {
    dx = (dx / d) * STICK_R;
    dy = (dy / d) * STICK_R;
  }
  knob.style.transform = `translate(${dx}px, ${dy}px)`;
  touchMove.x = dx / STICK_R;
  touchMove.z = -dy / STICK_R; // 画面上方向が前進
}

function resetStick() {
  touchMove.x = 0;
  touchMove.z = 0;
  knob.style.transform = "";
}

addEventListener(
  "touchstart",
  (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const el = t.target;
      if (fireBtn.contains(el)) {
        fireId = t.identifier;
        fireHeld = true;
        shoot();
      } else if (stick.contains(el)) {
        stickId = t.identifier;
        updateStick(t);
      } else if (lookId === null) {
        lookId = t.identifier;
        lastLook = { x: t.clientX, y: t.clientY };
      }
    }
  },
  { passive: false }
);

addEventListener(
  "touchmove",
  (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === stickId) {
        updateStick(t);
      } else if (t.identifier === lookId) {
        yaw -= (t.clientX - lastLook.x) * LOOK_SENS_TOUCH;
        pitch = clamp(pitch - (t.clientY - lastLook.y) * LOOK_SENS_TOUCH, -1.4, 1.4);
        lastLook = { x: t.clientX, y: t.clientY };
      }
    }
  },
  { passive: false }
);

function endTouch(e) {
  for (const t of e.changedTouches) {
    if (t.identifier === stickId) {
      stickId = null;
      resetStick();
    }
    if (t.identifier === lookId) lookId = null;
    if (t.identifier === fireId) {
      fireId = null;
      fireHeld = false;
    }
  }
}
addEventListener("touchend", endTouch);
addEventListener("touchcancel", endTouch);

// 押しっぱなしで連射（クールダウンはshoot内で管理）
setInterval(() => {
  if (fireHeld) shoot();
}, FIRE_COOLDOWN_MS);

// ---- Input send (20Hz) ----
setInterval(() => {
  const kx = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
  const kz = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
  const x = clamp(kx + touchMove.x, -1, 1);
  const z = clamp(kz + touchMove.z, -1, 1);
  socket.emit("input", { x, z, yaw });
}, 50);

function shoot() {
  const now = performance.now();
  if (now - lastShot < FIRE_COOLDOWN_MS) return;
  if (self && !self.alive) return;
  lastShot = now;
  socket.emit("shoot", { yaw });
  drawTracer();
}

// 射撃の視覚効果（ローカルのみ・判定はサーバー）
function drawTracer() {
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const from = camera.position.clone().add(dir.clone().multiplyScalar(0.5));
  const to = camera.position.clone().add(dir.clone().multiplyScalar(60));
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([from, to]),
    new THREE.LineBasicMaterial({ color: 0xffdd66 })
  );
  scene.add(line);
  setTimeout(() => {
    scene.remove(line);
    line.geometry.dispose();
    line.material.dispose();
  }, 80);
}

// ---- Render loop ----
renderer.setAnimationLoop(() => {
  if (self) camera.position.set(self.x, 1.6, self.z);
  camera.rotation.set(pitch, yaw, 0);
  renderer.render(scene, camera);
});
