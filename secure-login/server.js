console.log("Connecting to DB...");
require("dotenv").config({ quiet: true });


const path = require("path");
const http = require("http");
const express = require("express");
const session = require("express-session");
const pg = require("pg");
const bcrypt = require("bcryptjs");
const pgSession = require("connect-pg-simple")(session);
const { v4: uuidv4 } = require("uuid");
const app = express();
const server = http.createServer(app);
const io = require("socket.io")(server, { cors: { origin: true, credentials: true } });
const net = require("net");
const mdns = require("multicast-dns")();
const HOSTNAME = "lanstation.local";  

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (!process.env.DATABASE_URL) {
  console.error("[DB] Missing DATABASE_URL. Set it in .env (e.g. postgresql://user:pass@localhost:5432/lanstation)");
}
if (!process.env.SESSION_SECRET) {
  console.warn("[SESSION] Missing SESSION_SECRET. Using a weak default is unsafe.");
}


function noCache(req, res, next) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
  next();
}

function requireAuth(req, res, next) {
  const loggedIn = !!req.session?.userId;
  if (loggedIn) return next();
  if (req.path === "/not_logged_in") return next();
  if (req.method === "GET") req.session.returnTo = req.originalUrl;
  const wantsHTML = req.accepts(["html", "json"]) === "html";
  if (wantsHTML && req.method === "GET") {
    return res.redirect(302, "/not_logged_in");
  }
  return res.status(401).json({ error: "not_authenticated", redirect: "/not_logged_in" });
}

async function requireAdmin(req, res, next) {
  if (!req.session?.userId) { 
    if (req.method === "GET") req.session.returnTo = req.originalUrl;
    const wantsHTML = req.accepts(["html","json"]) === "html";
    return wantsHTML && req.method === "GET"
      ? res.redirect(302, "/not_logged_in")      
      : res.status(401).json({ error: "not_authenticated", redirect: "/not_logged_in" });
  }

  try {
    const { rows } = await pool.query(
      "SELECT is_admin FROM users WHERE id = $1",
      [req.session.userId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: "user_not_found" });
    }
    if (rows[0].is_admin) return next();
    if (req.path === "/not_admin") return next();
    if (req.method === "GET") req.session.returnTo = req.originalUrl;
    const wantsHTML = req.accepts(["html","json"]) === "html";
    return wantsHTML && req.method === "GET"
      ? res.redirect(302, "/not_admin")
      : res.status(403).json({ error: "not_admin", redirect: "/not_admin" });
  } catch (e) {
    next(e);
  }
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

const sessionStore = new pgSession({
  pool,
  tableName: "session",
  createTableIfMissing: true,
});

const sessionMiddleware = session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || "replace-me",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 60 * 60 * 1000, sameSite: "lax", path: "/" },
});
app.use(sessionMiddleware);

io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

const presence = new Map();

// Broadcast users, including port 6112 status
function broadcastPresence() {
  const users = [...presence.entries()].map(([id, u]) => ({
    id,
    name: u.name,
    online: u.sockets.size > 0,
    port6112Open: !!u.port6112Open,
  }));
  io.emit("presence:list", users);
}

// Helper: extract client IP from socket (handles ::ffff:192.168.1.x)
function getClientIp(socket) {
  let ip =
    socket.handshake?.address ||
    socket.request?.connection?.remoteAddress ||
    "";
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return ip;
}

// Check if TCP port 6112 is open on host
function checkPort6112(host, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: 6112 });

    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);

    socket.once("connect", () => {
      finish(true);
    });

    socket.once("timeout", () => {
      finish(false);
    });

    socket.once("error", () => {
      finish(false);
    });
  });
}

// Periodically poll all online users for port 6112 status
async function pollUsersPort6112() {
  const entries = [...presence.entries()].filter(
    ([, u]) => u.sockets.size > 0 && u.ip
  );

  for (const [userId, user] of entries) {
    try {
      const open = await checkPort6112(user.ip);
      if (user.port6112Open !== open) {
        user.port6112Open = open;
        broadcastPresence(); // update UI when something changes
      }
    } catch (err) {
      console.error("[PORT6112] Error checking", user.ip, err.message || err);
    }
  }
}

// Run every 15 seconds
setInterval(() => {
  pollUsersPort6112().catch((e) =>
    console.error("[PORT6112] poll error", e.message || e)
  );
}, 15000);


io.on("connection", (socket) => {
  const sess = socket.request.session;
  const userId = sess?.userId;
  const username = sess?.username;

  if (!userId) {
    socket.disconnect(true);
    return;
  }

  const ip = getClientIp(socket); // ⬅️ NEW

  if (!presence.has(userId)) {
    presence.set(userId, {
      name: username || `User ${userId}`,
      sockets: new Set(),
      ip,
      port6112Open: false,
    });
  }

  const entry = presence.get(userId);
  entry.sockets.add(socket.id);
  entry.ip = ip; // update last known IP

  socket.emit("me", { id: userId, name: entry.name });
  broadcastPresence();

  socket.on("file:offer", ({ toUserId, fileName, fileSize, mime }) => {
    if (!toUserId || !fileName || !Number.isFinite(fileSize)) return;
    if (fileSize > 100 * 1024 * 1024 * 1024) {
      socket.emit("file:error", { message: "File too large (limit 100 GB)" });
      return;
    }
    const rec = presence.get(toUserId);
    if (!rec || rec.sockets.size === 0) {
      socket.emit("file:error", { message: "Recipient is offline" });
      return;
    }
    const fileId = uuidv4();
    for (const sid of rec.sockets) {
      io.to(sid).emit("file:offer", {
        fromUserId: userId,
        fromName: entry.name,
        fileId,
        fileName,
        fileSize,
        mime,
      });
    }
    socket.emit("file:offered", { fileId });
  });

  socket.on("file:accept", ({ fileId, fromUserId, accept }) => {
    const sender = presence.get(fromUserId);
    if (!sender) return;
    for (const sid of sender.sockets) {
      io.to(sid).emit("file:accept", {
        fileId,
        accept,
        toUserId: userId,
        toName: entry.name,
      });
    }
  });

  socket.on("file:chunk", ({ fileId, toUserId, seq, done, chunk }) => {
    const rec = presence.get(toUserId);
    if (!rec) return;
    for (const sid of rec.sockets) {
      io.to(sid).emit("file:chunk", {
        fileId,
        fromUserId: userId,
        seq,
        done,
        chunk,
      });
    }
  });

  socket.on("disconnect", () => {
    const entry = presence.get(userId);
    if (entry) {
      entry.sockets.delete(socket.id);
    }
    broadcastPresence();
  });
});


app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/not_logged_in", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "not_logged_in.html"))
});

app.get("/not_admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "not_admin.html"))
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/signup", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "signup.html"));
});

app.get("/signup_admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "signup_admin.html" ))
});

app.get("/help", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "help.html"));
});

app.get("/api/me", requireAuth, (req, res) => {
    res.json({
    loggedIn: true,
    id: req.session.userId,
    username: req.session.username,
  });
});


app.post("/admin/truncate", requireAdmin, async (req, res, next) => {
  try {
    const { confirm } = req.body || {};
    if (confirm !== "YES_TRUNCATE_USERS") {
      return res.status(400).send('Add JSON body { "confirm": "YES_TRUNCATE_USERS" }');
    }
    const store = sessionMiddleware.store;
    if (store && typeof store.clear === "function") {
      await new Promise((resolve, reject) => store.clear(err => err ? reject(err) : resolve()));
    } else {
      await pool.query('DELETE FROM "session";');
    }
    await pool.query("TRUNCATE TABLE users RESTART IDENTITY CASCADE;");
    for (const [, socket] of io.sockets.sockets) socket.disconnect(true);
    if (typeof presence?.clear === "function") presence.clear();
    res.clearCookie("connect.sid", { path: "/", sameSite: "lax" });

    return res.status(200).send("Users truncated. All sessions destroyed and clients disconnected.");
  } catch (e) {
    next(e);
  }
});


app.post("/signup_admin", async (req, res, next) => {
  try {
    const { username, password, admin_code } = req.body || {};
    if (!username || !password || !admin_code) {
      return res.status(400).send("Missing fields");
    }
    if (admin_code !== process.env.ADMIN_CODE) {
      return res.status(403).send("Invalid admin code");
    }

    const hashed = await bcrypt.hash(password, 10);

    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, is_admin)
       VALUES ($1, $2, TRUE)
       RETURNING id, username, is_admin`,
      [username.trim(), hashed]
    );
    req.session.userId = rows[0].id;
    req.session.username = rows[0].username;

    req.session.save((err) => {
      if (err) return next(err);
      res.status(201).json({ ok: true, is_admin: true });
    });
  } catch (err) {
    if (err.code === "23505") return res.status(400).send("User already exists.");
    next(err);
  }
});


app.get("/signup_admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "signup_admin.html"));
});

app.get("/admin", requireAuth, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "protected", "admin.html"));
});

app.post("/signup_admin", async (req, res, next) => {
  try {
    const { username, password, admin_code } = req.body;
    if (!username || !password || !admin_code) {
      return res.status(400).send("Missing fields");
    }
    if (admin_code !== process.env.ADMIN_CODE) {
      return res.status(403).send("Invalid admin code");
    }
    const hashed = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, is_admin)
       VALUES ($1, $2, TRUE)
       RETURNING id, username, is_admin`,
      [username.trim(), hashed]
    );
    req.session.userId = rows[0].id;
    req.session.username = rows[0].username;
    req.session.save(err => {
      if (err) return next(err);
      res.status(201).json({ ok: true, message: "Admin created", is_admin: true });
    });
  } catch (err) {
    if (err.code === "23505") return res.status(400).send("User already exists.");
    next(err);
  }
});

app.post("/signup", async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send("Missing fields");
    const hashed = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash)
       VALUES ($1, $2)
       RETURNING id, username`,
      [username.trim(), hashed]
    );
    const user = rows[0];
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.save((err) => {
      if (err) return next(err);
      res.status(201).json({ ok: true, message: "Signed up & logged in", username: user.username });
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).send("User already exists.");
    }
    next(err);
  }
});

app.post("/login", noCache, async (req, res, next) => {
  try {
    const { username, password } = req.body;

    const result = await pool.query(
      "SELECT id, username, password_hash FROM users WHERE username=$1",
      [username]
    );
    if (result.rows.length === 0) return res.status(400).send("User not found");

    const user = result.rows[0];
    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) return res.status(400).send("Invalid password");

    req.session.userId = user.id;
    req.session.username = user.username;
    res.send("Logged in successfully!");
  } catch (e) {
    next(e);
  }
});

app.get("/dashboard", requireAuth, noCache, (req, res) => {
  res.sendFile(path.join(__dirname, "protected", "dashboard.html"));
});

app.post("/logout", (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie("connect.sid");
    res.send("Logged out");
  });
});

app.use((err, req, res, next) => {
  const code = String(err.code || "").toUpperCase();
  const isDbConnIssue =
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "ECONNRESET";

  if (isDbConnIssue) {
    return res
      .status(503)
      .send("Cannot connect to database. See /help for setup, then try again.");
  }

  if (process.env.NODE_ENV === "production") {
    console.error(err);
    return res.status(500).send("Unexpected error");
  }

  return res.status(500).send(`<pre>${err.stack || err}</pre>`);
});


const PORT = process.env.PORT || 80;
const HOST = process.env.HOST;

const os = require("os");
function getLanIPv4(intName) {
  const nets = os.networkInterfaces();
  const NIC = nets[intName];
  if (!NIC) return "127.0.0.1";
  for (const a of NIC) {
    if (a.family === "IPv4" && !a.internal) {
      return a.address;
    }
  }
  return "127.0.0.1";
}

const LAN_IP = getLanIPv4("Wi-Fi");
server.listen(PORT, HOST || LAN_IP, () => {
  console.log(`Server running on http://${LAN_IP}:${PORT}`);
});

console.log(`[mDNS] Advertising ${HOSTNAME} -> ${LAN_IP}`);

mdns.on("query", (packet) => {
  for (const q of packet.questions || []) {
    const name = (q.name || "").toLowerCase().replace(/\.$/, "");
    if (name === HOSTNAME && (q.type === "A" || q.type === "ANY")) {
      console.log(`[mDNS] Answering A for ${HOSTNAME} with ${LAN_IP}`);

      mdns.respond({
        answers: [
          {
            name: HOSTNAME,
            type: "A",
            ttl: 120,
            data: LAN_IP,
          },
        ],
      });
    }
  }
});
