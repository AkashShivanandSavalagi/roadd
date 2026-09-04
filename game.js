"use strict";
/* =========================================================================================
   ROAD RUSH - browser edition
   2D side-view hill-climb racer. Single/multiplayer (peer-to-peer, no backend server —
   PeerJS's free public broker is used only to help two browsers find each other; once
   connected, all race data flows directly device-to-device over WebRTC data channels).
   ========================================================================================= */

// ---------------------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------------------
const FINISH_DISTANCE = 3200;
const GRAVITY_BASE = 1800;
const GROUND_FRICTION = 0.985;
const MAX_PLAYERS = 5;
const NET_SEND_HZ = 15; // how often we broadcast our own position over the data channel

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function rand(rng) { return rng(); }

// Deterministic seeded RNG (mulberry32) so every player's terrain/obstacles/pickups match.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStringToSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------------------
// MAPS  (procedurally generated terrain - no external assets, so nothing to license/host)
// ---------------------------------------------------------------------------------------
const MAPS = {
  Highway: {
    label: "Highway", base: 380, amp: 22, freq: 1.0, smooth: 0.2, gravity: 1.0, traction: 1.0,
    obstacleDensity: 0.4, sky: ["#78aae6", "#c8e1f5"], ground: "#3c4146", accent: "#e6d23c",
    desc: "Smooth asphalt, light traffic."
  },
  Hills: {
    label: "Hills", base: 350, amp: 85, freq: 1.4, smooth: 0.55, gravity: 1.0, traction: 0.95,
    obstacleDensity: 0.35, sky: ["#78be8c", "#d2ebbe"], ground: "#507838", accent: "#785028",
    desc: "Rolling green slopes and jumps."
  },
  Moon: {
    label: "Moon", base: 380, amp: 50, freq: 0.8, smooth: 0.4, gravity: 0.35, traction: 0.9,
    obstacleDensity: 0.3, sky: ["#08081a", "#191428"], ground: "#96969b", accent: "#5a5a5f",
    desc: "Low gravity - huge jumps."
  },
  Desert: {
    label: "Desert", base: 370, amp: 55, freq: 1.1, smooth: 0.35, gravity: 1.0, traction: 0.92,
    obstacleDensity: 0.32, sky: ["#fabe6e", "#ffe1aa"], ground: "#c8a564", accent: "#5a8c46",
    desc: "Dunes and cacti, thirsty engines."
  },
  Snow: {
    label: "Snow", base: 370, amp: 65, freq: 1.2, smooth: 0.45, gravity: 1.0, traction: 0.55,
    obstacleDensity: 0.3, sky: ["#c8d7eb", "#ebf0f5"], ground: "#ebf0f5", accent: "#7896c8",
    desc: "Ice - low traction, lots of sliding."
  },
};
const MAP_ORDER = ["Highway", "Hills", "Moon", "Desert", "Snow"];

// ---------------------------------------------------------------------------------------
// VEHICLES
// ---------------------------------------------------------------------------------------
const VEHICLES = {
  Car: { accel: 620, maxSpeed: 520, brake: 780, mass: 1.0, stability: 0.8, fuelCap: 100,
         fuelUse: 9, color: "#d43c3c", w: 62, h: 26, desc: "Balanced." },
  Bike: { accel: 820, maxSpeed: 640, brake: 700, mass: 0.6, stability: 0.45, fuelCap: 80,
          fuelUse: 7, color: "#3c82d2", w: 48, h: 22, desc: "Fast, easy to flip." },
  Bus: { accel: 420, maxSpeed: 400, brake: 650, mass: 1.6, stability: 1.0, fuelCap: 140,
         fuelUse: 11, color: "#e6be3c", w: 84, h: 34, desc: "Slow, very stable." },
};

// ---------------------------------------------------------------------------------------
// TERRAIN
// ---------------------------------------------------------------------------------------
class Terrain {
  constructor(mapDef, seed) {
    this.def = mapDef;
    this.seed = seed;
    const rng = mulberry32(seed);
    this.phases = [rng() * Math.PI * 2, rng() * Math.PI * 2, rng() * Math.PI * 2, rng() * Math.PI * 2];
  }
  heightAt(x) {
    const { base, amp, freq, smooth } = this.def;
    let h = 0;
    h += Math.sin(x * freq * 0.001 + this.phases[0]) * amp;
    h += Math.sin(x * freq * 0.0025 + this.phases[1]) * (amp * 0.5) * smooth;
    h += Math.sin(x * freq * 0.0006 + this.phases[2]) * (amp * 1.3) * (1 - smooth * 0.4);
    h += Math.sin(x * freq * 0.006 + this.phases[3]) * (amp * 0.15);
    if (x < 300) h *= x / 300;
    return base + h;
  }
  slopeAt(x) {
    const d = 2;
    return (this.heightAt(x + d) - this.heightAt(x - d)) / (2 * d);
  }
}

function generateWorldObjects(terrain, seed, length) {
  const rng = mulberry32(seed ^ 0xC0FFEE);
  const pickups = [];
  const obstacles = [];
  let x = 500;
  while (x < length - 200) {
    x += 140 + rng() * 120;
    const roll = rng();
    if (roll < 0.16) pickups.push({ x, kind: "fuel", taken: false, bob: rng() * 6.28 });
    else if (roll < 0.28) pickups.push({ x, kind: "nitro", taken: false, bob: rng() * 6.28 });
    else if (roll < 0.55) pickups.push({ x, kind: "coin", taken: false, bob: rng() * 6.28 });
  }
  x = 600;
  const kindMap = { Highway: "traffic", Hills: "log", Moon: "crater", Desert: "cactus", Snow: "ice" };
  while (x < length - 300) {
    x += (260 + rng() * 260) / Math.max(0.3, terrain.def.obstacleDensity);
    if (rng() < terrain.def.obstacleDensity) {
      const kind = kindMap[terrain.def.label] || "rock";
      const w = kind === "traffic" ? 46 : 32, h = kind === "traffic" ? 26 : 28;
      obstacles.push({ x, kind, w, h });
    }
  }
  return { pickups, obstacles };
}

// ---------------------------------------------------------------------------------------
// PARTICLES
// ---------------------------------------------------------------------------------------
class ParticleSystem {
  constructor() { this.list = []; }
  emit(x, y, n, color, opts = {}) {
    const speed = opts.speed || 140, spread = opts.spread || 100, life = opts.life || 0.5,
          size = opts.size || 3, gravity = opts.gravity != null ? opts.gravity : 800;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = speed * (0.3 + Math.random() * 0.7);
      this.list.push({
        x, y,
        vx: Math.cos(ang) * spd * (spread / 120),
        vy: Math.sin(ang) * spd - 60,
        life: life * (0.6 + Math.random() * 0.6),
        maxLife: life, color, size, gravity,
      });
    }
  }
  update(dt) {
    this.list = this.list.filter(p => {
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      return p.life > 0;
    });
  }
  draw(ctx, camX) {
    for (const p of this.list) {
      const a = clamp(p.life / p.maxLife, 0, 1);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x - camX, p.y, Math.max(1, p.size * a), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------------------------------
// VEHICLE / PLAYER PHYSICS  (same arcade model as the desktop build: point mass + angle,
// ground-snapped "suspension" while grounded, free rotation + gravity while airborne, a
// landing-crash check from impact speed x angle mismatch x vehicle stability.)
// ---------------------------------------------------------------------------------------
class RacePlayer {
  constructor(vehicleName, terrain, opts = {}) {
    const v = VEHICLES[vehicleName];
    this.vehicleName = vehicleName;
    this.accelPower = v.accel; this.maxSpeed = v.maxSpeed; this.brakePower = v.brake;
    this.mass = v.mass; this.stability = v.stability; this.fuelCap = v.fuelCap;
    this.fuelUse = v.fuelUse; this.color = v.color; this.w = v.w; this.h = v.h;

    this.terrain = terrain;
    this.id = opts.id || "local";
    this.name = opts.name || "Player";
    this.isRemote = !!opts.isRemote;
    this.isBot = !!opts.isBot;

    this.x = 120; this.y = terrain.heightAt(this.x) - this.h / 2;
    this.vx = 0; this.vy = 0;
    this.angle = 0; this.angVel = 0;
    this.onGround = true; this.airtime = 0;

    this.fuel = this.fuelCap;
    this.nitroCharges = 0; this.maxNitro = 3; this.nitroTimer = 0;
    this.coins = 0;
    this.distance = 0;
    this.finished = false; this.finishTime = null; this.finishPlace = null;
    this.stunned = 0;
    this.deadStall = false;
    this.recentHits = new Set();
  }

  useNitro(particles, sfx) {
    if (this.nitroCharges > 0 && this.nitroTimer <= 0) {
      this.nitroCharges -= 1;
      this.nitroTimer = 2.0;
      if (sfx) sfx.play("nitro");
      particles.emit(this.x - this.w * 0.5, this.y, 12, "#ffb050",
        { spread: 60, speed: 200, life: 0.4, size: 4, gravity: 200 });
      return true;
    }
    return false;
  }

  update(dt, input, particles, sfx, raceStarted) {
    const t = this.terrain;
    const gravity = GRAVITY_BASE * t.def.gravity;

    if (this.stunned > 0) {
      this.stunned -= dt;
      input = { accel: false, brake: false, left: false, right: false, nitro: false };
    }
    let { accel, brake, left, right, nitro } = input;
    if (!raceStarted) { accel = brake = left = right = false; }

    if (nitro && raceStarted) this.useNitro(particles, sfx);
    if (this.nitroTimer > 0) this.nitroTimer -= dt;
    const nitroBoost = this.nitroTimer > 0 ? 1.55 : 1.0;

    this.deadStall = this.fuel <= 0;
    const powerMult = this.deadStall ? 0.15 : 1.0;

    const groundY = t.heightAt(this.x);
    const slope = t.slopeAt(this.x);
    const slopeDeg = Math.atan(slope) * 180 / Math.PI;

    if (this.onGround) {
      if (accel) {
        this.vx += this.accelPower * powerMult * nitroBoost * dt;
        if (this.fuel > 0) this.fuel -= this.fuelUse * dt * (1 + Math.abs(slope) * 0.6);
      }
      if (brake) {
        if (this.vx > 5) this.vx -= this.brakePower * dt;
        else this.vx -= this.accelPower * 0.5 * dt;
      }
      const traction = t.def.traction;
      this.vx *= (GROUND_FRICTION + (1 - GROUND_FRICTION) * (1 - traction));
      this.vx -= slope * gravity * dt * 0.5;
    } else {
      this.airtime += dt;
      this.vx *= 0.999;
    }
    this.vx = clamp(this.vx, -this.maxSpeed * 0.4, this.maxSpeed * nitroBoost);

    if (!this.onGround) {
      const turnRate = 220;
      if (left) this.angVel -= turnRate * dt;
      if (right) this.angVel += turnRate * dt;
      this.angVel *= 0.98;
      this.angle += this.angVel * dt;
    } else {
      this.angle = lerp(this.angle, slopeDeg, clamp(10 * dt, 0, 1));
      this.angVel = 0;
    }

    if (this.onGround) {
      this.vy = 0;
      this.y = groundY - this.h / 2;
    } else {
      this.vy += gravity * dt;
      this.y += this.vy * dt;
    }

    this.x += this.vx * dt;
    this.distance = Math.max(this.distance, this.x - 120);

    const gy = t.heightAt(this.x) - this.h / 2;
    if (this.y >= gy) {
      const wasAirborne = !this.onGround;
      this.y = gy;
      if (wasAirborne) {
        const impact = Math.abs(this.vy);
        this.vy = 0;
        const angleOff = Math.abs(this.angle - slopeDeg);
        const crashChance = (impact / 1400) * (angleOff / 45) * (1.2 - this.stability);
        if (crashChance > 0.55 && this.airtime > 0.25) {
          this._crash(particles, sfx);
        } else {
          particles.emit(this.x, this.y + this.h / 2, 5, "#c8c8c8",
            { spread: 60, speed: 90, life: 0.3, size: 2, gravity: 500 });
        }
      }
      this.onGround = true;
      this.airtime = 0;
    } else {
      this.onGround = false;
    }
    this.angle = ((this.angle + 180) % 360 + 360) % 360 - 180;
  }

  _crash(particles, sfx) {
    if (sfx) sfx.play("collision");
    particles.emit(this.x, this.y, 14, "#ff8c28",
      { spread: 140, speed: 180, life: 0.5, size: 3, gravity: 700 });
    this.vx *= 0.35;
    this.stunned = 0.5;
    this.angle = clamp(this.angle, -35, 35);
  }

  rect() { return { x: this.x - this.w / 2, y: this.y - this.h / 2, w: this.w, h: this.h }; }
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// ---------------------------------------------------------------------------------------
// AUDIO  (WebAudio synthesized beeps/noise - no sound files to ship)
// ---------------------------------------------------------------------------------------
class Sfx {
  constructor() {
    this.enabled = true;
    this.ctx = null;
  }
  _ensureCtx() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { this.enabled = false; }
    }
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
  }
  play(name) {
    if (!this.enabled) return;
    this._ensureCtx();
    if (!this.ctx) return;
    const ctx = this.ctx;
    const specs = {
      click: { f: 880, d: 0.06, type: "square", g: 0.15 },
      countdown: { f: 520, d: 0.15, type: "square", g: 0.2 },
      go: { f: 1046, d: 0.25, type: "square", g: 0.25 },
      pickup: { f: 1200, d: 0.12, type: "sine", g: 0.2 },
      fuel: { f: 700, d: 0.15, type: "sine", g: 0.2 },
      nitro: { f: 300, d: 0.35, type: "sawtooth", g: 0.2 },
      collision: { f: 120, d: 0.2, type: "square", g: 0.25 },
      finish: { f: 880, d: 0.5, type: "square", g: 0.25 },
      coin: { f: 1500, d: 0.08, type: "sine", g: 0.15 },
    };
    const s = specs[name];
    if (!s) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = s.type;
    osc.frequency.value = s.f;
    gain.gain.setValueAtTime(s.g, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + s.d);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + s.d);
  }
}

// ---------------------------------------------------------------------------------------
// RENDERING
// ---------------------------------------------------------------------------------------
function drawTerrain(ctx, terrain, camX, W, H) {
  const def = terrain.def;
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, def.sky[0]);
  grad.addColorStop(1, def.sky[1]);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  if (def.label === "Moon") {
    ctx.fillStyle = "#dcdce6";
    for (let i = 0; i < 50; i++) {
      const sx = (i * 137.5) % W, sy = (i * 91.3) % (H * 0.6);
      ctx.fillRect(sx, sy, 1.5, 1.5);
    }
  } else if (def.label === "Snow") {
    ctx.fillStyle = "#ffffff";
    const t = performance.now() * 0.0004;
    for (let i = 0; i < 26; i++) {
      const sx = ((i * 173 + t * 40 * (i % 3 + 1) * 60) % (W + 40)) - 20;
      const sy = (i * 63) % H;
      ctx.beginPath(); ctx.arc(sx, sy, 2, 0, 6.28); ctx.fill();
    }
  }

  ctx.beginPath();
  ctx.moveTo(0, H);
  const step = 8;
  for (let sx = 0; sx <= W + step; sx += step) {
    ctx.lineTo(sx, terrain.heightAt(camX + sx));
  }
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fillStyle = def.ground;
  ctx.fill();

  ctx.beginPath();
  ctx.strokeStyle = def.accent;
  ctx.lineWidth = 3;
  for (let sx = 0; sx <= W + step; sx += step) {
    const gy = terrain.heightAt(camX + sx) + 4;
    if (sx === 0) ctx.moveTo(sx, gy); else ctx.lineTo(sx, gy);
  }
  ctx.stroke();
}

function drawVehicle(ctx, player, camX, shake) {
  const cx = player.x - camX + (shake ? shake[0] : 0);
  const cy = player.y + (shake ? shake[1] : 0);
  const w = player.w, h = player.h;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(player.angle * Math.PI / 180);
  ctx.fillStyle = player.color;

  if (player.vehicleName === "Bike") {
    ctx.beginPath(); ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, 6.28); ctx.fill();
    ctx.fillStyle = "#1a1a20";
    ctx.beginPath(); ctx.arc(-w / 2 + 4, h / 2, 8, 0, 6.28); ctx.fill();
    ctx.beginPath(); ctx.arc(w / 2 - 4, h / 2, 8, 0, 6.28); ctx.fill();
  } else if (player.vehicleName === "Bus") {
    roundRect(ctx, -w / 2, -h / 2, w, h, 6); ctx.fill();
    ctx.fillStyle = "#c8e6fa";
    for (const fx of [-w * 0.3, 0, w * 0.3]) { ctx.fillRect(fx - 6, -h / 2 + 4, 14, h * 0.4); }
    ctx.fillStyle = "#1a1a20";
    ctx.beginPath(); ctx.arc(-w * 0.3, h / 2, 9, 0, 6.28); ctx.fill();
    ctx.beginPath(); ctx.arc(w * 0.3, h / 2, 9, 0, 6.28); ctx.fill();
  } else {
    roundRect(ctx, -w / 2, -h / 2, w, h, 8); ctx.fill();
    ctx.fillStyle = "#c8e6fa";
    ctx.beginPath();
    ctx.moveTo(w * 0.05, -h / 2); ctx.lineTo(w * 0.35, -h / 2);
    ctx.lineTo(w * 0.25, 0); ctx.lineTo(0, 0); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#1a1a20";
    ctx.beginPath(); ctx.arc(-w * 0.28, h / 2, 8, 0, 6.28); ctx.fill();
    ctx.beginPath(); ctx.arc(w * 0.28, h / 2, 8, 0, 6.28); ctx.fill();
  }
  ctx.restore();

  if (player.nitroTimer > 0) {
    const flameLen = 16 + 6 * Math.sin(performance.now() * 0.02);
    ctx.fillStyle = "#ffa028";
    ctx.beginPath();
    ctx.arc(cx - Math.cos(player.angle * Math.PI / 180) * (w / 2 + flameLen / 2), cy, flameLen / 2, 0, 6.28);
    ctx.fill();
  }

  // name tag for remote/bot players
  if (player.isRemote || player.isBot) {
    ctx.fillStyle = "#fff";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(player.name, cx, cy - h / 2 - 10);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawPickup(ctx, p, camX, terrain, W) {
  const x = p.x - camX;
  if (x < -30 || x > W + 30) return;
  const yOff = Math.sin(performance.now() * 0.004 + p.bob) * 6;
  const cy = terrain.heightAt(p.x) - 26 + yOff;
  const colors = { fuel: "#f0c828", nitro: "#3cc8ff", coin: "#ffd73c" };
  ctx.fillStyle = colors[p.kind];
  ctx.beginPath(); ctx.arc(x, cy, 11, 0, 6.28); ctx.fill();
  ctx.strokeStyle = "#1e1e1e"; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = "#161616"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "center";
  ctx.fillText({ fuel: "F", nitro: "N", coin: "$" }[p.kind], x, cy + 4);
}

function drawObstacle(ctx, o, camX, terrain, W) {
  const x = o.x - camX;
  if (x < -60 || x > W + 60) return;
  const gy = terrain.heightAt(o.x);
  const colors = { traffic: "#c83c3c", log: "#6e4b28", crater: "#5a5a5f",
                    cactus: "#3c825a", ice: "#96c8e6", rock: "#6e6e73" };
  ctx.fillStyle = colors[o.kind] || "#888";
  roundRect(ctx, x - o.w / 2, gy - o.h, o.w, o.h, 4);
  ctx.fill();
  ctx.strokeStyle = "#000"; ctx.lineWidth = 1; ctx.stroke();
}

// ---------------------------------------------------------------------------------------
// SCORING
// ---------------------------------------------------------------------------------------
const PLACE_BONUS = { 1: 1000, 2: 700, 3: 400, 4: 200, 5: 100 };
function computeScore(distance, coins, place, fuelRemaining) {
  let s = distance * 10 + coins * 10 + fuelRemaining * 2;
  if (PLACE_BONUS[place]) s += PLACE_BONUS[place];
  return Math.round(s);
}

// ---------------------------------------------------------------------------------------
// NETWORKING  (PeerJS WebRTC data channels - peer-to-peer, star topology through the host.
// The only outside service involved is PeerJS's free public broker, used purely to help
// two browsers exchange connection info once — no game data ever passes through it, and
// there is nothing here for you to deploy, host, or maintain.)
// ---------------------------------------------------------------------------------------
class NetManager {
  constructor() {
    this.peer = null;
    this.isHost = false;
    this.roomCode = null;
    this.myId = null;
    this.myName = "Player";
    this.conns = new Map();      // host: peerId -> DataConnection
    this.hostConn = null;        // guest: connection to host
    this.players = new Map();    // id -> {id, name, vehicle, ready, isHost}
    this.selectedMap = "Highway";
    this.onPlayersChanged = null;
    this.onMapChanged = null;
    this.onRaceStart = null;     // (seed, mapName)
    this.onWorldUpdate = null;   // (worldStateObj)
    this.onLeaderboard = null;   // (list)
    this.onError = null;
    this.onConnectedToHost = null;
  }

  _makeRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s = "";
    for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  createRoom(name) {
    return new Promise((resolve, reject) => {
      this.myName = name || "Host";
      this.isHost = true;
      const code = this._makeRoomCode();
      const fullId = "roadrush-" + code;
      this.peer = new Peer(fullId, { debug: 0 });
      this.peer.on("open", (id) => {
        this.roomCode = code;
        this.myId = id;
        this.players.set(id, { id, name: this.myName, vehicle: "Car", ready: true, isHost: true });
        this._emitPlayers();
        resolve(code);
      });
      this.peer.on("connection", (conn) => this._handleIncoming(conn));
      this.peer.on("error", (err) => {
        if (this.onError) this.onError(err.type || String(err));
        reject(err);
      });
    });
  }

  _handleIncoming(conn) {
    conn.on("open", () => {
      this.conns.set(conn.peer, conn);
      conn.on("data", (data) => this._handleGuestMessage(conn, data));
      conn.on("close", () => this._removePlayer(conn.peer));
    });
  }

  _removePlayer(id) {
    this.conns.delete(id);
    this.players.delete(id);
    this._emitPlayers();
    this.broadcast({ t: "players", list: this._playerListArr() });
  }

  _handleGuestMessage(conn, data) {
    if (!data || !data.t) return;
    if (data.t === "hello") {
      if (this.players.size >= MAX_PLAYERS) {
        conn.send({ t: "full" });
        return;
      }
      this.players.set(conn.peer, { id: conn.peer, name: data.name || "Player", vehicle: data.vehicle || "Car", ready: false, isHost: false });
      this._emitPlayers();
      conn.send({ t: "welcome", map: this.selectedMap, players: this._playerListArr() });
      this.broadcast({ t: "players", list: this._playerListArr() }, conn.peer);
    } else if (data.t === "vehicle") {
      const p = this.players.get(conn.peer);
      if (p) { p.vehicle = data.vehicle; this._emitPlayers(); this.broadcast({ t: "players", list: this._playerListArr() }); }
    } else if (data.t === "ready") {
      const p = this.players.get(conn.peer);
      if (p) { p.ready = true; this._emitPlayers(); this.broadcast({ t: "players", list: this._playerListArr() }); }
    } else if (data.t === "state") {
      if (this.onWorldUpdate) this.onWorldUpdate({ [conn.peer]: data.s });
      this.broadcast({ t: "peerstate", id: conn.peer, s: data.s }, conn.peer);
    } else if (data.t === "finish") {
      if (this._onGuestFinish) this._onGuestFinish(conn.peer, data);
    }
  }

  _playerListArr() { return Array.from(this.players.values()); }
  _emitPlayers() { if (this.onPlayersChanged) this.onPlayersChanged(this._playerListArr()); }

  setMap(mapName) {
    this.selectedMap = mapName;
    if (this.isHost) this.broadcast({ t: "map", map: mapName });
  }

  setMyVehicle(vehicle) {
    const me = this.players.get(this.myId);
    if (me) me.vehicle = vehicle;
    if (this.isHost) { this._emitPlayers(); this.broadcast({ t: "players", list: this._playerListArr() }); }
    else if (this.hostConn) this.hostConn.send({ t: "vehicle", vehicle });
  }

  startRace() {
    if (!this.isHost) return;
    const seed = Math.floor(Math.random() * 999999) + 1;
    this.broadcast({ t: "start", seed, map: this.selectedMap });
    if (this.onRaceStart) this.onRaceStart(seed, this.selectedMap);
  }

  sendState(stateObj) {
    if (this.isHost) {
      if (this.onWorldUpdate) this.onWorldUpdate({ [this.myId]: stateObj });
      this.broadcast({ t: "peerstate", id: this.myId, s: stateObj });
    } else if (this.hostConn && this.hostConn.open) {
      this.hostConn.send({ t: "state", s: stateObj });
    }
  }

  sendFinish(place, time, score, distance, coins, fuel) {
    const payload = { place, time, score, distance, coins, fuel };
    if (this.isHost) {
      if (this._onGuestFinish) this._onGuestFinish(this.myId, payload);
    } else if (this.hostConn) {
      this.hostConn.send({ t: "finish", ...payload });
    }
  }

  broadcastLeaderboard(list) {
    if (!this.isHost) return;
    this.broadcast({ t: "leaderboard", list });
    if (this.onLeaderboard) this.onLeaderboard(list);
  }

  broadcast(obj, excludeId) {
    for (const [id, conn] of this.conns) {
      if (id === excludeId) continue;
      if (conn.open) conn.send(obj);
    }
  }

  joinRoom(code, name) {
    return new Promise((resolve, reject) => {
      this.myName = name || "Player";
      this.isHost = false;
      const fullId = "roadrush-" + code.trim().toUpperCase();
      this.peer = new Peer(undefined, { debug: 0 });
      let settled = false;
      this.peer.on("open", (id) => {
        this.myId = id;
        const conn = this.peer.connect(fullId, { reliable: true });
        this.hostConn = conn;
        const timeout = setTimeout(() => {
          if (!settled) { settled = true; reject(new Error("timeout")); }
        }, 9000);
        conn.on("open", () => {
          conn.send({ t: "hello", name: this.myName, vehicle: "Car" });
        });
        conn.on("data", (data) => {
          if (data.t === "full") { if (!settled) { settled = true; clearTimeout(timeout); reject(new Error("full")); } return; }
          if (data.t === "welcome") {
            if (!settled) {
              settled = true; clearTimeout(timeout);
              this.selectedMap = data.map;
              this.players = new Map(data.players.map(p => [p.id, p]));
              this._emitPlayers();
              resolve(code);
            }
          }
          this._handleHostMessage(data);
        });
        conn.on("error", (err) => {
          if (!settled) { settled = true; clearTimeout(timeout); reject(err); }
        });
      });
      this.peer.on("error", (err) => {
        if (!settled) { settled = true; reject(err); }
      });
    });
  }

  _handleHostMessage(data) {
    if (data.t === "players") {
      this.players = new Map(data.list.map(p => [p.id, p]));
      this._emitPlayers();
    } else if (data.t === "map") {
      this.selectedMap = data.map;
      if (this.onMapChanged) this.onMapChanged(data.map);
    } else if (data.t === "start") {
      if (this.onRaceStart) this.onRaceStart(data.seed, data.map);
    } else if (data.t === "peerstate") {
      if (this.onWorldUpdate) this.onWorldUpdate({ [data.id]: data.s });
    } else if (data.t === "leaderboard") {
      if (this.onLeaderboard) this.onLeaderboard(data.list);
    }
  }

  sendReady() {
    if (this.isHost) return;
    if (this.hostConn) this.hostConn.send({ t: "ready" });
  }

  teardown() {
    try { if (this.peer) this.peer.destroy(); } catch (e) {}
    this.conns.clear();
    this.players.clear();
  }
}

// ---------------------------------------------------------------------------------------
// APP CONTROLLER
// ---------------------------------------------------------------------------------------
const App = {
  screens: {},
  state: "home",
  sfx: new Sfx(),
  net: new NetManager(),
  settings: { sfx: true, name: "" },
  selectedVehicle: "Car",
  selectedMapSingle: "Highway",
  isMultiplayer: false,
  isHost: false,
  raceMode: null,          // 'single' | 'mp'
  keys: { accel: false, brake: false, left: false, right: false, nitro: false },
  canvas: null, ctx: null,
  W: 960, H: 540,
  camX: 0, camShake: 0,
  particles: null,
  terrain: null, pickups: [], obstacles: [],
  players: [],              // local player + bots (single) OR local + remote ghosts (mp)
  localPlayer: null,
  raceTime: 0, countdownT: 0, raceStarted: false, raceOver: false,
  lastFrameT: 0,
  netSendAccum: 0,
  finishedIds: new Set(),
  leaderboardFinal: null,
  rafId: null,

  init() {
    this._cacheScreens();
    this._wireStaticEvents();
    this._buildVehicleGrid();
    this._loadLocalPrefs();
    this._setupCanvas();
    this._setupInput();
    this._setupNetCallbacks();
    this._handleOrientation();
    window.addEventListener("resize", () => { this._resizeCanvas(); this._handleOrientation(); });
    window.addEventListener("orientationchange", () => this._handleOrientation());
    this.goHome();
  },

  // ---------------- screen management ----------------
  _cacheScreens() {
    document.querySelectorAll(".screen").forEach(el => { this.screens[el.id] = el; });
  },
  show(id) {
    Object.values(this.screens).forEach(el => el.classList.add("hidden"));
    this.screens[id].classList.remove("hidden");
  },
  goHome() {
    this.state = "home";
    this._stopRaceLoop();
    if (this.net.peer) { this.net.teardown(); this.net = new NetManager(); this._setupNetCallbacks(); }
    this.show("screen-home");
  },

  _wireStaticEvents() {
    document.querySelectorAll("[data-go]").forEach(btn => {
      btn.addEventListener("click", () => {
        const target = btn.getAttribute("data-go");
        if (target === "home") this.goHome();
        else this.show("screen-" + target);
      });
    });
    document.getElementById("btnSingle").addEventListener("click", () => this.startSinglePlayerFlow());
    document.getElementById("btnQuickRace").addEventListener("click", () => this.startSinglePlayerFlow());
    document.getElementById("btnCreateRoom").addEventListener("click", () => this.createRoomFlow());
    document.getElementById("btnJoinRoom").addEventListener("click", () => this.show("screen-joincode"));
    document.getElementById("btnDoJoin").addEventListener("click", () => this.joinRoomFlow());
    document.getElementById("btnToggleSfx").addEventListener("click", (e) => {
      this.settings.sfx = !this.settings.sfx;
      this.sfx.enabled = this.settings.sfx;
      e.target.textContent = "Sound FX: " + (this.settings.sfx ? "ON" : "OFF");
      this._savePrefs();
    });
    document.getElementById("playerNameInput").addEventListener("change", (e) => {
      this.settings.name = e.target.value.trim().slice(0, 12);
      this._savePrefs();
    });
    document.getElementById("btnCopyCode").addEventListener("click", () => {
      const code = document.getElementById("roomCodeDisplay").textContent;
      if (navigator.clipboard) navigator.clipboard.writeText(code).catch(() => {});
    });
    document.getElementById("btnStartRace").addEventListener("click", () => {
      if (this.net.isHost) this.net.startRace();
    });
    document.getElementById("btnLeaveLobby").addEventListener("click", () => this.goHome());
    document.getElementById("btnResume").addEventListener("click", () => this._togglePause(false));
    document.getElementById("btnPause").addEventListener("click", () => this._togglePause(true));
    document.getElementById("btnQuitRace").addEventListener("click", () => this.goHome());
    document.getElementById("btnRaceHome").addEventListener("click", () => this.goHome());
    document.getElementById("btnRaceCancelToRoom").addEventListener("click", () => this._cancelToRoom());
  },

  _loadLocalPrefs() {
    try {
      const raw = localStorage.getItem("roadrush_prefs");
      if (raw) {
        const p = JSON.parse(raw);
        this.settings.sfx = p.sfx !== false;
        this.settings.name = p.name || "";
        this.selectedVehicle = p.vehicle || "Car";
      }
    } catch (e) {}
    if (!this.settings.name) this.settings.name = "Player" + Math.floor(Math.random() * 900 + 100);
    document.getElementById("playerNameInput").value = this.settings.name;
    document.getElementById("btnToggleSfx").textContent = "Sound FX: " + (this.settings.sfx ? "ON" : "OFF");
    this.sfx.enabled = this.settings.sfx;
    this._highlightSelectedVehicle();
  },
  _savePrefs() {
    try {
      localStorage.setItem("roadrush_prefs", JSON.stringify({
        sfx: this.settings.sfx, name: this.settings.name, vehicle: this.selectedVehicle
      }));
    } catch (e) {}
  },

  _buildVehicleGrid() {
    const grid = document.getElementById("vehicleGrid");
    grid.innerHTML = "";
    Object.keys(VEHICLES).forEach(name => {
      const v = VEHICLES[name];
      const card = document.createElement("div");
      card.className = "vehicle-card";
      card.dataset.vehicle = name;
      card.innerHTML = `
        <svg class="vshape" viewBox="0 0 80 50"><rect x="8" y="12" width="64" height="26" rx="8" fill="${v.color}"/><circle cx="24" cy="40" r="7" fill="#1a1a20"/><circle cx="56" cy="40" r="7" fill="#1a1a20"/></svg>
        <div class="vinfo">
          <div class="vname">${name}</div>
          <div class="vdesc">${v.desc}</div>
          <div class="vstats">accel ${v.accel} &middot; top ${v.maxSpeed} &middot; stability ${v.stability}</div>
        </div>`;
      card.addEventListener("click", () => {
        this.selectedVehicle = name;
        this._highlightSelectedVehicle();
        this._savePrefs();
        if (this.net && this.net.peer) this.net.setMyVehicle(name);
      });
      grid.appendChild(card);
    });
  },
  _highlightSelectedVehicle() {
    document.querySelectorAll(".vehicle-card").forEach(c => {
      c.classList.toggle("selected", c.dataset.vehicle === this.selectedVehicle);
    });
  },

  // ---------------- multiplayer room flows ----------------
  async createRoomFlow() {
    this.show("screen-lobby");
    document.getElementById("roomCodeDisplay").textContent = "......";
    document.getElementById("lobbyStatus").textContent = "Creating room...";
    document.getElementById("btnStartRace").classList.remove("hidden");
    document.getElementById("mapSelectHost").classList.remove("hidden");
    document.getElementById("mapSelectGuest").classList.add("hidden");
    this._buildHostMapSelect();
    try {
      const code = await this.net.createRoom(this.settings.name);
      document.getElementById("roomCodeDisplay").textContent = code;
      document.getElementById("lobbyStatus").textContent = "Waiting for players - share this code.";
      this.isMultiplayer = true; this.isHost = true;
      this.net._onGuestFinish = (id, payload) => this._hostRecordFinish(id, payload);
    } catch (err) {
      document.getElementById("lobbyStatus").textContent = "Could not create room: " + (err.message || err);
    }
  },

  async joinRoomFlow() {
    const codeInput = document.getElementById("joinCodeInput");
    const code = codeInput.value.trim();
    const errEl = document.getElementById("joinError");
    errEl.textContent = "";
    if (!code) { errEl.textContent = "Enter a room code."; return; }
    errEl.textContent = "Connecting...";
    try {
      await this.net.joinRoom(code, this.settings.name);
      this.isMultiplayer = true; this.isHost = false;
      this.show("screen-lobby");
      document.getElementById("roomCodeDisplay").textContent = code.toUpperCase();
      document.getElementById("lobbyStatus").textContent = "Connected. Waiting for host to start.";
      document.getElementById("btnStartRace").classList.add("hidden");
      document.getElementById("mapSelectHost").classList.add("hidden");
      document.getElementById("mapSelectGuest").classList.remove("hidden");
      document.getElementById("mapChosenLabel").textContent = this.net.selectedMap;
      this.net.sendReady();
    } catch (err) {
      const msg = err && err.message === "full" ? "Room is full (max 5 players)."
                 : err && err.message === "timeout" ? "Could not reach that room. Check the code."
                 : "Connection failed. Check the code and try again.";
      errEl.textContent = msg;
    }
  },

  _buildHostMapSelect() {
    const el = document.getElementById("mapSelectHost");
    el.innerHTML = "";
    MAP_ORDER.forEach(name => {
      const opt = document.createElement("div");
      opt.className = "map-opt" + (name === this.net.selectedMap ? " selected" : "");
      opt.textContent = name + " - " + MAPS[name].desc;
      opt.addEventListener("click", () => {
        this.net.setMap(name);
        el.querySelectorAll(".map-opt").forEach(o => o.classList.remove("selected"));
        opt.classList.add("selected");
      });
      el.appendChild(opt);
    });
  },

  _setupNetCallbacks() {
    this.net.onPlayersChanged = (list) => this._renderLobbyPlayers(list);
    this.net.onMapChanged = (map) => {
      const lbl = document.getElementById("mapChosenLabel");
      if (lbl) lbl.textContent = map;
    };
    this.net.onRaceStart = (seed, mapName) => this._beginRace("mp", mapName, seed);
    this.net.onWorldUpdate = (partial) => this._applyWorldUpdate(partial);
    this.net.onLeaderboard = (list) => this._showFinalLeaderboard(list);
  },

  _renderLobbyPlayers(list) {
    const ul = document.getElementById("lobbyPlayerList");
    ul.innerHTML = "";
    list.forEach(p => {
      const li = document.createElement("li");
      const isMe = p.id === this.net.myId;
      li.innerHTML = `<span>${p.isHost ? "&#9733; " : ""}${p.name} (${p.vehicle})</span>` +
                      `<span class="you-tag">${isMe ? "YOU" : (p.ready ? "ready" : "")}</span>`;
      ul.appendChild(li);
    });
    document.getElementById("lobbyPlayerCount").textContent = list.length;
  },

  // ---------------- canvas / responsive ----------------
  _setupCanvas() {
    this.canvas = document.getElementById("raceCanvas");
    this.ctx = this.canvas.getContext("2d");
    this._resizeCanvas();
  },
  _resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = document.getElementById("screen-race").getBoundingClientRect();
    this.W = Math.max(320, rect.width || window.innerWidth);
    this.H = Math.max(200, rect.height || window.innerHeight);
    this.canvas.width = Math.floor(this.W * dpr);
    this.canvas.height = Math.floor(this.H * dpr);
    this.canvas.style.width = this.W + "px";
    this.canvas.style.height = this.H + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  },
  _handleOrientation() {
    const isPhoneLike = Math.min(window.innerWidth, window.innerHeight) < 560;
    const isPortrait = window.innerHeight > window.innerWidth;
    const prompt = document.getElementById("rotatePrompt");
    if (isPhoneLike && isPortrait && this.state === "race") {
      prompt.classList.remove("hidden");
    } else {
      prompt.classList.add("hidden");
    }
    this._resizeCanvas();
  },

  // ---------------- input ----------------
  _setupInput() {
    const setKey = (k, v) => { this.keys[k] = v; };
    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      if (e.code === "KeyW" || e.code === "ArrowUp") setKey("accel", true);
      if (e.code === "KeyS" || e.code === "ArrowDown") setKey("brake", true);
      if (e.code === "KeyA" || e.code === "ArrowLeft") setKey("left", true);
      if (e.code === "KeyD" || e.code === "ArrowRight") setKey("right", true);
      if (e.code === "Space") { setKey("nitro", true); e.preventDefault(); }
      if (e.code === "Escape") this._togglePause();
      if (e.code === "KeyR" && this.state === "race") this._restartRace();
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "KeyW" || e.code === "ArrowUp") setKey("accel", false);
      if (e.code === "KeyS" || e.code === "ArrowDown") setKey("brake", false);
      if (e.code === "KeyA" || e.code === "ArrowLeft") setKey("left", false);
      if (e.code === "KeyD" || e.code === "ArrowRight") setKey("right", false);
      if (e.code === "Space") setKey("nitro", false);
    });

    const bindPedal = (id, key) => {
      const el = document.getElementById(id);
      const on = (e) => { e.preventDefault(); setKey(key, true); };
      const off = (e) => { e.preventDefault(); setKey(key, false); };
      el.addEventListener("touchstart", on, { passive: false });
      el.addEventListener("touchend", off, { passive: false });
      el.addEventListener("touchcancel", off, { passive: false });
      el.addEventListener("mousedown", on);
      el.addEventListener("mouseup", off);
      el.addEventListener("mouseleave", off);
    };
    bindPedal("btnGas", "accel");
    bindPedal("btnBrake", "brake");
    bindPedal("btnNitro", "nitro");

    if ("ontouchstart" in window) document.getElementById("touchControls").classList.remove("hidden");
  },

  // ---------------- race lifecycle ----------------
  startSinglePlayerFlow() {
    this.isMultiplayer = false;
    this.isHost = false;
    this._beginRace("single", this.selectedMapSingle, Math.floor(Math.random() * 999999) + 1);
  },

  _beginRace(mode, mapName, seed) {
    this.raceMode = mode;
    this.state = "race";
    this.show("screen-race");
    this._handleOrientation();
    this._resizeCanvas();

    const mapDef = MAPS[mapName] || MAPS.Highway;
    this.terrain = new Terrain(mapDef, seed);
    const world = generateWorldObjects(this.terrain, seed, FINISH_DISTANCE + 400);
    this.pickups = world.pickups;
    this.obstacles = world.obstacles;
    this.particles = new ParticleSystem();
    this.camX = 0; this.camShake = 0;
    this.raceTime = 0; this.raceStarted = false; this.raceOver = false;
    this.countdownT = 3.999;
    this.finishedIds = new Set();
    this.leaderboardFinal = null;

    this.localPlayer = new RacePlayer(this.selectedVehicle, this.terrain, { id: this.net.myId || "local", name: this.settings.name });
    this.players = [this.localPlayer];

    if (mode === "single") {
      for (let i = 0; i < 3; i++) {
        const names = Object.keys(VEHICLES);
        const v = names[Math.floor(Math.random() * names.length)];
        const bot = new RacePlayer(v, this.terrain, { id: "bot" + i, name: "CPU " + (i + 1), isBot: true });
        bot.x = 120 - (i + 1) * 45;
        this.players.push(bot);
      }
    } else {
      // remote players are rendered as ghosts, driven purely by network state
      this.remoteGhosts = new Map();
      for (const p of this.net.players.values()) {
        if (p.id === this.net.myId) continue;
        const ghost = new RacePlayer(p.vehicle || "Car", this.terrain, { id: p.id, name: p.name, isRemote: true });
        this.remoteGhosts.set(p.id, ghost);
      }
    }

    this._stopRaceLoop();
    document.getElementById("hud").classList.remove("hidden");
    document.getElementById("btnPause").classList.remove("hidden");
    document.getElementById("pauseOverlay").classList.add("hidden");
    document.getElementById("countdownOverlay").classList.remove("hidden");
    this._updateCountdownDisplay();

    this.lastFrameT = performance.now();
    this._raceLoop();
  },

  _restartRace() {
    const mapName = this.terrain.def.label;
    const seed = Math.floor(Math.random() * 999999) + 1;
    this._beginRace(this.raceMode, mapName, seed);
  },

  _cancelToRoom() {
    if (this.isMultiplayer) {
      this.show("screen-lobby");
      this.state = "lobby";
      document.getElementById("lobbyStatus").textContent = this.isHost
        ? "Back in the room - start again when ready." : "Waiting for host to start again.";
    } else {
      this._restartRace();
    }
  },

  _setFinishActionLabel() {
    const btn = document.getElementById("btnRaceCancelToRoom");
    btn.textContent = this.isMultiplayer ? "Cancel (Back to Room)" : "Race Again";
  },

  _togglePause(force) {
    if (this.state !== "race" || !this.raceStarted || this.raceOver) return;
    const overlay = document.getElementById("pauseOverlay");
    const wantPause = force !== undefined ? force : overlay.classList.contains("hidden");
    if (wantPause) { overlay.classList.remove("hidden"); this._paused = true; }
    else { overlay.classList.add("hidden"); this._paused = false; this.lastFrameT = performance.now(); }
  },

  _updateCountdownDisplay() {
    const n = Math.ceil(this.countdownT);
    const el = document.getElementById("countdownNum");
    el.textContent = n > 0 ? String(n) : "GO!";
  },

  _cancelLoop() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  },

  _stopRaceLoop() {
    this._cancelLoop();
    document.getElementById("hud").classList.add("hidden");
    document.getElementById("btnPause").classList.add("hidden");
    document.getElementById("countdownOverlay").classList.add("hidden");
    document.getElementById("pauseOverlay").classList.add("hidden");
    this._paused = false;
  },

  _raceLoop() {
    this.rafId = requestAnimationFrame(() => this._raceLoop());
    const now = performance.now();
    let dt = (now - this.lastFrameT) / 1000;
    this.lastFrameT = now;
    dt = Math.min(dt, 0.05);
    if (this._paused) return;

    if (!this.raceStarted) {
      this.countdownT -= dt;
      this._updateCountdownDisplay();
      if (this.countdownT <= 0) {
        this.raceStarted = true;
        document.getElementById("countdownOverlay").classList.add("hidden");
        this.sfx.play("go");
      } else if (Math.ceil(this.countdownT) !== Math.ceil(this.countdownT + dt) && Math.ceil(this.countdownT) > 0) {
        this.sfx.play("countdown");
      }
    } else if (!this.raceOver) {
      this.raceTime += dt;
      this._updateRace(dt);
    }

    this.particles.update(dt);
    this.camShake = Math.max(0, this.camShake - dt * 4);
    this._render();
  },

  _updateRace(dt) {
    const p = this.localPlayer;
    p.update(dt, this.keys, this.particles, this.sfx, true);
    this._handlePickups(p);
    this._handleObstacles(p);

    if (this.raceMode === "single") {
      for (const bot of this.players) {
        if (bot.isBot) {
          const bk = this._botInput(bot);
          bot.update(dt, bk, this.particles, this.sfx, true);
          this._handlePickups(bot);
          this._handleObstacles(bot);
        }
      }
    } else {
      this.netSendAccum += dt;
      if (this.netSendAccum >= 1 / NET_SEND_HZ) {
        this.netSendAccum = 0;
        this.net.sendState({
          x: p.x, y: p.y, angle: p.angle, vx: p.vx, vehicle: p.vehicleName,
          nitro: p.nitroTimer > 0, distance: p.distance,
        });
      }
    }

    const target = p.x - this.W * 0.32;
    this.camX = lerp(this.camX, Math.max(0, target), clamp(6 * dt, 0, 1));

    if (!p.finished && p.distance >= FINISH_DISTANCE) {
      p.finished = true;
      p.finishTime = this.raceTime;
      this.sfx.play("finish");
      this._onLocalFinish(p);
    }

    if (this.raceMode === "single") {
      for (const bot of this.players) {
        if (bot.isBot && !bot.finished && bot.distance >= FINISH_DISTANCE) {
          bot.finished = true; bot.finishTime = this.raceTime;
        }
      }
      const allDone = p.finished && this.players.every(x => x.finished);
      if (p.finished && !this._singleLeaderboardShown) {
        this._singleLeaderboardShown = true;
        this._showSinglePlayerResult();
      }
    }
  },

  _botInput(bot) {
    const upcoming = this.obstacles.find(o => o.x - bot.x > 0 && o.x - bot.x < 90);
    return { accel: true, brake: !!upcoming && Math.random() < 0.4, left: false, right: false,
             nitro: Math.random() < 0.01 && bot.nitroCharges > 0 };
  },

  _handlePickups(player) {
    for (const pk of this.pickups) {
      if (pk.taken) continue;
      const gy = this.terrain.heightAt(pk.x) - 26;
      if (Math.abs(pk.x - player.x) < 26 && Math.abs(gy - player.y) < 40) {
        pk.taken = true;
        if (pk.kind === "fuel") { player.fuel = Math.min(player.fuelCap, player.fuel + player.fuelCap * 0.25); this.sfx.play("fuel"); }
        else if (pk.kind === "nitro") { player.nitroCharges = Math.min(player.maxNitro, player.nitroCharges + 1); this.sfx.play("pickup"); }
        else if (pk.kind === "coin") { player.coins += 1; this.sfx.play("coin"); }
        if (player === this.localPlayer) {
          this.particles.emit(pk.x, gy, 8, "#ffe678", { spread: 80, speed: 120, life: 0.4, size: 2, gravity: 300 });
        }
      }
    }
  },

  _handleObstacles(player) {
    const pr = player.rect();
    for (const o of this.obstacles) {
      const gy = this.terrain.heightAt(o.x);
      const orect = { x: o.x - o.w / 2, y: gy - o.h, w: o.w, h: o.h };
      const key = o;
      if (!player.recentHits.has(key) && rectsOverlap(pr, orect)) {
        player.recentHits.add(key);
        player.vx = Math.max(player.vx * 0.4, 60);
        player.x = o.x + o.w / 2 + player.w / 2 + 2;
        player.stunned = 0.25;
        if (player === this.localPlayer) this.camShake = 6;
        this.sfx.play("collision");
        this.particles.emit(player.x, player.y, 8, "#ff7838", { spread: 100, speed: 140, life: 0.4, size: 3, gravity: 500 });
      }
    }
  },

  // ---------------- finish / leaderboard ----------------
  _onLocalFinish(p) {
    if (this.raceMode === "single") return; // single-player result handled in _updateRace
    const place = this.finishedIds.size + 1;
    this.finishedIds.add(p.id);
    const score = computeScore(p.distance, p.coins, place, p.fuel);
    this.net.sendFinish(place, p.finishTime, score, p.distance, p.coins, p.fuel);
    if (this.net.isHost) this._maybeCompileLeaderboard();
  },

  _hostRecordFinish(id, payload) {
    if (!this._hostFinishes) this._hostFinishes = new Map();
    if (!this._hostFinishes.has(id)) this._hostFinishes.set(id, payload);
    this._maybeCompileLeaderboard();
  },

  _maybeCompileLeaderboard() {
    if (!this.net.isHost || this.leaderboardFinal) return;
    const totalPlayers = this.net.players.size;
    const finishesIn = this._hostFinishes ? this._hostFinishes.size : 0;
    const timedOut = this.raceTime > 180; // safety cap so a stuck/disconnected player can't stall everyone forever
    if (finishesIn >= totalPlayers || (finishesIn > 0 && timedOut)) {
      const list = [];
      for (const [id, payload] of (this._hostFinishes || new Map())) {
        const pinfo = this.net.players.get(id);
        list.push({ id, name: pinfo ? pinfo.name : "Player", place: payload.place, time: payload.time,
                    score: payload.score, distance: payload.distance, coins: payload.coins, fuel: payload.fuel });
      }
      list.sort((a, b) => a.place - b.place);
      this.leaderboardFinal = list;
      this.net.broadcastLeaderboard(list);
      this._showFinalLeaderboard(list);
    }
  },

  _showFinalLeaderboard(list) {
    this.raceOver = true;
    this.leaderboardFinal = list;
    this.state = "finish";
    this._stopRaceLoop();
    document.getElementById("finishTitle").textContent = "RACE COMPLETE";
    const ol = document.getElementById("leaderboardList");
    ol.innerHTML = "";
    list.forEach(r => {
      const li = document.createElement("li");
      li.className = r.place === 1 ? "place-1" : "";
      li.innerHTML = `<span class="lb-place">#${r.place}</span>` +
                      `<span class="lb-name">${r.name}${r.id === this.net.myId ? " (you)" : ""}</span>` +
                      `<span class="lb-detail">${r.time.toFixed(1)}s &middot; score ${r.score}</span>`;
      ol.appendChild(li);
    });
    this.show("screen-finish");
    this._setFinishActionLabel();
  },

  _showSinglePlayerResult() {
    this.raceOver = true;
    this.state = "finish";
    this._stopRaceLoop();
    const ranked = [...this.players].sort((a, b) => b.distance - a.distance);
    document.getElementById("finishTitle").textContent = "RACE COMPLETE";
    const ol = document.getElementById("leaderboardList");
    ol.innerHTML = "";
    ranked.forEach((pl, i) => {
      const place = i + 1;
      const score = computeScore(pl.distance, pl.coins, place, pl.fuel);
      const li = document.createElement("li");
      li.className = place === 1 ? "place-1" : "";
      li.innerHTML = `<span class="lb-place">#${place}</span>` +
                      `<span class="lb-name">${pl.name}${pl === this.localPlayer ? " (you)" : ""}</span>` +
                      `<span class="lb-detail">${(pl.finishTime || this.raceTime).toFixed(1)}s &middot; score ${score}</span>`;
      ol.appendChild(li);
    });
    this.show("screen-finish");
    this._setFinishActionLabel();
    this._singleLeaderboardShown = false;
  },

  _applyWorldUpdate(partial) {
    if (!this.remoteGhosts) return;
    for (const id in partial) {
      if (id === this.net.myId) continue;
      const s = partial[id];
      let ghost = this.remoteGhosts.get(id);
      if (!ghost) {
        const pinfo = this.net.players.get(id);
        ghost = new RacePlayer((s && s.vehicle) || "Car", this.terrain, { id, name: pinfo ? pinfo.name : "Player", isRemote: true });
        this.remoteGhosts.set(id, ghost);
      }
      if (s) {
        ghost.x = s.x; ghost.y = s.y; ghost.angle = s.angle; ghost.vx = s.vx;
        ghost.distance = s.distance != null ? s.distance : ghost.distance;
        if (s.nitro) ghost.nitroTimer = 0.2;
      }
    }
  },

  // ---------------- rendering ----------------
  _render() {
    const ctx = this.ctx, W = this.W, H = this.H;
    ctx.clearRect(0, 0, W, H);
    drawTerrain(ctx, this.terrain, this.camX, W, H);

    for (const pk of this.pickups) if (!pk.taken) drawPickup(ctx, pk, this.camX, this.terrain, W);
    for (const o of this.obstacles) drawObstacle(ctx, o, this.camX, this.terrain, W);

    const fx = 120 + FINISH_DISTANCE - this.camX;
    if (fx > -20 && fx < W + 20) {
      const fy = this.terrain.heightAt(120 + FINISH_DISTANCE);
      ctx.fillStyle = "#fff"; ctx.fillRect(fx - 3, fy - 90, 6, 90);
      ctx.fillStyle = "#e64444";
      ctx.beginPath(); ctx.moveTo(fx + 3, fy - 90); ctx.lineTo(fx + 40, fy - 78); ctx.lineTo(fx + 3, fy - 66); ctx.fill();
    }

    if (this.raceMode === "single") {
      for (const pl of this.players) if (pl.isBot) drawVehicle(ctx, pl, this.camX);
    } else if (this.remoteGhosts) {
      for (const g of this.remoteGhosts.values()) drawVehicle(ctx, g, this.camX);
    }
    const shake = [(Math.random() * 2 - 1) * this.camShake, (Math.random() * 2 - 1) * this.camShake];
    drawVehicle(ctx, this.localPlayer, this.camX, shake);
    this.particles.draw(ctx, this.camX);

    this._renderHud();
  },

  _renderHud() {
    const p = this.localPlayer;
    document.getElementById("hudFuelBar").style.width = clamp(p.fuel / p.fuelCap, 0, 1) * 100 + "%";
    document.getElementById("hudFuelBar").style.background = p.fuel / p.fuelCap > 0.3
      ? "linear-gradient(90deg,#6ee7a8,#39c96b)" : "linear-gradient(90deg,#ff8b8b,#c0392b)";
    document.getElementById("hudDist").textContent = `${Math.round(p.distance)} / ${FINISH_DISTANCE}`;
    const mins = Math.floor(this.raceTime / 60), secs = (this.raceTime % 60).toFixed(1).padStart(4, "0");
    document.getElementById("hudTime").textContent = `${String(mins).padStart(2, "0")}:${secs}`;

    let posText = "";
    if (this.raceMode === "single") {
      const ranked = [...this.players].sort((a, b) => b.distance - a.distance);
      const place = ranked.indexOf(p) + 1;
      posText = `Pos ${place}/${this.players.length}`;
    } else {
      posText = p.deadStall ? "LOW FUEL" : "";
    }
    document.getElementById("hudPos").textContent = posText;

    const pips = document.querySelectorAll("#hudNitroPips .pip");
    pips.forEach((pip, i) => pip.classList.toggle("on", i < p.nitroCharges));
  },
};

// ---------------------------------------------------------------------------------------
// BOOTSTRAP
// ---------------------------------------------------------------------------------------
window.addEventListener("DOMContentLoaded", () => App.init());
