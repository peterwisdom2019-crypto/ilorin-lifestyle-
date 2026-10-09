
const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;

app.set("trust proxy", 1);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    store: new pgSession({
      pool,
      tableName: "session",
      createTableIfMissing: false
    }),
    secret:
      process.env.SESSION_SECRET ||
      "change-this-session-secret-in-render",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 30
    }
  })
);

app.use(express.static(path.join(__dirname, "public")));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      bio TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS follows (
      follower_id INTEGER NOT NULL
        REFERENCES users(id) ON DELETE CASCADE,
      following_id INTEGER NOT NULL
        REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (follower_id, following_id),
      CHECK (follower_id <> following_id)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_follows_following
    ON follows(following_id)
  `);
}

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({
      error: "Please log in first."
    });
  }
  next();
}

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: "connected" });
  } catch (error) {
    console.error("Health check failed:", error);
    res.status(500).json({
      ok: false,
      database: "error"
    });
  }
});

app.post("/api/register", async (req, res) => {
  try {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    const password = String(req.body.password || "");
    const displayName = String(req.body.displayName || "").trim();

    if (!email || !password || !displayName) {
      return res.status(400).json({
        error: "Please complete all fields."
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters."
      });
    }

    const existing = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [email]
    );

    if (existing.rows.length) {
      return res.status(409).json({
        error: "An account with that email already exists."
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3)
       RETURNING id, email, display_name, bio`,
      [email, passwordHash, displayName]
    );

    req.session.userId = result.rows[0].id;

    req.session.save((error) => {
      if (error) {
        console.error("Session save failed:", error);
        return res.status(500).json({
          error: "Account created, but login could not be saved. Please log in."
        });
      }

      res.json({ ok: true, user: result.rows[0] });
    });
  } catch (error) {
    console.error("Registration failed:", error);
    res.status(500).json({ error: "Registration failed." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    const password = String(req.body.password || "");

    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        error: "Invalid email or password."
      });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({
        error: "Invalid email or password."
      });
    }

    req.session.userId = user.id;

    req.session.save((error) => {
      if (error) {
        console.error("Session save failed:", error);
        return res.status(500).json({
          error: "Login session could not be saved. Please try again."
        });
      }

      res.json({
        ok: true,
        user: {
          id: user.id,
          email: user.email,
          display_name: user.display_name,
          bio: user.bio
        }
      });
    });
  } catch (error) {
    console.error("Login failed:", error);
    res.status(500).json({ error: "Login failed." });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error("Logout failed:", error);
      return res.status(500).json({
        error: "Could not log out."
      });
    }

    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

app.get("/api/me", async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.json({ loggedIn: false });
    }

    const result = await pool.query(
      "SELECT id, email, display_name, bio FROM users WHERE id = $1",
      [req.session.userId]
    );

    if (!result.rows.length) {
      return res.json({ loggedIn: false });
    }

    res.json({
      loggedIn: true,
      user: result.rows[0]
    });
  } catch (error) {
    console.error("Could not load account:", error);
    res.status(500).json({
      error: "Could not load account."
    });
  }
});

app.get("/api/profile", requireLogin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, email, display_name, bio FROM users WHERE id = $1",
      [req.session.userId]
    );

    res.json(result.rows[0] || {});
  } catch (error) {
    console.error("Could not load profile:", error);
    res.status(500).json({
      error: "Could not load profile."
    });
  }
});

app.put("/api/profile", requireLogin, async (req, res) => {
  try {
    const displayName = String(req.body.displayName || "").trim();
    const bio = String(req.body.bio || "").trim();

    if (!displayName) {
      return res.status(400).json({
        error: "Display name is required."
      });
    }

    const result = await pool.query(
      `UPDATE users
       SET display_name = $1, bio = $2
       WHERE id = $3
       RETURNING id, email, display_name, bio`,
      [displayName, bio, req.session.userId]
    );

    res.json({
      ok: true,
      user: result.rows[0]
    });
  } catch (error) {
    console.error("Could not update profile:", error);
    res.status(500).json({
      error: "Could not update profile."
    });
  }
});

app.get("/api/members", async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const currentUserId = req.session.userId || null;

    const result = await pool.query(
      `SELECT
         u.id,
         u.display_name,
         u.bio,
         COUNT(DISTINCT f2.follower_id)::int AS followers_count,
         CASE
           WHEN $2::int IS NULL THEN false
           ELSE EXISTS (
             SELECT 1
             FROM follows f3
             WHERE f3.follower_id = $2
               AND f3.following_id = u.id
           )
         END AS is_following
       FROM users u
       LEFT JOIN follows f2 ON f2.following_id = u.id
       WHERE $1 = ''
          OR u.display_name ILIKE '%' || $1 || '%'
          OR COALESCE(u.bio, '') ILIKE '%' || $1 || '%'
       GROUP BY u.id
       ORDER BY u.display_name ASC`,
      [search, currentUserId]
    );

    res.json({ members: result.rows });
  } catch (error) {
    console.error("Could not load members:", error);
    res.status(500).json({
      error: "Could not load members."
    });
  }
});

app.post("/api/follow/:id", requireLogin, async (req, res) => {
  try {
    const followingId = Number(req.params.id);

    if (!Number.isInteger(followingId) || followingId <= 0) {
      return res.status(400).json({ error: "Invalid user." });
    }

    if (followingId === Number(req.session.userId)) {
      return res.status(400).json({
        error: "You cannot follow yourself."
      });
    }

    const target = await pool.query(
      "SELECT id FROM users WHERE id = $1",
      [followingId]
    );

    if (!target.rows.length) {
      return res.status(404).json({
        error: "Member not found."
      });
    }

    await pool.query(
      `INSERT INTO follows (follower_id, following_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.session.userId, followingId]
    );

    res.json({ ok: true });
  } catch (error) {
    console.error("Could not follow user:", error);
    res.status(500).json({
      error: "Could not follow user."
    });
  }
});

app.delete("/api/follow/:id", requireLogin, async (req, res) => {
  try {
    const followingId = Number(req.params.id);

    await pool.query(
      `DELETE FROM follows
       WHERE follower_id = $1 AND following_id = $2`,
      [req.session.userId, followingId]
    );

    res.json({ ok: true });
  } catch (error) {
    console.error("Could not unfollow user:", error);
    res.status(500).json({
      error: "Could not unfollow user."
    });
  }
});

app.get("/api/following", requireLogin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.display_name, u.bio
       FROM follows f
       JOIN users u ON u.id = f.following_id
       WHERE f.follower_id = $1
       ORDER BY f.created_at DESC`,
      [req.session.userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Could not load following list:", error);
    res.status(500).json({
      error: "Could not load following list."
    });
  }
});

app.get("/account", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "account.html"));
});

app.get("/social", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "social.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Express 5-compatible catch-all route
app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Ilorin Lifestyle running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
