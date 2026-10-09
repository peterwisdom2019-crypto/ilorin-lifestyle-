 } catch (error) {
    console.error("Could not load account:", error);
    res.status(500).json({ error: "Could not load account." });
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
    res.status(500).json({ error: "Could not load profile." });
  }
});

app.put("/api/profile", requireLogin, async (req, res) => {
  try {
    const displayName = String(req.body.displayName || "").trim();
    const bio = String(req.body.bio || "").trim();

    if (!displayName) {
      return res.status(400).json({ error: "Display name is required." });
    }

    const result = await pool.query(
      `UPDATE users
       SET display_name = $1, bio = $2
       WHERE id = $3
       RETURNING id, email, display_name, bio`,
      [displayName, bio, req.session.userId]
    );
    res.json({ ok: true, user: result.rows[0] });
  } catch (error) {
    console.error("Could not update profile:", error);
    res.status(500).json({ error: "Could not update profile." });
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
    res.status(500).json({ error: "Could not load members." });
  }
});

app.post("/api/follow/:id", requireLogin, async (req, res) => {
  try {
    const followingId = Number(req.params.id);
    if (!Number.isInteger(followingId) || followingId <= 0) {
      return res.status(400).json({ error: "Invalid user." });
    }
    if (followingId === Number(req.session.userId)) {
      return res.status(400).json({ error: "You cannot follow yourself." });
    }

    const target = await pool.query("SELECT id FROM users WHERE id = $1", [followingId]);
    if (!target.rows.length) {
      return res.status(404).json({ error: "Member not found." });
    }

    await pool.query(
      `INSERT INTO follows (follower_id, following_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.session.userId, followingId]
    );
    res.json({ ok: true });
  } catch (error) {
    console.error("Could not follow user:", error);
    res.status(500).json({ error: "Could not follow user." });
  }
});

app.delete("/api/follow/:id", requireLogin, async (req, res) => {
  try {
    const followingId = Number(req.params.id);
    await pool.query(
      "DELETE FROM follows WHERE follower_id = $1 AND following_id = $2",
      [req.session.userId, followingId]
    );
    res.json({ ok: true });
  } catch (error) {
    console.error("Could not unfollow user:", error);
    res.status(500).json({ error: "Could not unfollow user." });
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
    res.status(500).json({ error: "Could not load following list." });
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

// Express 5-compatible catch-all. Keep this syntax.
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
