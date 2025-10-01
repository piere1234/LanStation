console.log("Connecting to DB...");
require("dotenv").config();
console.log("DB URL:", process.env.DATABASE_URL);

const express = require("express");
const session = require("express-session");
const pg = require("pg");
const bcrypt = require("bcryptjs");
const pgSession = require("connect-pg-simple")(session);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// PostgreSQL pool
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

// Session middleware
app.use(
  session({
    store: new pgSession({
      pool: pool,
      tableName: "session",
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }, // 30 days
  })
);

app.use(express.static("public"));


// Signup route
app.post("/signup", async (req, res) => {
  const { username, password } = req.body;

  const hashedPassword = await bcrypt.hash(password, 10);

  try {
    await pool.query("INSERT INTO users (username, password) VALUES ($1, $2)", [
      username,
      hashedPassword,
    ]);
    res.send("User registered successfully!");
  } catch (err) {
    res.status(400).send("User already exists.");
  }
});

// Login route
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  const result = await pool.query("SELECT * FROM users WHERE username=$1", [
    username,
  ]);

  if (result.rows.length === 0) return res.status(400).send("User not found");

  const user = result.rows[0];

  const isValid = await bcrypt.compare(password, user.password);
  if (!isValid) return res.status(400).send("Invalid password");

  req.session.userId = user.id;
  res.send("Logged in successfully!");
});

// Protected route
app.get("/dashboard", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).send("Not authorized");
  }
  res.send("Welcome to your dashboard!");
});

// Logout
app.post("/logout", (req, res) => {
  req.session.destroy();
  res.send("Logged out.");
});

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
