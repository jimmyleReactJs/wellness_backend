// index.js

const express   = require('express');
const mysql     = require('mysql2/promise');
const cors      = require('cors');
const multer    = require('multer');
const path      = require('path');
const fs        = require('fs');
const ffmpeg    = require('fluent-ffmpeg');
const ffmpegInstaller  = require('@ffmpeg-installer/ffmpeg');

const app = express();
app.use(cors());
app.use(express.json());
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// ────────────────────────────────────────────────────────────────────────────────
// MySQL pool configuration
// ────────────────────────────────────────────────────────────────────────────────
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

// ────────────────────────────────────────────────────────────────────────────────
// Ensure upload directories exist
// ────────────────────────────────────────────────────────────────────────────────
const uploadsRoot = path.join(__dirname, 'uploads');
const avatarsDir  = path.join(uploadsRoot, 'avatars');
const videosDir   = path.join(uploadsRoot, 'videos');

fs.mkdirSync(avatarsDir, { recursive: true });
fs.mkdirSync(videosDir,  { recursive: true });

// ────────────────────────────────────────────────────────────────────────────────
// Multer storage configurations
// ────────────────────────────────────────────────────────────────────────────────

// Avatars
const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, avatarsDir),
  filename:    (_req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext);
    cb(null, `${name}-${Date.now()}${ext}`);
  },
});
const uploadAvatar = multer({ storage: avatarStorage });

// Videos (for both video_file & optional thumbnail_file)
const videoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, videosDir),
  filename:    (_req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext);
    cb(null, `${name}-${Date.now()}${ext}`);
  },
});
const upload = multer({ storage: videoStorage });
const uploadFields = upload.fields([
  { name: 'video_file',     maxCount: 1 },
  { name: 'thumbnail_file', maxCount: 1 },
]);

// ────────────────────────────────────────────────────────────────────────────────
// Middleware
// ────────────────────────────────────────────────────────────────────────────────

// Log all incoming requests
app.use((req, res, next) => {
  console.log(`→ ${req.method} ${req.originalUrl}`);
  next();
});

// Serve uploads via /static
app.use('/static', express.static(uploadsRoot));
// Also serve videos directory under /uploads/videos
app.use('/uploads/videos', express.static(videosDir));

// ────────────────────────────────────────────────────────────────────────────────
// Routes
// ────────────────────────────────────────────────────────────────────────────────

// Health check
app.get('/', (_req, res) => {
  res.send('🟢 API is running');
});

// ────────────────────────────────────────────────────────────────────────────────
// SIGNUP
// ────────────────────────────────────────────────────────────────────────────────
app.post('/signup', async (req, res) => {
  const now = new Date();
  const { firstName, lastName, email, svsuId, username, password } = req.body;
  try {
    const [result] = await pool.execute(
      `INSERT INTO users
         (first_name, last_name, email, svsu_id, username, password, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [firstName, lastName, email, svsuId, username, password, now]
    );
    res.json({ success: true, userId: result.insertId });
  } catch (err) {
    console.error('Signup error:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        success: false,
        message: 'Email, SVSU ID, or Username already in use'
      });
    }
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// LOGIN
// ────────────────────────────────────────────────────────────────────────────────
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const [rows] = await pool.execute(
      `SELECT id, username, is_admin
         FROM users
        WHERE username = ? AND password = ?
        LIMIT 1`,
      [username, password]
    );
    if (rows.length) {
      return res.json({ success: true, user: rows[0] });
    }
    res.status(401).json({ success: false, message: 'Invalid credentials' });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// FETCH PROFILE
// ────────────────────────────────────────────────────────────────────────────────
app.get('/profile', async (req, res) => {
  const username = req.query.username;
  if (!username) {
    return res.status(400).json({ success: false, message: 'Missing username' });
  }
  try {
    const [rows] = await pool.execute(
      `SELECT
         first_name           AS firstName,
         last_name            AS lastName,
         email,
         svsu_id              AS svsuId,
         created_at           AS joinedDate,
         birthday,
         gender,
         height,
         weight,
         fitness_level        AS fitnessLevel,
         profile_image_url    AS profileImageUrl
       FROM users
       WHERE username = ?
       LIMIT 1`,
      [username]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /profile error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// DELETE ACCOUNT
// ────────────────────────────────────────────────────────────────────────────────
app.delete('/profile', async (req, res) => {
  const username = req.query.username;
  if (!username) {
    return res.status(400).json({ success: false, message: 'Missing username' });
  }
  try {
    const [result] = await pool.execute(
      'DELETE FROM users WHERE username = ?',
      [username]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.json({ success: true, message: 'Account deleted' });
  } catch (err) {
    console.error('DELETE /profile error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// UPLOAD AVATAR
// ────────────────────────────────────────────────────────────────────────────────
app.post('/profile/avatar', uploadAvatar.single('avatar'), async (req, res) => {
  const username = req.query.username;
  if (!username) {
    return res.status(400).json({ success: false, message: 'Missing username' });
  }
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded' });
  }
  const relativePath = `/static/avatars/${req.file.filename}`;
  const fullUrl = `${req.protocol}://${req.get('host')}${relativePath}`;
  try {
    await pool.execute(
      'UPDATE users SET profile_image_url = ? WHERE username = ?',
      [fullUrl, username]
    );
    res.json({ success: true, profileImageUrl: fullUrl });
  } catch (err) {
    console.error('UPLOAD AVATAR error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// GET SINGLE USER
// ────────────────────────────────────────────────────────────────────────────────
app.get('/user/:username', async (req, res) => {
  const { username } = req.params;
  try {
    const [rows] = await pool.execute(
      `SELECT
         first_name           AS firstName,
         last_name            AS lastName,
         email,
         svsu_id              AS svsuId,
         created_at           AS joinedDate,
         birthday,
         gender,
         height,
         weight,
         fitness_level        AS fitnessLevel,
         profile_image_url    AS profileImageUrl
       FROM users
       WHERE username = ?
       LIMIT 1`,
      [username]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /user/:username error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// FETCH ADMIN PROFILE
// ────────────────────────────────────────────────────────────────────────────────
app.get('/admin', async (req, res) => {
  const { username } = req.query;
  if (!username) {
    return res.status(400).json({ error: 'Missing username' });
  }
  try {
    const [rows] = await pool.execute(
      `SELECT
         first_name           AS firstName,
         last_name            AS lastName,
         id                   AS adminId,
         created_at           AS joinedDate,
         email,
         birthday,
         profile_image_url    AS profileImageUrl
       FROM users
       WHERE is_admin = 1 AND username = ?
       LIMIT 1`,
      [username]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /admin error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// UPLOAD ADMIN AVATAR
// ────────────────────────────────────────────────────────────────────────────────
app.post('/admin/avatar', uploadAvatar.single('avatar'), async (req, res) => {
  const username = req.query.username;
  if (!username) {
    return res.status(400).json({ success: false, message: 'Missing username' });
  }
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded' });
  }
  const relativePath = `/static/avatars/${req.file.filename}`;
  const fullUrl = `${req.protocol}://${req.get('host')}${relativePath}`;
  try {
    await pool.execute(
      'UPDATE users SET profile_image_url = ? WHERE username = ?',
      [fullUrl, username]
    );
    res.json({ success: true, profileImageUrl: fullUrl });
  } catch (err) {
    console.error('UPLOAD ADMIN AVATAR error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// GET VIDEOS BY TOPIC
// ────────────────────────────────────────────────────────────────────────────────
app.get('/videos/topic/:topic', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT
         id,
         title,
         uploader,
         DATE_FORMAT(date, '%Y-%m-%d')       AS date,
         video_url,
         video_topic,
         video_thumbnail_url                AS video_thumbnail_url
       FROM video
       WHERE video_topic = ?
       ORDER BY date DESC`,
      [req.params.topic]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /videos/topic error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// UPLOAD VIDEO (with optional thumbnail)
// ────────────────────────────────────────────────────────────────────────────────
app.post('/videos/upload', uploadFields, async (req, res) => {
  try {
    // 1) Ensure a video_file was uploaded
    const videoArr = req.files?.video_file;
    if (!videoArr?.[0]) {
      return res.status(400).json({ error: 'No video_file uploaded' });
    }
    const videoFile = videoArr[0];
    const videoUrl  = `${req.protocol}://${req.get('host')}/uploads/videos/${videoFile.filename}`;

    // 2) Determine thumbnail—either uploaded or generate via ffmpeg
    let thumbFilename;
    const thumbArr = req.files?.thumbnail_file;
    if (thumbArr?.[0]) {
      thumbFilename = thumbArr[0].filename;
    } else {
      const name = path.basename(videoFile.filename, path.extname(videoFile.filename));
      thumbFilename = `${name}-thumb-${Date.now()}.jpg`;

      await new Promise((resolve, reject) => {
        ffmpeg(path.join(videosDir, videoFile.filename))
          .screenshots({
            timestamps: ['00:00:01'],
            filename:   thumbFilename,
            folder:     videosDir,
            size:       '320x?',
          })
          .on('end', resolve)
          .on('error', reject);
      });
    }
    const thumbnailUrl = `${req.protocol}://${req.get('host')}/uploads/videos/${thumbFilename}`;

    // 3) Determine status based on whether user is admin
    const username = req.query.username;
    if (!username) {
      return res.status(400).json({ error: 'Missing username query parameter' });
    }
    const [[userRow]] = await pool.execute(
      'SELECT is_admin FROM users WHERE username = ? LIMIT 1',
      [username]
    );
    const isAdmin = userRow?.is_admin === 1;
    const status  = isAdmin ? 1 : 0;

    // 4) Extract form fields
    const { title, uploader, video_topic } = req.body;

    // 5) Parse multiple muscles from `target_muscles` field
    let targetMuscles = [];
    const raw = req.body.target_muscles;
    if (raw) {
      if (typeof raw === 'string') {
        // If the client sent a JSON‐serialized array:
        try {
          targetMuscles = JSON.parse(raw);
        } catch {
          // Or if it’s a single string, treat it as a single‐element array
          targetMuscles = [raw];
        }
      } else if (Array.isArray(raw)) {
        targetMuscles = raw;
      }
    }
    const targetMuscle = targetMuscles.join(',');

    // 6) Insert into `video` table
    const date = new Date();
    const [result] = await pool.execute(
      `INSERT INTO video
         (title, uploader, date, video_url, video_topic,
          video_thumbnail_url, video_status, target_muscle)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        title,
        uploader,
        date,
        videoUrl,
        video_topic,
        thumbnailUrl,
        status,
        targetMuscle
      ]
    );

    // 7) Return success
    res.json({
      success:      true,
      videoId:      result.insertId,
      videoUrl,
      thumbnailUrl,
      videoStatus:  status,
    });

  } catch (err) {
    console.error('POST /videos/upload error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// SEARCH VIDEOS
// GET /videos/search?q=your+search+term
// ────────────────────────────────────────────────────────────────────────────────
app.get('/videos/search', async (req, res) => {
  const q = req.query.q?.trim() || '';
  if (!q) {
    return res.status(400).json({ error: 'Missing search query' });
  }

  try {
    const like = `%${q}%`;
    const [rows] = await pool.execute(
      `SELECT
         id,
         title,
         uploader,
         DATE_FORMAT(date, '%Y-%m-%d') AS date,
         video_url,
         video_topic,
         video_status,
         target_muscle,
         video_thumbnail_url
       FROM video
       WHERE title   LIKE ?
          OR uploader LIKE ?
       ORDER BY date DESC`,
      [ like, like ]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /videos/search error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// GET VIDEOS (optionally filter by status)
// GET /videos?status=0   → pending requests
// GET /videos?status=1   → approved library
// ────────────────────────────────────────────────────────────────────────────────
app.get('/videos', async (req, res) => {
  try {
    const { status } = req.query; // “0” or “1”, if present
    let sql = `
      SELECT
        id,
        title,
        uploader,
        DATE_FORMAT(date, '%Y-%m-%d') AS date,
        video_url,
        video_topic,
        video_thumbnail_url,
        video_status,
        target_muscle
      FROM video
    `;
    const params = [];
    if (status !== undefined) {
      sql += ' WHERE video_status = ?';
      params.push(status);
    }
    sql += ' ORDER BY date DESC';

    const [rows] = await pool.execute(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('GET /videos error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// POST /videos/:id/approve
//   - Body: { reason: "some text" }
//   - Sets video_status = 1, stores approve_reason
//   - Returns { success: true, videoId, newStatus: 1, approveReason }
// ────────────────────────────────────────────────────────────────────────────────
app.post('/videos/:id/approve', async (req, res) => {
  const videoId = parseInt(req.params.id, 10);
  const { reason } = req.body;

  if (!reason || reason.trim().length === 0) {
    return res.status(400).json({ error: 'Approve reason is required' });
  }

  try {
    const [result] = await pool.execute(
      `UPDATE video
         SET video_status    = 1,
             approve_reason  = ?
       WHERE id = ?`,
      [reason.trim(), videoId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Video not found' });
    }

    return res.json({
      success:       true,
      videoId,
      newStatus:     1,
      approveReason: reason.trim()
    });
  } catch (err) {
    console.error('POST /videos/:id/approve error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// POST /videos/:id/deny
//   - Body: { reason: "some text" }
//   - Sets video_status = 0, stores deny_reason
//   - Returns { success: true, videoId, newStatus: 0, denyReason }
// ────────────────────────────────────────────────────────────────────────────────
app.post('/videos/:id/deny', async (req, res) => {
  const videoId = parseInt(req.params.id, 10);
  const { reason } = req.body;

  if (!reason || reason.trim().length === 0) {
    return res.status(400).json({ error: 'Deny reason is required' });
  }

  try {
    const [result] = await pool.execute(
      `UPDATE video
         SET video_status = 0,
             deny_reason  = ?
       WHERE id = ?`,
      [reason.trim(), videoId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Video not found' });
    }

    return res.json({
      success:    true,
      videoId,
      newStatus:  0,
      denyReason: reason.trim()
    });
  } catch (err) {
    console.error('POST /videos/:id/deny error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// GET /videos/:id
//   (Optional) Fetch a single video’s data, including approve/deny reasons
// ────────────────────────────────────────────────────────────────────────────────
app.get('/videos/:id', async (req, res) => {
  const videoId = parseInt(req.params.id, 10);
  try {
    const [rows] = await pool.execute(
      `SELECT
         id,
         title,
         uploader,
         date,
         video_url,
         video_topic,
         video_thumbnail_url,
         video_status,
         target_muscle,
         approve_reason,
         deny_reason
       FROM video
       WHERE id = ?`,
      [videoId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Video not found' });
    }
    return res.json(rows[0]);
  } catch (err) {
    console.error('GET /videos/:id error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// Start the server
// ────────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`API listening on port ${PORT}`);
});
