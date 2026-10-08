const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    store: new pgSession({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET || "change-this-session-secret-in-render",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  })
);

app.use(express.static(path.join(__dirname, "public")));

const districts = [
  {id:"square", name:"City Square", icon:"ðï¸", desc:"Meet people, explore and hang out."},
  {id:"food", name:"Food Street", icon:"ð²", desc:"Discover food spots and social rooms."},
  {id:"arts", name:"Arts Quarter", icon:"ð¨", desc:"Art, music, creativity and culture."},
  {id:"night", name:"Nightlife District", icon:"ð", desc:"Events, games and evening hangouts."},
  {id:"market", name:"Ilorin Market", icon:"ðï¸", desc:"Virtual shops and local businesses."},
  {id:"wellness", name:"Wellness Park", icon:"ð³", desc:"Relax, connect and enjoy the park."}
];

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name VARCHAR(80) NOT NULL,
      avatar_url TEXT,
      bio TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS users_display_name_idx
    ON users (LOWER(display_name));
  `);

  console.log("PostgreSQL database ready.");
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "You must be logged in." });
  }
  next();
}

app.get("/api/health", async (_, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "Ilorin Lifestyle", database: "connected" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, database: "error" });
  }
});

app.get("/api/city", (_, res) => {
  res.json({ name: "Ilorin Lifestyle", districts });
});

app.post("/api/register", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const displayName = String(req.body.displayName || "").trim();

    if (!email || !password || !displayName) {
      return res.status(400).json({ error: "Email, password and display name are required." });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }

    if (displayName.length < 2 || displayName.length > 80) {
      return res.status(400).json({ error: "Display name must be 2â80 characters." });
    }

    const existing = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [email]
    );

    if (existing.rowCount) {
      return res.status(409).json({ error: "An account with that email already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3)
       RETURNING id, email, display_name, avatar_url, bio, created_at`,
      [email, passwordHash, displayName]
    );

    req.session.userId = result.rows[0].id;

    res.status(201).json({
      message: "Account created.",
      user: result.rows[0]
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not create account." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (!result.rowCount) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    req.session.userId = user.id;

    res.json({
      message: "Logged in.",
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
        bio: user.bio
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not log in." });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      return res.status(500).json({ error: "Could not log out." });
    }
    res.clearCookie("connect.sid");
    res.json({ message: "Logged out." });
  });
});

app.get("/api/me", async (req, res) => {
  if (!req.session.userId) {
    return res.json({ user: null });
  }

  try {
    const result = await pool.query(
      `SELECT id, email, display_name, avatar_url, bio, created_at
       FROM users WHERE id = $1`,
      [req.session.userId]
    );

    if (!result.rowCount) {
      req.session.destroy(() => {});
      return res.json({ user: null });
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load account." });
  }
});

app.put("/api/profile", requireAuth, async (req, res) => {
  try {
    const displayName = String(req.body.displayName || "").trim();
    const bio = String(req.body.bio || "").trim();
    const avatarUrl = String(req.body.avatarUrl || "").trim();

    if (displayName.length < 2 || displayName.length > 80) {
      return res.status(400).json({ error: "Display name must be 2â80 characters." });
    }

    const result = await pool.query(
      `UPDATE users
       SET display_name = $1, bio = $2, avatar_url = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING id, email, display_name, avatar_url, bio, created_at`,
      [displayName, bio, avatarUrl || null, req.session.userId]
    );

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not update profile." });
  }
});

app.get("/account", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "account.html"));
});

app.get("/{*splat}", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Ilorin Lifestyle running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
