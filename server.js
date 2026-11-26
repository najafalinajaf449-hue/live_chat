const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "iamnajaf321";
const DATA_FILE = path.join(__dirname, "chat-data.json");

app.use(express.static(path.join(__dirname)));

let messages = []; // { id, sender, text, time, socketId }
const blockedIPs = new Set();
const blockedSocketIds = new Set();

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (Array.isArray(raw.messages)) messages = raw.messages.slice(-300);
    if (Array.isArray(raw.blockedIPs)) {
      raw.blockedIPs.forEach((ip) => blockedIPs.add(ip));
    }
  } catch (err) {
    console.error("Failed to load chat-data.json:", err.message);
  }
}

function saveData() {
  try {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(
        {
          messages,
          blockedIPs: [...blockedIPs],
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error("Failed to save chat-data.json:", err.message);
  }
}

loadData();

function getClientIp(socket) {
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return socket.handshake.address || "unknown";
}

function getUsersSnapshot(includeIp = false) {
  const list = [];
  for (const [, s] of io.sockets.sockets) {
    const ip = s.data.ip || getClientIp(s);
    if (s.data.isAdmin || blockedSocketIds.has(s.id) || blockedIPs.has(ip)) {
      continue;
    }
    const item = {
      socketId: s.id,
      name: s.data.name || "Guest",
    };
    if (includeIp) item.ip = ip;
    list.push(item);
  }
  return list;
}

function broadcastUsers() {
  io.emit("users:list", getUsersSnapshot(false));
  io.to("admins").emit("admin:users", getUsersSnapshot(true));
}

io.on("connection", (socket) => {
  const ip = getClientIp(socket);
  socket.data.ip = ip;
  socket.data.name = `Guest_${socket.id.slice(0, 4)}`;
  socket.data.isAdmin = false;

  if (blockedIPs.has(ip) || blockedSocketIds.has(socket.id)) {
    socket.emit("system:blocked", "You are blocked from joining this chat.");
    socket.disconnect(true);
    return;
  }

  // Send current chat history to newly connected user
  socket.emit("chat:history", messages);
  broadcastUsers();

  // Set or update custom display name
  socket.on("user:setName", (rawName) => {
    const clean = String(rawName || "").trim().slice(0, 24);
    if (!clean) return;
    socket.data.name = clean;
    socket.emit("user:nameConfirmed", clean);
    broadcastUsers();
  });

  // Admin login
  socket.on("admin:login", (secret) => {
    if (String(secret) === ADMIN_SECRET) {
      socket.data.isAdmin = true;
      socket.join("admins");
      socket.emit("admin:auth", { ok: true });
      socket.emit("admin:users", getUsersSnapshot(true));
      socket.emit("chat:history", messages);
    } else {
      socket.emit("admin:auth", { ok: false, error: "Invalid admin key" });
    }
  });

  // Typing indicator
  socket.on("chat:typing", (isTyping) => {
    if (blockedSocketIds.has(socket.id) || blockedIPs.has(ip)) return;
    socket.broadcast.emit("chat:typing", {
      name: socket.data.name,
      isTyping: Boolean(isTyping),
    });
  });

  // New chat message
  socket.on("chat:message", (rawText) => {
    if (blockedSocketIds.has(socket.id) || blockedIPs.has(ip)) {
      socket.emit("system:blocked", "You are blocked from sending messages.");
      return;
    }

    const text = String(rawText || "").trim().slice(0, 1000);
    if (!text) return;

    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      sender: socket.data.name,
      text,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      socketId: socket.id,
    };

    messages.push(msg);
    if (messages.length > 300) messages = messages.slice(-300);
    saveData();

    io.emit("chat:message", msg);
  });

  // ADMIN: Delete a specific message
  socket.on("admin:deleteMessage", (msgId) => {
    if (!socket.data.isAdmin) return;
    messages = messages.filter((m) => m.id !== msgId);
    saveData();
    io.emit("chat:deleteMessage", msgId);
  });

  // ADMIN: Refresh / clear chat history
  socket.on("admin:clearHistory", () => {
    if (!socket.data.isAdmin) return;
    messages = [];
    saveData();
    io.emit("chat:history", []);
  });

  // ADMIN: Block a user by socketId & IP
  socket.on("admin:blockUser", (targetSocketId) => {
    if (!socket.data.isAdmin) return;
    const target = io.sockets.sockets.get(targetSocketId);
    if (target) {
      blockedSocketIds.add(target.id);
      if (target.data.ip) blockedIPs.add(target.data.ip);
      saveData();
      target.emit("system:blocked", "You have been blocked by the admin.");
      target.disconnect(true);
    }
    broadcastUsers();
  });

  socket.on("disconnect", () => {
    socket.broadcast.emit("chat:typing", { name: socket.data.name, isTyping: false });
    broadcastUsers();
  });
});

server.listen(PORT, () => {
  console.log(`Chat server running at http://localhost:${PORT}`);
});