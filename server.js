
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

const db = new sqlite3.Database(path.join(__dirname, 'squadr.db'));

const generateToken = () => crypto.randomBytes(16).toString('hex');
const hash = (p) => crypto.createHash('sha256').update(p).digest('hex');

// Initialize Database Schema with Bio support
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    avatar TEXT,
    bio TEXT DEFAULT 'Aesthetic Visual Creator 🌸',
    token TEXT
  )`);

  // Ensure bio column exists if upgraded
  db.run(`ALTER TABLE users ADD COLUMN bio TEXT DEFAULT 'Aesthetic Visual Creator 🌸'`, () => {});

  db.run(`CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    caption TEXT,
    image_url TEXT,
    post_type TEXT DEFAULT 'post',
    likes INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER,
    user_id INTEGER,
    comment_text TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(post_id) REFERENCES posts(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER,
    receiver_id INTEGER,
    message_text TEXT,
    shared_post_id INTEGER DEFAULT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(sender_id) REFERENCES users(id),
    FOREIGN KEY(receiver_id) REFERENCES users(id)
  )`);
});

// --- AUTHENTICATION & PROFILE ---

app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username & password required.' });

  const avatar = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(username)}`;
  const hashedPassword = hash(password);

  db.run("INSERT INTO users (username, password, avatar, bio) VALUES (?, ?, ?, ?)", 
    [username, hashedPassword, avatar, 'Aesthetic Visual Creator 🌸'], 
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username already taken.' });
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true, message: 'Account created successfully!' });
    }
  );
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const hashedPassword = hash(password);

  db.get("SELECT id, username, avatar, bio FROM users WHERE username = ? AND password = ?", 
    [username, hashedPassword], 
    (err, user) => {
      if (err || !user) return res.status(401).json({ error: 'Invalid credentials.' });
      const token = generateToken();
      db.run("UPDATE users SET token = ? WHERE id = ?", [token, user.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ user, token });
      });
    }
  );
});

app.get('/api/auth/me', (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'Unauthorized.' });

  db.get("SELECT id, username, avatar, bio FROM users WHERE token = ?", [token], (err, user) => {
    if (err || !user) return res.status(401).json({ error: 'Unauthorized.' });
    
    db.all("SELECT * FROM posts WHERE user_id = ?", [user.id], (err, myPosts) => {
      const postsCount = myPosts ? myPosts.length : 0;
      const totalLikes = myPosts ? myPosts.reduce((acc, curr) => acc + (curr.likes || 0), 0) : 0;
      res.json({ ...user, posts_count: postsCount, total_likes: totalLikes });
    });
  });
});

app.post('/api/users/profile', (req, res) => {
  const token = req.headers.authorization;
  const { avatar, bio } = req.body;

  db.get("SELECT id FROM users WHERE token = ?", [token], (err, me) => {
    if (err || !me) return res.status(401).json({ error: 'Unauthorized.' });

    db.run("UPDATE users SET avatar = COALESCE(?, avatar), bio = COALESCE(?, bio) WHERE id = ?",
      [avatar || null, bio || null, me.id],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      }
    );
  });
});

app.get('/api/users', (req, res) => {
  const token = req.headers.authorization;
  db.get("SELECT id FROM users WHERE token = ?", [token], (err, me) => {
    if (err || !me) return res.status(401).json({ error: 'Unauthorized.' });
    db.all("SELECT id, username, avatar, bio FROM users WHERE id != ?", [me.id], (err, rows) => {
      res.json(rows || []);
    });
  });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.headers.authorization;
  db.run("UPDATE users SET token = NULL WHERE token = ?", [token]);
  res.json({ success: true });
});

// --- POSTS ---

app.get('/api/posts', (req, res) => {
  const query = `
    SELECT posts.*, users.username, users.avatar 
    FROM posts 
    JOIN users ON posts.user_id = users.id 
    ORDER BY posts.id DESC
  `;

  db.all(query, [], (err, posts) => {
    if (err) return res.status(500).json({ error: err.message });

    const commentsQuery = `
      SELECT comments.*, users.username 
      FROM comments 
      JOIN users ON comments.user_id = users.id 
      ORDER BY comments.id ASC
    `;

    db.all(commentsQuery, [], (err, comments) => {
      const feed = (posts || []).map(p => ({
        ...p,
        comments: (comments || []).filter(c => c.post_id === p.id)
      }));
      res.json(feed);
    });
  });
});

app.post('/api/posts', (req, res) => {
  const { caption, image_url, post_type } = req.body;
  const token = req.headers.authorization;

  db.get("SELECT id FROM users WHERE token = ?", [token], (err, user) => {
    if (err || !user) return res.status(401).json({ error: 'Login required.' });

    const img = image_url || `https://picsum.photos/seed/${Math.floor(Math.random() * 1000)}/600/800`;

    db.run("INSERT INTO posts (user_id, caption, image_url, post_type) VALUES (?, ?, ?, ?)",
      [user.id, caption || '', img, post_type || 'post'],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID });
      }
    );
  });
});

app.post('/api/posts/:id/like', (req, res) => {
  db.run("UPDATE posts SET likes = likes + 1 WHERE id = ?", [req.params.id], (err) => {
    res.json({ success: true });
  });
});

app.post('/api/comments', (req, res) => {
  const { post_id, comment_text } = req.body;
  const token = req.headers.authorization;

  db.get("SELECT id, username FROM users WHERE token = ?", [token], (err, user) => {
    if (err || !user) return res.status(401).json({ error: 'Login required.' });

    db.run("INSERT INTO comments (post_id, user_id, comment_text) VALUES (?, ?, ?)", 
      [post_id, user.id, comment_text], 
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, post_id, username: user.username, comment_text });
      }
    );
  });
});

// --- MESSAGES & POST SHARING ---

app.get('/api/messages/:other_user_id', (req, res) => {
  const token = req.headers.authorization;
  const otherUserId = req.params.other_user_id;

  db.get("SELECT id FROM users WHERE token = ?", [token], (err, me) => {
    if (err || !me) return res.status(401).json({ error: 'Unauthorized.' });

    const query = `
      SELECT messages.*, posts.image_url as shared_image, posts.caption as shared_caption
      FROM messages 
      LEFT JOIN posts ON messages.shared_post_id = posts.id
      WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
      ORDER BY messages.id ASC
    `;

    db.all(query, [me.id, otherUserId, otherUserId, me.id], (err, rows) => {
      res.json(rows || []);
    });
  });
});

app.post('/api/messages', (req, res) => {
  const { receiver_id, message_text, shared_post_id } = req.body;
  const token = req.headers.authorization;

  db.get("SELECT id FROM users WHERE token = ?", [token], (err, me) => {
    if (err || !me) return res.status(401).json({ error: 'Unauthorized.' });

    db.run("INSERT INTO messages (sender_id, receiver_id, message_text, shared_post_id) VALUES (?, ?, ?, ?)",
      [me.id, receiver_id, message_text || '', shared_post_id || null],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID });
      }
    );
  });
});

app.listen(3000, '0.0.0.0', () => console.log('App server running on http://localhost:3000'));