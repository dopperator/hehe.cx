const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'hehecx-dev-secret-change-in-production';

// Database mode: SQLite for local dev, PostgreSQL for production
const USE_POSTGRES = !!process.env.DATABASE_URL;

let db; // SQLite database
let pool; // PostgreSQL pool

// Ensure upload directories exist
const uploadDirs = ['uploads/avatars', 'uploads/backgrounds'];
uploadDirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// ============ DATABASE ABSTRACTION ============

async function initDatabase() {
    if (USE_POSTGRES) {
        // PostgreSQL setup
        const { Pool } = require('pg');
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
        });

        const client = await pool.connect();
        try {
            await client.query(`
                CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    email VARCHAR(255) UNIQUE NOT NULL,
                    username VARCHAR(30) UNIQUE NOT NULL,
                    password VARCHAR(255) NOT NULL,
                    display_name VARCHAR(100),
                    bio TEXT,
                    avatar VARCHAR(500),
                    background VARCHAR(500),
                    background_type VARCHAR(20) DEFAULT 'gradient',
                    gradient_start VARCHAR(10) DEFAULT '#667eea',
                    gradient_end VARCHAR(10) DEFAULT '#764ba2',
                    show_userid BOOLEAN DEFAULT false,
                    is_premium BOOLEAN DEFAULT false,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS links (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    platform VARCHAR(50) NOT NULL,
                    url VARCHAR(500) NOT NULL,
                    display_order INTEGER DEFAULT 0,
                    is_active BOOLEAN DEFAULT true
                );

                CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
                CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
                CREATE INDEX IF NOT EXISTS idx_links_user_id ON links(user_id);
            `);
            console.log('✅ PostgreSQL database initialized');
        } finally {
            client.release();
        }
    } else {
        // SQLite setup (local development)
        const Database = require('better-sqlite3');
        db = new Database('hehecx.db');
        
        db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT UNIQUE NOT NULL,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                display_name TEXT,
                bio TEXT,
                avatar TEXT,
                background TEXT,
                background_type TEXT DEFAULT 'gradient',
                gradient_start TEXT DEFAULT '#667eea',
                gradient_end TEXT DEFAULT '#764ba2',
                show_userid INTEGER DEFAULT 0,
                is_premium INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                platform TEXT NOT NULL,
                url TEXT NOT NULL,
                display_order INTEGER DEFAULT 0,
                is_active INTEGER DEFAULT 1,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
        `);
        console.log('✅ SQLite database initialized (local mode)');
    }
}

// Database query helper - works with both SQLite and PostgreSQL
async function query(sql, params = []) {
    if (USE_POSTGRES) {
        // Convert ? placeholders to $1, $2, etc. for PostgreSQL
        let paramIndex = 0;
        const pgSql = sql.replace(/\?/g, () => `$${++paramIndex}`);
        const result = await pool.query(pgSql, params);
        return result.rows;
    } else {
        // SQLite - determine if it's a SELECT or mutation
        const isSelect = sql.trim().toUpperCase().startsWith('SELECT');
        if (isSelect) {
            return db.prepare(sql).all(...params);
        } else {
            const result = db.prepare(sql).run(...params);
            return { lastInsertRowid: result.lastInsertRowid, changes: result.changes };
        }
    }
}

// Get single row
async function queryOne(sql, params = []) {
    if (USE_POSTGRES) {
        let paramIndex = 0;
        const pgSql = sql.replace(/\?/g, () => `$${++paramIndex}`);
        const result = await pool.query(pgSql, params);
        return result.rows[0];
    } else {
        return db.prepare(sql).get(...params);
    }
}

// Insert and return the new row
async function insertAndReturn(table, data, returnFields = '*') {
    const keys = Object.keys(data);
    const values = Object.values(data);
    
    if (USE_POSTGRES) {
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
        const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING ${returnFields}`;
        const result = await pool.query(sql, values);
        return result.rows[0];
    } else {
        const placeholders = keys.map(() => '?').join(', ');
        const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
        const result = db.prepare(sql).run(...values);
        return db.prepare(`SELECT ${returnFields} FROM ${table} WHERE id = ?`).get(result.lastInsertRowid);
    }
}

// ============ MIDDLEWARE ============

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use('/src', express.static('src'));

app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        maxAge: 30 * 24 * 60 * 60 * 1000,
        sameSite: 'lax'
    },
    proxy: process.env.NODE_ENV === 'production'
}));

if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

// File upload configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const folder = file.fieldname === 'avatar' ? 'uploads/avatars' : 'uploads/backgrounds';
        cb(null, folder);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const fileFilter = (req, file, cb) => {
    const user = req.session.user;
    const isPremium = user?.is_premium;
    
    const allowedTypes = {
        avatar: isPremium ? ['image/png', 'image/gif'] : ['image/png'],
        background: isPremium ? ['image/png', 'image/jpeg', 'image/gif'] : ['image/png', 'image/jpeg']
    };
    
    const fieldAllowed = allowedTypes[file.fieldname] || [];
    
    if (fieldAllowed.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error(`Invalid file type. Allowed: ${fieldAllowed.join(', ')}`), false);
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 100 * 1024 * 1024 }
});

const checkFileSize = (fieldname) => (req, res, next) => {
    const isPremium = req.session?.user?.is_premium;
    const maxSize = isPremium ? 50 * 1024 * 1024 : 10 * 1024 * 1024; // 50MB premium, 10MB free
    
    upload.single(fieldname)(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: `File too large. Max size: ${isPremium ? '50MB' : '10MB'}` });
            }
            return res.status(400).json({ error: err.message });
        } else if (err) {
            return res.status(400).json({ error: err.message });
        }
        
        if (req.file && req.file.size > maxSize) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: `File too large. Max size: ${isPremium ? '50MB' : '10MB'}` });
        }
        
        next();
    });
};

const requireAuth = (req, res, next) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    next();
};

// ============ API ROUTES ============

// Check auth status
app.get('/api/auth/status', async (req, res) => {
    try {
        if (req.session.user) {
            const user = await queryOne(
                `SELECT id, email, username, display_name, bio, avatar, background, 
                        background_type, gradient_start, gradient_end, show_userid, is_premium 
                 FROM users WHERE id = ?`,
                [req.session.user.id]
            );
            res.json({ authenticated: true, user });
        } else {
            res.json({ authenticated: false });
        }
    } catch (error) {
        console.error('Auth status error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Signup
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { email, username, password } = req.body;
        
        if (!email || !username || !password) {
            return res.status(400).json({ error: 'All fields are required' });
        }
        
        if (!/^[a-zA-Z0-9_]+$/.test(username)) {
            return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
        }
        
        if (username.length < 3 || username.length > 30) {
            return res.status(400).json({ error: 'Username must be 3-30 characters' });
        }
        
        // Reserved usernames that cannot be claimed
        const reservedUsernames = ['admin', 'administrator', 'api', 'dashboard', 'help', 'premium', 'settings', 'login', 'logout', 'signup', 'register', 'profile', 'user', 'users', 'support', 'contact', 'about', 'terms', 'privacy', 'tos', 'null', 'undefined', 'root', 'system'];
        if (reservedUsernames.includes(username.toLowerCase())) {
            return res.status(400).json({ error: 'This username is reserved and cannot be used' });
        }
        
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }
        
        const existing = await queryOne(
            'SELECT id FROM users WHERE email = ? OR username = ?',
            [email.toLowerCase(), username.toLowerCase()]
        );
        
        if (existing) {
            return res.status(400).json({ error: 'Email or username already taken' });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const user = await insertAndReturn('users', {
            email: email.toLowerCase(),
            username: username.toLowerCase(),
            password: hashedPassword,
            display_name: username
        }, 'id, email, username, display_name, is_premium');
        
        req.session.user = { id: user.id, is_premium: user.is_premium };
        
        res.json({ success: true, user });
    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        const user = await queryOne('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
        
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        
        req.session.user = { id: user.id, is_premium: user.is_premium };
        
        res.json({ 
            success: true, 
            user: {
                id: user.id,
                email: user.email,
                username: user.username,
                display_name: user.display_name
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Update profile
app.put('/api/profile', requireAuth, async (req, res) => {
    try {
        const { display_name, bio, background_type, gradient_start, gradient_end, show_userid } = req.body;
        const showUseridValue = USE_POSTGRES ? show_userid : (show_userid ? 1 : 0);
        
        await query(
            `UPDATE users SET 
                display_name = COALESCE(?, display_name),
                bio = COALESCE(?, bio),
                background_type = COALESCE(?, background_type),
                gradient_start = COALESCE(?, gradient_start),
                gradient_end = COALESCE(?, gradient_end),
                show_userid = COALESCE(?, show_userid)
            WHERE id = ?`,
            [display_name, bio, background_type, gradient_start, gradient_end, showUseridValue, req.session.user.id]
        );
        
        const user = await queryOne(
            `SELECT id, email, username, display_name, bio, avatar, background, 
                    background_type, gradient_start, gradient_end, show_userid, is_premium 
             FROM users WHERE id = ?`,
            [req.session.user.id]
        );
        
        res.json({ success: true, user });
    } catch (error) {
        console.error('Profile update error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Upload avatar
app.post('/api/profile/avatar', requireAuth, checkFileSize('avatar'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const oldUser = await queryOne('SELECT avatar FROM users WHERE id = ?', [req.session.user.id]);
        if (oldUser?.avatar && fs.existsSync(oldUser.avatar)) {
            fs.unlinkSync(oldUser.avatar);
        }
        
        const avatarPath = req.file.path.replace(/\\/g, '/');
        await query('UPDATE users SET avatar = ? WHERE id = ?', [avatarPath, req.session.user.id]);
        
        res.json({ success: true, avatar: avatarPath });
    } catch (error) {
        console.error('Avatar upload error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Upload background
app.post('/api/profile/background', requireAuth, checkFileSize('background'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const oldUser = await queryOne('SELECT background FROM users WHERE id = ?', [req.session.user.id]);
        if (oldUser?.background && fs.existsSync(oldUser.background)) {
            fs.unlinkSync(oldUser.background);
        }
        
        const backgroundPath = req.file.path.replace(/\\/g, '/');
        await query(
            'UPDATE users SET background = ?, background_type = ? WHERE id = ?',
            [backgroundPath, 'image', req.session.user.id]
        );
        
        res.json({ success: true, background: backgroundPath });
    } catch (error) {
        console.error('Background upload error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get user links
app.get('/api/links', requireAuth, async (req, res) => {
    try {
        const links = await query(
            'SELECT * FROM links WHERE user_id = ? ORDER BY display_order',
            [req.session.user.id]
        );
        res.json(links);
    } catch (error) {
        console.error('Get links error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Add link
app.post('/api/links', requireAuth, async (req, res) => {
    try {
        const { platform, url } = req.body;
        
        if (!platform || !url) {
            return res.status(400).json({ error: 'Platform and URL are required' });
        }
        
        const maxResult = await queryOne(
            'SELECT COALESCE(MAX(display_order), 0) as max FROM links WHERE user_id = ?',
            [req.session.user.id]
        );
        const newOrder = (maxResult?.max || 0) + 1;
        
        const link = await insertAndReturn('links', {
            user_id: req.session.user.id,
            platform,
            url,
            display_order: newOrder
        });
        
        res.json({ success: true, link });
    } catch (error) {
        console.error('Add link error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update link
app.put('/api/links/:id', requireAuth, async (req, res) => {
    try {
        const { platform, url, is_active } = req.body;
        
        const link = await queryOne(
            'SELECT * FROM links WHERE id = ? AND user_id = ?',
            [req.params.id, req.session.user.id]
        );
        
        if (!link) {
            return res.status(404).json({ error: 'Link not found' });
        }
        
        const isActiveValue = USE_POSTGRES ? is_active : (is_active === undefined ? undefined : (is_active ? 1 : 0));
        
        await query(
            `UPDATE links SET 
                platform = COALESCE(?, platform), 
                url = COALESCE(?, url), 
                is_active = COALESCE(?, is_active) 
            WHERE id = ?`,
            [platform, url, isActiveValue, req.params.id]
        );
        
        const updatedLink = await queryOne('SELECT * FROM links WHERE id = ?', [req.params.id]);
        res.json({ success: true, link: updatedLink });
    } catch (error) {
        console.error('Update link error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete link
app.delete('/api/links/:id', requireAuth, async (req, res) => {
    try {
        const link = await queryOne(
            'SELECT * FROM links WHERE id = ? AND user_id = ?',
            [req.params.id, req.session.user.id]
        );
        
        if (!link) {
            return res.status(404).json({ error: 'Link not found' });
        }
        
        await query('DELETE FROM links WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete link error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Reorder links
app.post('/api/links/reorder', requireAuth, async (req, res) => {
    try {
        const { linkIds } = req.body;
        
        for (let i = 0; i < linkIds.length; i++) {
            await query(
                'UPDATE links SET display_order = ? WHERE id = ? AND user_id = ?',
                [i, linkIds[i], req.session.user.id]
            );
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Reorder links error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get public profile
app.get('/api/profile/:username', async (req, res) => {
    try {
        const user = await queryOne(
            `SELECT id, username, display_name, bio, avatar, background, 
                    background_type, gradient_start, gradient_end, show_userid, is_premium 
             FROM users WHERE username = ?`,
            [req.params.username.toLowerCase()]
        );
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const isActiveValue = USE_POSTGRES ? true : 1;
        const links = await query(
            'SELECT platform, url FROM links WHERE user_id = ? AND is_active = ? ORDER BY display_order',
            [user.id, isActiveValue]
        );
        
        res.json({ user, links });
    } catch (error) {
        console.error('Get public profile error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============ PAGE ROUTES ============

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/premium', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'premium.html'));
});

app.get('/help', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'help.html'));
});

app.get('/terms', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

app.get('/:username', async (req, res) => {
    if (req.params.username.startsWith('api') || req.params.username.includes('.')) {
        return res.status(404).send('Not found');
    }
    
    try {
        const user = await queryOne(
            'SELECT id FROM users WHERE username = ?',
            [req.params.username.toLowerCase()]
        );
        
        if (!user) {
            return res.sendFile(path.join(__dirname, 'public', '404.html'));
        }
        
        res.sendFile(path.join(__dirname, 'public', 'profile.html'));
    } catch (error) {
        console.error('Profile page error:', error);
        res.sendFile(path.join(__dirname, 'public', '404.html'));
    }
});

// Start server
async function start() {
    try {
        await initDatabase();
        app.listen(PORT, () => {
            console.log(`🚀 hehe.cx server running at http://localhost:${PORT}`);
            if (!USE_POSTGRES) {
                console.log('📦 Running in LOCAL mode with SQLite');
                console.log('   Set DATABASE_URL env var to use PostgreSQL/Supabase');
            } else {
                console.log('🐘 Running in PRODUCTION mode with PostgreSQL');
            }
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

start();
