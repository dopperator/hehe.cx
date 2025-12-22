require('dotenv').config();

const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const mm = require('music-metadata');

// Upload limits
const UPLOAD_LIMITS = {
    VIDEO_MAX_DURATION: 59, // seconds
    VIDEO_MAX_SIZE: 50 * 1024 * 1024, // 50MB
    AUDIO_MAX_SIZE: 5 * 1024 * 1024, // 5MB
    IMAGE_MAX_SIZE_FREE: 10 * 1024 * 1024, // 10MB
    IMAGE_MAX_SIZE_PREMIUM: 50 * 1024 * 1024 // 50MB
};

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'hehecx-dev-secret-change-in-production';

// Email configuration
const EMAIL_USER = process.env.EMAIL_USER || 'lol@hehe.cx';
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_HOST = process.env.EMAIL_HOST || 'mail.privateemail.com';
const EMAIL_PORT = process.env.EMAIL_PORT || 465;

// Create email transporter
let emailTransporter = null;
if (EMAIL_PASS) {
    emailTransporter = nodemailer.createTransport({
        host: EMAIL_HOST,
        port: EMAIL_PORT,
        secure: true,
        auth: {
            user: EMAIL_USER,
            pass: EMAIL_PASS
        }
    });
    console.log('📧 Email transporter configured');
} else {
    console.log('⚠️ EMAIL_PASS not set - email verification disabled');
}

// Database mode: SQLite for local dev, PostgreSQL for production
const USE_POSTGRES = !!process.env.DATABASE_URL;

// Storage mode: Supabase for production, local for development
const USE_SUPABASE_STORAGE = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);

let db; // SQLite database
let pool; // PostgreSQL pool
let supabase; // Supabase client

// Initialize Supabase client if configured
if (USE_SUPABASE_STORAGE) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
    );
    console.log('📦 Supabase Storage configured');
}

// Ensure upload directories exist (for local development)
if (!USE_SUPABASE_STORAGE) {
    const uploadDirs = ['uploads/avatars', 'uploads/backgrounds', 'uploads/videos', 'uploads/audio'];
    uploadDirs.forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}

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
                    hide_branding BOOLEAN DEFAULT false,
                    is_admin BOOLEAN DEFAULT false,
                    signup_ip VARCHAR(45),
                    is_deactivated BOOLEAN DEFAULT false,
                    deactivation_reason TEXT,
                    background_video VARCHAR(500),
                    video_audio_default BOOLEAN DEFAULT false,
                    repped_badge_id INTEGER REFERENCES badges(id) ON DELETE SET NULL,
                    music_type VARCHAR(20) DEFAULT 'none',
                    music_url VARCHAR(500),
                    music_start INTEGER DEFAULT 0,
                    music_end INTEGER DEFAULT 0,
                    prefer_music_over_video BOOLEAN DEFAULT false,
                    click_to_enter BOOLEAN DEFAULT false,
                    embed_position VARCHAR(30) DEFAULT 'bottom-right',
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

                CREATE TABLE IF NOT EXISTS pending_verifications (
                    id SERIAL PRIMARY KEY,
                    email VARCHAR(255) NOT NULL,
                    username VARCHAR(30) NOT NULL,
                    password VARCHAR(255) NOT NULL,
                    code VARCHAR(6) NOT NULL,
                    resend_count INTEGER DEFAULT 0,
                    expires_at TIMESTAMP NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );

                CREATE INDEX IF NOT EXISTS idx_pending_email ON pending_verifications(email);

                CREATE TABLE IF NOT EXISTS badges (
                    id SERIAL PRIMARY KEY,
                    name VARCHAR(100) NOT NULL,
                    image_url VARCHAR(500) NOT NULL,
                    description TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS user_badges (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    badge_id INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
                    granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(user_id, badge_id)
                );

                CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges(user_id);

                CREATE TABLE IF NOT EXISTS admin_verifications (
                    id SERIAL PRIMARY KEY,
                    admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    code VARCHAR(6) NOT NULL,
                    expires_at TIMESTAMP NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS settings (
                    key VARCHAR(50) PRIMARY KEY,
                    value TEXT NOT NULL
                );

                INSERT INTO settings (key, value) VALUES ('maintenance_mode', 'false') ON CONFLICT (key) DO NOTHING;
                INSERT INTO settings (key, value) VALUES ('view_only_maintenance_mode', 'false') ON CONFLICT (key) DO NOTHING;
            `);

            // Run migrations for new columns
            try {
                await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false`);
                await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_ip VARCHAR(45)`);
                await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_deactivated BOOLEAN DEFAULT false`);
                await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivation_reason TEXT`);
                await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS background_video VARCHAR(500)`);
                await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS video_audio_default BOOLEAN DEFAULT false`);
                await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS repped_badge_id INTEGER REFERENCES badges(id) ON DELETE SET NULL`);
                await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS music_type VARCHAR(20) DEFAULT 'none'`);
                await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS music_url VARCHAR(500)`);
                await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS music_start INTEGER DEFAULT 0`);
                await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS music_end INTEGER DEFAULT 0`);
                await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS prefer_music_over_video BOOLEAN DEFAULT false`);
                await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS click_to_enter BOOLEAN DEFAULT false`);
                await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS embed_position VARCHAR(30) DEFAULT 'bottom-right'`);
            } catch (e) {
                // Columns may already exist
            }

            // Make user 1 (the first account) an admin
            await client.query(`UPDATE users SET is_admin = true WHERE id = 1`);

            console.log('✅ PostgreSQL database initialized');
        } finally {
            client.release();
        }
    } else {
        // SQLite setup (local development only)
        try {
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
                    hide_branding INTEGER DEFAULT 0,
                    is_admin INTEGER DEFAULT 0,
                    signup_ip TEXT,
                    is_deactivated INTEGER DEFAULT 0,
                    deactivation_reason TEXT,
                    background_video TEXT,
                    video_audio_default INTEGER DEFAULT 0,
                    repped_badge_id INTEGER,
                    music_type TEXT DEFAULT 'none',
                    music_url TEXT,
                    music_start INTEGER DEFAULT 0,
                    music_end INTEGER DEFAULT 0,
                    prefer_music_over_video INTEGER DEFAULT 0,
                    click_to_enter INTEGER DEFAULT 0,
                    embed_position TEXT DEFAULT 'bottom-right',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (repped_badge_id) REFERENCES badges(id) ON DELETE SET NULL
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

                CREATE TABLE IF NOT EXISTS pending_verifications (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT NOT NULL,
                    username TEXT NOT NULL,
                    password TEXT NOT NULL,
                    code TEXT NOT NULL,
                    resend_count INTEGER DEFAULT 0,
                    expires_at DATETIME NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS badges (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    image_url TEXT NOT NULL,
                    description TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS user_badges (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    badge_id INTEGER NOT NULL,
                    granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (badge_id) REFERENCES badges(id) ON DELETE CASCADE,
                    UNIQUE(user_id, badge_id)
                );

                CREATE TABLE IF NOT EXISTS admin_verifications (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    admin_id INTEGER NOT NULL,
                    code TEXT NOT NULL,
                    expires_at DATETIME NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                INSERT OR IGNORE INTO settings (key, value) VALUES ('maintenance_mode', 'false');
                INSERT OR IGNORE INTO settings (key, value) VALUES ('view_only_maintenance_mode', 'false');
            `);
            
            // Migrations for new columns
            const migrations = [
                'ALTER TABLE users ADD COLUMN hide_branding INTEGER DEFAULT 0',
                'ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0',
                'ALTER TABLE users ADD COLUMN signup_ip TEXT',
                'ALTER TABLE users ADD COLUMN is_deactivated INTEGER DEFAULT 0',
                'ALTER TABLE users ADD COLUMN deactivation_reason TEXT',
                'ALTER TABLE users ADD COLUMN background_video TEXT',
                'ALTER TABLE users ADD COLUMN video_audio_default INTEGER DEFAULT 0',
                'ALTER TABLE users ADD COLUMN repped_badge_id INTEGER',
                "ALTER TABLE users ADD COLUMN music_type TEXT DEFAULT 'none'",
                'ALTER TABLE users ADD COLUMN music_url TEXT',
                'ALTER TABLE users ADD COLUMN music_start INTEGER DEFAULT 0',
                'ALTER TABLE users ADD COLUMN music_end INTEGER DEFAULT 0',
                'ALTER TABLE users ADD COLUMN prefer_music_over_video INTEGER DEFAULT 0',
                'ALTER TABLE users ADD COLUMN click_to_enter INTEGER DEFAULT 0',
                "ALTER TABLE users ADD COLUMN embed_position TEXT DEFAULT 'bottom-right'"
            ];
            
            for (const migration of migrations) {
                try {
                    db.exec(migration);
                } catch (e) {
                    // Column already exists, ignore error
                }
            }

            // Make user 1 (the first account) an admin
            try {
                db.prepare('UPDATE users SET is_admin = 1 WHERE id = 1').run();
            } catch (e) {
                // Ignore if user doesn't exist yet
            }
            
            console.log('✅ SQLite database initialized (local mode)');
        } catch (e) {
            console.error('❌ SQLite not available. Set DATABASE_URL for PostgreSQL.');
            console.error('   For production, you MUST use PostgreSQL (Supabase).');
            process.exit(1);
        }
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

// ============ MAINTENANCE MODE ============

// In-memory maintenance mode state (loaded from DB on startup)
let maintenanceMode = false;
let viewOnlyMaintenanceMode = false;

// Maintenance mode middleware - defined before use
const checkMaintenance = (req, res, next) => {
    // Always allow these paths regardless of maintenance mode
    if (req.path === '/maintenance' ||
        req.path === '/maintenance.html' ||
        req.path === '/api/maintenance/status' ||
        req.path.startsWith('/admin-panel-for-the-lolz') ||
        req.path.startsWith('/api/admin') ||
        req.path.startsWith('/src/') ||
        req.path.startsWith('/uploads/') ||
        req.path.startsWith('/media/')) {
        return next();
    }

    // If both maintenance modes are off, allow everything
    if (!maintenanceMode && !viewOnlyMaintenanceMode) {
        return next();
    }

    // Admin session (from admin panel) bypasses maintenance mode
    if (req.session && req.session.admin) {
        return next();
    }

    // Regular user session with admin privileges also bypasses maintenance mode
    if (req.session && req.session.user && req.session.user.is_admin) {
        return next();
    }

    // VIEW ONLY MAINTENANCE MODE - Allow viewing profiles only
    if (viewOnlyMaintenanceMode && !maintenanceMode) {
        // Allow public profile API
        if (req.path.startsWith('/api/profile/') && req.method === 'GET') {
            return next();
        }
        // Allow user badges API (for profile pages)
        if (req.path.match(/^\/api\/users\/[^\/]+\/badges$/) && req.method === 'GET') {
            return next();
        }
        // Allow profile pages (username routes - but not dashboard, help, etc.)
        const reservedPaths = ['/', '/dashboard', '/premium', '/help', '/terms', '/privacy', '/login', '/signup', '/register'];
        if (!reservedPaths.includes(req.path) && 
            !req.path.startsWith('/api/') && 
            !req.path.includes('.') &&
            req.path !== '/') {
            // This is likely a username route - allow it
            return next();
        }
        
        // Block API routes during view-only maintenance (except allowed ones above)
        if (req.path.startsWith('/api/')) {
            return res.status(503).json({ error: 'Site is in view-only maintenance mode', maintenance: true, viewOnly: true });
        }
        
        // Redirect other pages to maintenance
        return res.redirect('/maintenance');
    }

    // FULL MAINTENANCE MODE - Block everything
    // Block API routes during maintenance
    if (req.path.startsWith('/api/')) {
        return res.status(503).json({ error: 'Site is under maintenance', maintenance: true });
    }

    // For all other requests (HTML pages), redirect to maintenance
    return res.redirect('/maintenance');
};

// ============ MIDDLEWARE ============

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static assets that should always be accessible
app.use('/uploads', express.static('uploads'));
app.use('/src', express.static('src'));

// ============ MEDIA PROXY (Hide Supabase URLs) ============

// Proxy route for serving media files without exposing Supabase URLs
app.get('/media/:bucket/:userId/:filename', async (req, res) => {
    try {
        const { bucket, userId, filename } = req.params;
        const allowedBuckets = ['avatars', 'backgrounds', 'videos', 'audio'];
        
        if (!allowedBuckets.includes(bucket)) {
            return res.status(404).send('Not found');
        }
        
        if (USE_SUPABASE_STORAGE) {
            // Fetch from Supabase and pipe to response
            const filePath = `${userId}/${filename}`;
            const { data, error } = await supabase.storage
                .from(bucket)
                .download(filePath);
            
            if (error || !data) {
                return res.status(404).send('Not found');
            }
            
            // Set appropriate content type based on extension
            const ext = filename.split('.').pop().toLowerCase();
            const contentTypes = {
                'png': 'image/png',
                'jpg': 'image/jpeg',
                'jpeg': 'image/jpeg',
                'gif': 'image/gif',
                'webp': 'image/webp',
                'mp4': 'video/mp4',
                'webm': 'video/webm',
                'mov': 'video/quicktime',
                'mp3': 'audio/mpeg',
                'wav': 'audio/wav',
                'ogg': 'audio/ogg'
            };
            
            res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
            res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
            
            // Convert blob to buffer and send
            const buffer = Buffer.from(await data.arrayBuffer());
            res.send(buffer);
        } else {
            // Local storage - redirect to uploads folder
            res.redirect(`/uploads/${bucket}/${filename}`);
        }
    } catch (error) {
        console.error('Media proxy error:', error);
        res.status(500).send('Server error');
    }
});

app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,  // Prevents JavaScript access to cookie (XSS protection)
        maxAge: 30 * 24 * 60 * 60 * 1000,
        sameSite: 'strict'  // Stricter CSRF protection
    },
    proxy: process.env.NODE_ENV === 'production',
    name: 'sid'  // Custom cookie name (don't reveal you're using express-session)
}));

if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

// Apply maintenance check after session middleware
app.use(checkMaintenance);

// Serve static files AFTER maintenance check (so HTML pages get blocked during maintenance)
app.use(express.static('public'));

// File upload configuration
// Use memory storage for Supabase, disk storage for local
const storage = USE_SUPABASE_STORAGE 
    ? multer.memoryStorage()
    : multer.diskStorage({
        destination: (req, file, cb) => {
            let folder = 'uploads/backgrounds';
            if (file.fieldname === 'avatar') folder = 'uploads/avatars';
            else if (file.fieldname === 'video') folder = 'uploads/videos';
            else if (file.fieldname === 'audio') folder = 'uploads/audio';
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
        background: isPremium ? ['image/png', 'image/jpeg', 'image/gif'] : ['image/png', 'image/jpeg'],
        video: isPremium ? ['video/mp4', 'video/webm', 'video/quicktime'] : [],
        audio: isPremium ? ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp3'] : [],
        badge: ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
    };
    
    const fieldAllowed = allowedTypes[file.fieldname] || [];
    
    if (fieldAllowed.includes(file.mimetype)) {
        cb(null, true);
    } else {
        if (file.fieldname === 'video' && !isPremium) {
            cb(new Error('Video backgrounds are a premium feature'), false);
        } else if (file.fieldname === 'audio' && !isPremium) {
            cb(new Error('Custom audio uploads are a premium feature'), false);
        } else {
            cb(new Error(`Invalid file type. Allowed: ${fieldAllowed.join(', ')}`), false);
        }
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
            if (!USE_SUPABASE_STORAGE && req.file.path) {
                fs.unlinkSync(req.file.path);
            }
            return res.status(400).json({ error: `File too large. Max size: ${isPremium ? '50MB' : '10MB'}` });
        }
        
        next();
    });
};

// Supabase Storage helper functions
async function uploadToSupabase(bucket, filePath, buffer, contentType) {
    const { data, error } = await supabase.storage
        .from(bucket)
        .upload(filePath, buffer, {
            contentType,
            upsert: true
        });
    
    if (error) throw error;
    
    // Return proxy URL instead of direct Supabase URL
    // This hides the Supabase URL when users right-click images
    return `/media/${bucket}/${filePath}`;
}

async function deleteFromSupabase(bucket, fileUrl) {
    if (!fileUrl) return;
    
    try {
        let filePath;
        
        // Handle new proxy URLs (/media/bucket/userId/filename)
        if (fileUrl.startsWith('/media/')) {
            const parts = fileUrl.split('/');
            // /media/bucket/userId/filename -> userId/filename
            if (parts.length >= 5) {
                filePath = `${parts[3]}/${parts[4]}`;
            }
        }
        // Handle old Supabase URLs for backwards compatibility
        else if (fileUrl.includes('supabase')) {
            const urlParts = fileUrl.split(`/storage/v1/object/public/${bucket}/`);
            if (urlParts.length >= 2) {
                filePath = urlParts[1];
            }
        }
        
        if (filePath) {
            await supabase.storage.from(bucket).remove([filePath]);
        }
    } catch (error) {
        console.error('Error deleting from Supabase:', error);
    }
}

const requireAuth = (req, res, next) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    next();
};

// ============ EMAIL VERIFICATION HELPERS ============

// Generate a 6-character alphanumeric code (uppercase)
function generateVerificationCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed confusing chars like 0, O, 1, I
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Send verification email
async function sendVerificationEmail(email, code) {
    if (!emailTransporter) {
        console.log('📧 [DEV] Verification code for', email, ':', code);
        return true; // Allow signup without email in development
    }

    const mailOptions = {
        from: `"hehe.cx" <${EMAIL_USER}>`,
        to: email,
        subject: 'Verify your hehe.cx account',
        html: `
            <div style="background-color: #0a0a0f; padding: 40px 20px; min-height: 100%;">
                <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 500px; margin: 0 auto;">
                    <div style="text-align: center; margin-bottom: 30px;">
                        <h1 style="color: #8b5cf6; margin: 0; font-size: 28px;">hehe.cx</h1>
                    </div>
                    <div style="background-color: #18181b; border-radius: 16px; padding: 32px; border: 1px solid #2a2a2f;">
                        <h2 style="color: #f5f5f7; margin: 0 0 16px 0; font-size: 22px;">Verify your email</h2>
                        <p style="color: #a1a1aa; margin: 0 0 24px 0; font-size: 15px; line-height: 1.6;">
                            Enter this code to complete your registration. It expires in 5 minutes.
                        </p>
                        <div style="background-color: #1a1a2e; border: 2px solid #8b5cf6; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px;">
                            <span style="font-family: 'Courier New', monospace; font-size: 32px; font-weight: bold; color: #ffffff; letter-spacing: 8px;">${code}</span>
                        </div>
                        <p style="color: #71717a; margin: 0; font-size: 13px;">
                            If you didn't request this code, you can safely ignore this email.
                        </p>
                    </div>
                    <p style="color: #71717a; font-size: 12px; text-align: center; margin-top: 24px;">
                        © 2025 hehe.cx - Your Digital Identity
                    </p>
                </div>
            </div>
        `
    };

    try {
        await emailTransporter.sendMail(mailOptions);
        return true;
    } catch (error) {
        console.error('Email send error:', error);
        return false;
    }
}

// Clean up expired verifications
async function cleanupExpiredVerifications() {
    try {
        if (USE_POSTGRES) {
            await pool.query('DELETE FROM pending_verifications WHERE expires_at < NOW()');
        } else {
            db.prepare('DELETE FROM pending_verifications WHERE expires_at < datetime("now")').run();
        }
    } catch (error) {
        console.error('Cleanup error:', error);
    }
}

// Run cleanup every 10 minutes
setInterval(cleanupExpiredVerifications, 10 * 60 * 1000);

// Get client IP address
function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
           req.headers['x-real-ip'] || 
           req.socket?.remoteAddress || 
           req.ip || 
           'unknown';
}

// Send admin verification email
async function sendAdminVerificationEmail(email, code) {
    if (!emailTransporter) {
        console.log('📧 [DEV] Admin verification code for', email, ':', code);
        return true;
    }

    const mailOptions = {
        from: `"hehe.cx Admin" <${EMAIL_USER}>`,
        to: email,
        subject: 'Admin Panel Login Verification',
        html: `
            <div style="background-color: #0a0a0f; padding: 40px 20px; min-height: 100%;">
                <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 500px; margin: 0 auto;">
                    <div style="text-align: center; margin-bottom: 30px;">
                        <h1 style="color: #ef4444; margin: 0; font-size: 28px;">🔐 hehe.cx Admin</h1>
                    </div>
                    <div style="background-color: #18181b; border-radius: 16px; padding: 32px; border: 2px solid #ef4444;">
                        <h2 style="color: #f5f5f7; margin: 0 0 16px 0; font-size: 22px;">Admin Login Verification</h2>
                        <p style="color: #a1a1aa; margin: 0 0 24px 0; font-size: 15px; line-height: 1.6;">
                            Someone is trying to access the admin panel. If this is you, enter this code. It expires in 5 minutes.
                        </p>
                        <div style="background-color: #1a1a2e; border: 2px solid #ef4444; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px;">
                            <span style="font-family: 'Courier New', monospace; font-size: 32px; font-weight: bold; color: #ffffff; letter-spacing: 8px;">${code}</span>
                        </div>
                        <p style="color: #ef4444; margin: 0; font-size: 13px; font-weight: bold;">
                            ⚠️ If you didn't request this, someone may be trying to access your admin account!
                        </p>
                    </div>
                </div>
            </div>
        `
    };

    try {
        await emailTransporter.sendMail(mailOptions);
        return true;
    } catch (error) {
        console.error('Admin email send error:', error);
        return false;
    }
}

// ============ URL VALIDATION ============

// Platform URL patterns
const platformPatterns = {
    bluesky: /^https?:\/\/(www\.)?(bsky\.app|bsky\.social)\//i,
    cashapp: /^https?:\/\/(www\.)?cash\.app\//i,
    deviantart: /^https?:\/\/(www\.)?deviantart\.com\//i,
    discord: /^https?:\/\/(www\.)?(discord\.(gg|com)|discordapp\.com)\//i,
    github: /^https?:\/\/(www\.)?github\.com\//i,
    instagram: /^https?:\/\/(www\.)?instagram\.com\//i,
    kick: /^https?:\/\/(www\.)?kick\.com\//i,
    linkedin: /^https?:\/\/(www\.)?linkedin\.com\//i,
    pinterest: /^https?:\/\/(www\.)?pinterest\.(com|ca|co\.uk)\//i,
    reddit: /^https?:\/\/(www\.)?reddit\.com\//i,
    roblox: /^https?:\/\/(www\.)?roblox\.com\//i,
    snapchat: /^https?:\/\/(www\.)?(snapchat\.com|t\.snapchat\.com)\//i,
    soundcloud: /^https?:\/\/(www\.)?(soundcloud\.com|on\.soundcloud\.com)\//i,
    spotify: /^https?:\/\/(www\.|open\.)?spotify\.com\//i,
    steam: /^https?:\/\/(www\.|store\.)?steam(community|powered)?\.com\//i,
    tiktok: /^https?:\/\/(www\.)?(tiktok\.com|vm\.tiktok\.com)\//i,
    venmo: /^https?:\/\/(www\.)?venmo\.com\//i,
    x: /^https?:\/\/(www\.)?(twitter\.com|x\.com)\//i,
    youtube: /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i
};

// Music platform patterns
const musicPatterns = {
    youtube: /^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|embed\/|shorts\/)|youtu\.be\/)/i,
    spotify: /^https?:\/\/(www\.|open\.)?spotify\.com\/(track|album|playlist)\//i,
    soundcloud: /^https?:\/\/(www\.)?(soundcloud\.com|on\.soundcloud\.com)\//i
};

function validatePlatformUrl(platform, url) {
    const pattern = platformPatterns[platform.toLowerCase()];
    if (!pattern) return true; // Unknown platform, allow any URL
    return pattern.test(url);
}

function validateMusicUrl(type, url) {
    const pattern = musicPatterns[type];
    if (!pattern) return true;
    return pattern.test(url);
}

// ============ API ROUTES ============

// Check auth status
app.get('/api/auth/status', async (req, res) => {
    try {
        if (req.session.user) {
            const user = await queryOne(
                `SELECT id, email, username, display_name, bio, avatar, background, 
                        background_type, gradient_start, gradient_end, show_userid, is_premium, hide_branding,
                        background_video, video_audio_default, repped_badge_id,
                        music_type, music_url, music_start, music_end, prefer_music_over_video,
                        click_to_enter, embed_position 
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

// Signup - Step 1: Send verification email
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { email, username, password } = req.body;
        
        if (!email || !username || !password) {
            return res.status(400).json({ error: 'All fields are required' });
        }
        
        if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
            return res.status(400).json({ error: 'Username can only contain letters, numbers, underscores, and dashes' });
        }
        
        if (username.length < 1 || username.length > 30) {
            return res.status(400).json({ error: 'Username must be 1-30 characters' });
        }
        
        // Reserved usernames that cannot be claimed
        const reservedUsernames = ['admin', 'administrator', 'api', 'dashboard', 'dash-board', 'dash_board', 'help', 'premium', 'settings', 'login', 'log-in', 'log_in', 'logout', 'log-out', 'log_out', 'signup', 'sign-up', 'sign_up', 'signin', 'sign-in', 'sign_in', 'register', 'profile', 'user', 'users', 'support', 'contact', 'contactus', 'contact-us', 'contact_us', 'about', 'aboutus', 'about-us', 'about_us', 'terms', 'privacy', 'tos', 'null', 'termsofservice', 'terms-of-service', 'terms_of_service', 'terms-of_service', 'terms_of-service', 'privacypolicy', 'privacy-policy', 'privacy_policy', 'undefined', 'hehecx', 'hehe', 'hehe.cx', 'hehe-cx', 'hehe_cx', 'root', 'system', 'maintenance'];
        if (reservedUsernames.includes(username.toLowerCase())) {
            return res.status(400).json({ error: 'This username cannot be used' });
        }
        
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }
        
        // Check if email or username already exists in users table
        const existing = await queryOne(
            'SELECT id FROM users WHERE email = ? OR username = ?',
            [email.toLowerCase(), username.toLowerCase()]
        );
        
        if (existing) {
            return res.status(400).json({ error: 'Email or username already taken' });
        }

        // Check if a verification code was sent recently (60 second cooldown)
        const existingPending = await queryOne(
            'SELECT * FROM pending_verifications WHERE email = ?',
            [email.toLowerCase()]
        );
        
        if (existingPending) {
            const createdAt = new Date(existingPending.created_at);
            const cooldownEnd = new Date(createdAt.getTime() + 60 * 1000); // 60 seconds
            
            if (new Date() < cooldownEnd) {
                const secondsLeft = Math.ceil((cooldownEnd - new Date()) / 1000);
                return res.status(429).json({ 
                    error: `Please wait ${secondsLeft} seconds before requesting another code`,
                    cooldown: secondsLeft
                });
            }
            
            // Cooldown passed, delete old verification
            await query('DELETE FROM pending_verifications WHERE email = ?', [email.toLowerCase()]);
        }

        // Generate verification code and expiration (5 minutes)
        const code = generateVerificationCode();
        const hashedPassword = await bcrypt.hash(password, 10);

        // Calculate expiration time
        let expiresAt;
        if (USE_POSTGRES) {
            expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        } else {
            expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().replace('T', ' ').replace('Z', '');
        }

        // Store pending verification
        await insertAndReturn('pending_verifications', {
            email: email.toLowerCase(),
            username: username.toLowerCase(),
            password: hashedPassword,
            code: code,
            resend_count: 0,
            expires_at: expiresAt
        });
        
        // Send verification email
        const emailSent = await sendVerificationEmail(email.toLowerCase(), code);
        
        if (!emailSent && emailTransporter) {
            return res.status(500).json({ error: 'Failed to send verification email. Please try again.' });
        }
        
        res.json({ 
            success: true, 
            message: 'Verification code sent to your email',
            email: email.toLowerCase()
        });
    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Signup - Step 2: Verify code and create account
app.post('/api/auth/verify', async (req, res) => {
    try {
        const { email, code } = req.body;
        
        if (!email || !code) {
            return res.status(400).json({ error: 'Email and code are required' });
        }
        
        // Find pending verification
        const pending = await queryOne(
            'SELECT * FROM pending_verifications WHERE email = ?',
            [email.toLowerCase()]
        );
        
        if (!pending) {
            return res.status(400).json({ error: 'No pending verification found. Please sign up again.' });
        }
        
        // Check if code has expired
        const expiresAt = new Date(pending.expires_at);
        if (expiresAt < new Date()) {
            await query('DELETE FROM pending_verifications WHERE email = ?', [email.toLowerCase()]);
            return res.status(400).json({ error: 'Verification code has expired. Please sign up again.' });
        }
        
        // Check if code matches (case-insensitive)
        if (pending.code.toUpperCase() !== code.toUpperCase()) {
            return res.status(400).json({ error: 'Invalid verification code' });
        }
        
        // Check again if username/email was taken while verifying
        const existing = await queryOne(
            'SELECT id FROM users WHERE email = ? OR username = ?',
            [pending.email, pending.username]
        );
        
        if (existing) {
            await query('DELETE FROM pending_verifications WHERE email = ?', [email.toLowerCase()]);
            return res.status(400).json({ error: 'Email or username was taken while verifying. Please sign up again.' });
        }
        
        // Create the user account with signup IP
        const signupIP = getClientIP(req);
        const user = await insertAndReturn('users', {
            email: pending.email,
            username: pending.username,
            password: pending.password,
            display_name: pending.username,
            signup_ip: signupIP
        }, 'id, email, username, display_name, is_premium');
        
        // Delete pending verification
        await query('DELETE FROM pending_verifications WHERE email = ?', [email.toLowerCase()]);

        // Regenerate session to prevent session fixation attacks
        req.session.regenerate((err) => {
            if (err) {
                console.error('Session regeneration error:', err);
                return res.status(500).json({ error: 'Server error' });
            }
            
            // Log the user in with new session
            req.session.user = { id: user.id, is_premium: user.is_premium, is_admin: user.is_admin };
            
            req.session.save((err) => {
                if (err) {
                    console.error('Session save error:', err);
                    return res.status(500).json({ error: 'Server error' });
                }
                res.json({ success: true, user });
            });
        });
    } catch (error) {
        console.error('Verify error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Resend verification code (max 1 resend)
app.post('/api/auth/resend', async (req, res) => {
    try {
        const { email } = req.body;
        
        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }
        
        // Find pending verification
        const pending = await queryOne(
            'SELECT * FROM pending_verifications WHERE email = ?',
            [email.toLowerCase()]
        );
        
        if (!pending) {
            return res.status(400).json({ error: 'No pending verification found. Please sign up again.' });
        }
        
        // Check resend count
        if (pending.resend_count >= 1) {
            return res.status(400).json({ error: 'Maximum resends reached. Please sign up again if needed.' });
        }
        
        // Generate new code and reset expiration
        const newCode = generateVerificationCode();
        let newExpiresAt;
        if (USE_POSTGRES) {
            newExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        } else {
            newExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().replace('T', ' ').replace('Z', '');
        }
        
        // Update pending verification
        await query(
            'UPDATE pending_verifications SET code = ?, expires_at = ?, resend_count = resend_count + 1 WHERE email = ?',
            [newCode, newExpiresAt, email.toLowerCase()]
        );
        
        // Send new verification email
        const emailSent = await sendVerificationEmail(email.toLowerCase(), newCode);
        
        if (!emailSent && emailTransporter) {
            return res.status(500).json({ error: 'Failed to send verification email. Please try again.' });
        }
        
        res.json({ 
            success: true, 
            message: 'New verification code sent',
            canResend: false // Already used their one resend
        });
    } catch (error) {
        console.error('Resend error:', error);
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
        
        // Check if account is deactivated
        if (user.is_deactivated) {
            return res.status(403).json({
                error: 'Account deactivated',
                deactivated: true,
                reason: user.deactivation_reason || 'No reason provided'
            });
        }

        // TODO: Future 2FA implementation
        // When adding email 2FA for login, add rate limiting here similar to admin login:
        // 1. Check for existing verification in login_verifications table
        // 2. If exists and created_at < 60 seconds ago, return 429 with cooldown
        // 3. Otherwise, generate code, store in DB, send email, return requires_2fa: true
        // 4. Create separate /api/auth/verify-login endpoint to verify the code

        // Regenerate session to prevent session fixation attacks
        const userData = {
            id: user.id,
            email: user.email,
            username: user.username,
            display_name: user.display_name
        };
        
        req.session.regenerate((err) => {
            if (err) {
                console.error('Session regeneration error:', err);
                return res.status(500).json({ error: 'Server error' });
            }
            
            req.session.user = { id: user.id, is_premium: user.is_premium, is_admin: user.is_admin };
            
            req.session.save((err) => {
                if (err) {
                    console.error('Session save error:', err);
                    return res.status(500).json({ error: 'Server error' });
                }
                res.json({ success: true, user: userData });
            });
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
        const { display_name, bio, background_type, gradient_start, gradient_end, show_userid, video_audio_default } = req.body;
        const showUseridValue = USE_POSTGRES ? show_userid : (show_userid ? 1 : 0);
        const videoAudioValue = USE_POSTGRES ? video_audio_default : (video_audio_default ? 1 : 0);
        
        await query(
            `UPDATE users SET 
                display_name = COALESCE(?, display_name),
                bio = COALESCE(?, bio),
                background_type = COALESCE(?, background_type),
                gradient_start = COALESCE(?, gradient_start),
                gradient_end = COALESCE(?, gradient_end),
                show_userid = COALESCE(?, show_userid),
                video_audio_default = COALESCE(?, video_audio_default)
            WHERE id = ?`,
            [display_name, bio, background_type, gradient_start, gradient_end, showUseridValue, videoAudioValue, req.session.user.id]
        );
        
        const user = await queryOne(
            `SELECT id, email, username, display_name, bio, avatar, background, 
                    background_type, gradient_start, gradient_end, show_userid, is_premium, hide_branding,
                    background_video, video_audio_default, repped_badge_id,
                    music_type, music_url, music_start, music_end, prefer_music_over_video 
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
        
        let avatarUrl;
        
        if (USE_SUPABASE_STORAGE) {
            // Delete old file from Supabase
            if (oldUser?.avatar) {
                await deleteFromSupabase('avatars', oldUser.avatar);
            }
            
            // Upload to Supabase Storage
            const fileName = `${req.session.user.id}/${uuidv4()}${path.extname(req.file.originalname)}`;
            avatarUrl = await uploadToSupabase('avatars', fileName, req.file.buffer, req.file.mimetype);
        } else {
            // Local storage
            if (oldUser?.avatar && fs.existsSync(oldUser.avatar)) {
                fs.unlinkSync(oldUser.avatar);
            }
            avatarUrl = req.file.path.replace(/\\/g, '/');
        }
        
        await query('UPDATE users SET avatar = ? WHERE id = ?', [avatarUrl, req.session.user.id]);
        
        res.json({ success: true, avatar: avatarUrl });
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
        
        let backgroundUrl;
        
        if (USE_SUPABASE_STORAGE) {
            // Delete old file from Supabase
            if (oldUser?.background) {
                await deleteFromSupabase('backgrounds', oldUser.background);
            }
            
            // Upload to Supabase Storage
            const fileName = `${req.session.user.id}/${uuidv4()}${path.extname(req.file.originalname)}`;
            backgroundUrl = await uploadToSupabase('backgrounds', fileName, req.file.buffer, req.file.mimetype);
        } else {
            // Local storage
            if (oldUser?.background && fs.existsSync(oldUser.background)) {
                fs.unlinkSync(oldUser.background);
            }
            backgroundUrl = req.file.path.replace(/\\/g, '/');
        }
        
        await query(
            'UPDATE users SET background = ?, background_type = ? WHERE id = ?',
            [backgroundUrl, 'image', req.session.user.id]
        );
        
        res.json({ success: true, background: backgroundUrl });
    } catch (error) {
        console.error('Background upload error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Upload video background (Premium only)
app.post('/api/profile/video', requireAuth, checkFileSize('video'), async (req, res) => {
    try {
        // Check if user is premium
        const user = await queryOne('SELECT is_premium, background_video FROM users WHERE id = ?', [req.session.user.id]);
        
        if (!user?.is_premium) {
            return res.status(403).json({ error: 'Video backgrounds are a premium feature' });
        }
        
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        // Check file size (50MB max for videos)
        if (req.file.size > UPLOAD_LIMITS.VIDEO_MAX_SIZE) {
            if (!USE_SUPABASE_STORAGE && req.file.path) {
                fs.unlinkSync(req.file.path);
            }
            return res.status(400).json({ error: 'Video must be under 50MB' });
        }
        
        // Check video duration using music-metadata
        try {
            let metadata;
            if (USE_SUPABASE_STORAGE) {
                // Parse from buffer
                metadata = await mm.parseBuffer(req.file.buffer, req.file.mimetype);
            } else {
                // Parse from file path
                metadata = await mm.parseFile(req.file.path);
            }
            
            const duration = metadata.format.duration || 0;
            if (duration > UPLOAD_LIMITS.VIDEO_MAX_DURATION) {
                if (!USE_SUPABASE_STORAGE && req.file.path) {
                    fs.unlinkSync(req.file.path);
                }
                return res.status(400).json({ error: `Video must be ${UPLOAD_LIMITS.VIDEO_MAX_DURATION} seconds or less (yours is ${Math.ceil(duration)} seconds)` });
            }
        } catch (metadataError) {
            console.error('Video metadata parse error:', metadataError);
            // If we can't parse metadata, allow the upload but log it
        }
        
        let videoUrl;
        
        if (USE_SUPABASE_STORAGE) {
            // Delete old video from Supabase
            if (user?.background_video) {
                await deleteFromSupabase('videos', user.background_video);
            }
            
            // Upload to Supabase Storage
            const fileName = `${req.session.user.id}/${uuidv4()}${path.extname(req.file.originalname)}`;
            videoUrl = await uploadToSupabase('videos', fileName, req.file.buffer, req.file.mimetype);
        } else {
            // Local storage
            if (user?.background_video && fs.existsSync(user.background_video)) {
                fs.unlinkSync(user.background_video);
            }
            videoUrl = req.file.path.replace(/\\/g, '/');
        }
        
        await query(
            'UPDATE users SET background_video = ?, background_type = ? WHERE id = ?',
            [videoUrl, 'video', req.session.user.id]
        );
        
        res.json({ success: true, background_video: videoUrl });
    } catch (error) {
        console.error('Video upload error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete video background
app.delete('/api/profile/video', requireAuth, async (req, res) => {
    try {
        const user = await queryOne('SELECT background_video FROM users WHERE id = ?', [req.session.user.id]);
        
        if (user?.background_video) {
            if (USE_SUPABASE_STORAGE) {
                await deleteFromSupabase('videos', user.background_video);
            } else if (fs.existsSync(user.background_video)) {
                fs.unlinkSync(user.background_video);
            }
        }
        
        await query(
            'UPDATE users SET background_video = NULL, background_type = ? WHERE id = ?',
            ['gradient', req.session.user.id]
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Delete video error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update music settings
app.put('/api/profile/music', requireAuth, async (req, res) => {
    try {
        const { music_type, music_url, music_start, music_end, prefer_music_over_video } = req.body;
        
        // Validate music_type
        const validTypes = ['none', 'youtube', 'spotify', 'soundcloud', 'file'];
        if (music_type && !validTypes.includes(music_type)) {
            return res.status(400).json({ error: 'Invalid music type' });
        }
        
        // Validate music URL matches the type
        if (music_url && music_type && music_type !== 'none' && music_type !== 'file') {
            if (!validateMusicUrl(music_type, music_url)) {
                const typeLabels = { youtube: 'YouTube', spotify: 'Spotify', soundcloud: 'SoundCloud' };
                return res.status(400).json({ error: `URL must be a valid ${typeLabels[music_type]} link` });
            }
        }
        
        // If setting to file type, user must be premium and have already uploaded
        if (music_type === 'file') {
            const user = await queryOne('SELECT is_premium, music_url FROM users WHERE id = ?', [req.session.user.id]);
            if (!user?.is_premium) {
                return res.status(403).json({ error: 'Custom audio is a premium feature' });
            }
        }
        
        const preferMusicValue = USE_POSTGRES ? prefer_music_over_video : (prefer_music_over_video ? 1 : 0);
        
        await query(
            `UPDATE users SET 
                music_type = COALESCE(?, music_type),
                music_url = COALESCE(?, music_url),
                music_start = COALESCE(?, music_start),
                music_end = COALESCE(?, music_end),
                prefer_music_over_video = COALESCE(?, prefer_music_over_video)
            WHERE id = ?`,
            [music_type, music_url, music_start || 0, music_end || 0, preferMusicValue, req.session.user.id]
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Update music error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update profile display settings (click to enter, embed position)
app.put('/api/profile/display', requireAuth, async (req, res) => {
    try {
        const { click_to_enter, embed_position } = req.body;
        
        // Validate embed_position
        const validPositions = [
            'bottom-right', 'bottom-left', 'top-right', 'top-left',
            'above-avatar', 'below-username', 'below-userid', 'below-links'
        ];
        if (embed_position && !validPositions.includes(embed_position)) {
            return res.status(400).json({ error: 'Invalid embed position' });
        }
        
        const updates = [];
        const values = [];
        
        if (click_to_enter !== undefined) {
            updates.push('click_to_enter = ?');
            values.push(USE_POSTGRES ? click_to_enter : (click_to_enter ? 1 : 0));
        }
        
        if (embed_position !== undefined) {
            updates.push('embed_position = ?');
            values.push(embed_position);
        }
        
        if (updates.length > 0) {
            values.push(req.session.user.id);
            await query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Update display settings error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Upload custom audio (Premium only)
app.post('/api/profile/audio', requireAuth, checkFileSize('audio'), async (req, res) => {
    try {
        // Check if user is premium
        const user = await queryOne('SELECT is_premium, music_url, music_type FROM users WHERE id = ?', [req.session.user.id]);
        
        if (!user?.is_premium) {
            return res.status(403).json({ error: 'Custom audio uploads are a premium feature' });
        }
        
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        // Check file size (5MB max for audio)
        if (req.file.size > UPLOAD_LIMITS.AUDIO_MAX_SIZE) {
            if (!USE_SUPABASE_STORAGE && req.file.path) {
                fs.unlinkSync(req.file.path);
            }
            return res.status(400).json({ error: 'Audio file must be under 5MB' });
        }
        
        let audioUrl;
        
        if (USE_SUPABASE_STORAGE) {
            // Delete old audio from Supabase if it was a file
            if (user?.music_type === 'file' && user?.music_url) {
                await deleteFromSupabase('audio', user.music_url);
            }
            
            // Upload to Supabase Storage
            const fileName = `${req.session.user.id}/${uuidv4()}${path.extname(req.file.originalname)}`;
            audioUrl = await uploadToSupabase('audio', fileName, req.file.buffer, req.file.mimetype);
        } else {
            // Local storage - delete old file
            if (user?.music_type === 'file' && user?.music_url && fs.existsSync(user.music_url)) {
                fs.unlinkSync(user.music_url);
            }
            audioUrl = req.file.path.replace(/\\/g, '/');
        }
        
        await query(
            'UPDATE users SET music_url = ?, music_type = ? WHERE id = ?',
            [audioUrl, 'file', req.session.user.id]
        );
        
        res.json({ success: true, music_url: audioUrl });
    } catch (error) {
        console.error('Audio upload error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete custom audio
app.delete('/api/profile/audio', requireAuth, async (req, res) => {
    try {
        const user = await queryOne('SELECT music_url, music_type FROM users WHERE id = ?', [req.session.user.id]);
        
        if (user?.music_type === 'file' && user?.music_url) {
            if (USE_SUPABASE_STORAGE) {
                await deleteFromSupabase('audio', user.music_url);
            } else if (fs.existsSync(user.music_url)) {
                fs.unlinkSync(user.music_url);
            }
        }
        
        await query(
            'UPDATE users SET music_url = NULL, music_type = ? WHERE id = ?',
            ['none', req.session.user.id]
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Delete audio error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get user's own badges
app.get('/api/profile/badges', requireAuth, async (req, res) => {
    try {
        const badges = await query(`
            SELECT b.id, b.name, b.image_url, b.description
            FROM badges b
            JOIN user_badges ub ON b.id = ub.badge_id
            WHERE ub.user_id = ?
            ORDER BY ub.granted_at ASC
        `, [req.session.user.id]);
        
        res.json({ badges });
    } catch (error) {
        console.error('Get user badges error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Set repped badge
app.put('/api/profile/repped-badge', requireAuth, async (req, res) => {
    try {
        const { badge_id } = req.body;
        
        // If badge_id is null, clear the repped badge
        if (badge_id === null) {
            await query('UPDATE users SET repped_badge_id = NULL WHERE id = ?', [req.session.user.id]);
            return res.json({ success: true, repped_badge_id: null });
        }
        
        // Verify the user owns this badge
        const userBadge = await queryOne(
            'SELECT id FROM user_badges WHERE user_id = ? AND badge_id = ?',
            [req.session.user.id, badge_id]
        );
        
        if (!userBadge) {
            return res.status(400).json({ error: 'You do not own this badge' });
        }
        
        await query('UPDATE users SET repped_badge_id = ? WHERE id = ?', [badge_id, req.session.user.id]);
        
        res.json({ success: true, repped_badge_id: badge_id });
    } catch (error) {
        console.error('Set repped badge error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Toggle branding (premium only)
app.put('/api/profile/branding', requireAuth, async (req, res) => {
    try {
        // Check if user is premium
        const user = await queryOne('SELECT is_premium FROM users WHERE id = ?', [req.session.user.id]);
        
        if (!user?.is_premium) {
            return res.status(403).json({ error: 'Premium subscription required' });
        }
        
        const { hide_branding } = req.body;
        const hideBrandingValue = USE_POSTGRES ? hide_branding : (hide_branding ? 1 : 0);
        
        await query('UPDATE users SET hide_branding = ? WHERE id = ?', [hideBrandingValue, req.session.user.id]);
        
        res.json({ success: true, hide_branding });
    } catch (error) {
        console.error('Branding toggle error:', error);
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

// Rate limiting for link creation
const linkCreationCooldowns = new Map();
const MAX_LINKS_PER_USER = 20;
const LINK_CREATION_COOLDOWN_MS = 1000; // 1 second between link creations

// Add link
app.post('/api/links', requireAuth, async (req, res) => {
    try {
        const { platform, url } = req.body;
        const userId = req.session.user.id;

        if (!platform || !url) {
            return res.status(400).json({ error: 'Platform and URL are required' });
        }

        // Rate limit: check cooldown
        const lastCreation = linkCreationCooldowns.get(userId);
        if (lastCreation && Date.now() - lastCreation < LINK_CREATION_COOLDOWN_MS) {
            return res.status(429).json({ error: 'Please wait a moment before adding another link' });
        }

        // Check max links limit
        const linkCount = await queryOne(
            'SELECT COUNT(*) as count FROM links WHERE user_id = ?',
            [userId]
        );
        if (linkCount && linkCount.count >= MAX_LINKS_PER_USER) {
            return res.status(400).json({ error: `Maximum of ${MAX_LINKS_PER_USER} links allowed` });
        }

        // Validate URL matches the platform
        if (!validatePlatformUrl(platform, url)) {
            return res.status(400).json({ error: `URL must be a valid ${platform} link` });
        }

        const maxResult = await queryOne(
            'SELECT COALESCE(MAX(display_order), 0) as max FROM links WHERE user_id = ?',
            [userId]
        );
        const newOrder = (maxResult?.max || 0) + 1;

        const link = await insertAndReturn('links', {
            user_id: userId,
            platform,
            url,
            display_order: newOrder
        });

        // Update cooldown
        linkCreationCooldowns.set(userId, Date.now());

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
        
        // Validate URL matches the platform (use new platform or existing)
        const targetPlatform = platform || link.platform;
        const targetUrl = url || link.url;
        if (url && !validatePlatformUrl(targetPlatform, targetUrl)) {
            return res.status(400).json({ error: `URL must be a valid ${targetPlatform} link` });
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

// ============ ADMIN API ROUTES ============

// Admin middleware
const requireAdmin = async (req, res, next) => {
    if (!req.session.admin) {
        return res.status(401).json({ error: 'Admin authentication required' });
    }
    
    // Verify admin still exists and is still admin
    const admin = await queryOne('SELECT id, is_admin FROM users WHERE id = ?', [req.session.admin.id]);
    if (!admin || !admin.is_admin) {
        req.session.admin = null;
        return res.status(401).json({ error: 'Admin privileges revoked' });
    }
    
    next();
};

// Admin login - Step 1: Send verification
app.post('/api/admin/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await queryOne('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        if (!user.is_admin) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        // Check if a verification code was sent recently (60 second cooldown)
        const existingVerification = await queryOne(
            'SELECT * FROM admin_verifications WHERE admin_id = ?',
            [user.id]
        );
        
        if (existingVerification) {
            const createdAt = new Date(existingVerification.created_at);
            const cooldownEnd = new Date(createdAt.getTime() + 60 * 1000); // 60 seconds
            
            if (new Date() < cooldownEnd) {
                const secondsLeft = Math.ceil((cooldownEnd - new Date()) / 1000);
                return res.status(429).json({ 
                    error: `Please wait ${secondsLeft} seconds before requesting another code`,
                    cooldown: secondsLeft
                });
            }
            
            // Cooldown passed, delete old verification
            await query('DELETE FROM admin_verifications WHERE admin_id = ?', [user.id]);
        }

        // Generate verification code
        const code = generateVerificationCode();
        let expiresAt;
        if (USE_POSTGRES) {
            expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        } else {
            expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().replace('T', ' ').replace('Z', '');
        }

        await insertAndReturn('admin_verifications', {
            admin_id: user.id,
            code: code,
            expires_at: expiresAt
        });
        
        // Send verification email
        const emailSent = await sendAdminVerificationEmail(user.email, code);
        
        // Always log the code for backup access (check PM2 logs)
        console.log(`🔐 Admin verification code for ${user.email}: ${code}`);
        
        if (!emailSent && emailTransporter) {
            // Don't block login if email fails - code is logged above
            console.log('⚠️ Email send failed, but code is logged above');
        }
        
        res.json({ success: true, message: 'Verification code sent', adminId: user.id });
    } catch (error) {
        console.error('Admin login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Admin login - Step 2: Verify code
app.post('/api/admin/verify', async (req, res) => {
    try {
        const { adminId, code } = req.body;
        
        const pending = await queryOne(
            'SELECT * FROM admin_verifications WHERE admin_id = ?',
            [adminId]
        );
        
        if (!pending) {
            return res.status(400).json({ error: 'No pending verification' });
        }
        
        const expiresAt = new Date(pending.expires_at);
        if (expiresAt < new Date()) {
            await query('DELETE FROM admin_verifications WHERE admin_id = ?', [adminId]);
            return res.status(400).json({ error: 'Code expired' });
        }
        
        if (pending.code.toUpperCase() !== code.toUpperCase()) {
            return res.status(400).json({ error: 'Invalid code' });
        }
        
        // Get admin user
        const admin = await queryOne('SELECT id, email, username, is_admin FROM users WHERE id = ?', [adminId]);
        
        if (!admin || !admin.is_admin) {
            return res.status(403).json({ error: 'Not authorized' });
        }
        
        // Delete verification
        await query('DELETE FROM admin_verifications WHERE admin_id = ?', [adminId]);

        // Regenerate session to prevent session fixation attacks
        const adminData = { id: admin.id, email: admin.email, username: admin.username };
        
        req.session.regenerate((err) => {
            if (err) {
                console.error('Session regeneration error:', err);
                return res.status(500).json({ error: 'Server error' });
            }
            
            req.session.admin = { id: admin.id, email: admin.email };
            
            req.session.save((err) => {
                if (err) {
                    console.error('Session save error:', err);
                    return res.status(500).json({ error: 'Server error' });
                }
                res.json({ success: true, admin: adminData });
            });
        });
    } catch (error) {
        console.error('Admin verify error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Admin logout
app.post('/api/admin/logout', (req, res) => {
    req.session.admin = null;
    res.json({ success: true });
});

// Admin status check
app.get('/api/admin/status', async (req, res) => {
    if (req.session.admin) {
        const admin = await queryOne('SELECT id, email, username, is_admin FROM users WHERE id = ?', [req.session.admin.id]);
        if (admin && admin.is_admin) {
            return res.json({ 
                authenticated: true, 
                admin: { id: admin.id, email: admin.email, username: admin.username },
                maintenance_mode: maintenanceMode,
                view_only_maintenance_mode: viewOnlyMaintenanceMode
            });
        }
    }
    res.json({ authenticated: false });
});

// Get maintenance mode status
app.get('/api/admin/maintenance', requireAdmin, async (req, res) => {
    res.json({ 
        maintenance_mode: maintenanceMode,
        view_only_maintenance_mode: viewOnlyMaintenanceMode
    });
});

// Toggle full maintenance mode
app.put('/api/admin/maintenance', requireAdmin, async (req, res) => {
    try {
        const { enabled } = req.body;
        const newValue = enabled ? 'true' : 'false';
        
        await query("UPDATE settings SET value = ? WHERE key = 'maintenance_mode'", [newValue]);
        maintenanceMode = enabled;
        
        // If enabling full maintenance, disable view-only maintenance
        if (enabled && viewOnlyMaintenanceMode) {
            await query("UPDATE settings SET value = 'false' WHERE key = 'view_only_maintenance_mode'");
            viewOnlyMaintenanceMode = false;
        }
        
        console.log(`🔧 Full Maintenance mode ${enabled ? 'ENABLED' : 'DISABLED'} by admin`);
        res.json({ 
            success: true, 
            maintenance_mode: maintenanceMode,
            view_only_maintenance_mode: viewOnlyMaintenanceMode
        });
    } catch (error) {
        console.error('Toggle maintenance mode error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Toggle view-only maintenance mode
app.put('/api/admin/maintenance/view-only', requireAdmin, async (req, res) => {
    try {
        const { enabled } = req.body;
        const newValue = enabled ? 'true' : 'false';
        
        await query("UPDATE settings SET value = ? WHERE key = 'view_only_maintenance_mode'", [newValue]);
        viewOnlyMaintenanceMode = enabled;
        
        // If enabling view-only maintenance, disable full maintenance
        if (enabled && maintenanceMode) {
            await query("UPDATE settings SET value = 'false' WHERE key = 'maintenance_mode'");
            maintenanceMode = false;
        }
        
        console.log(`🔧 View-Only Maintenance mode ${enabled ? 'ENABLED' : 'DISABLED'} by admin`);
        res.json({ 
            success: true, 
            maintenance_mode: maintenanceMode,
            view_only_maintenance_mode: viewOnlyMaintenanceMode
        });
    } catch (error) {
        console.error('Toggle view-only maintenance mode error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Search users
app.get('/api/admin/users/search', requireAdmin, async (req, res) => {
    try {
        const { q } = req.query;
        
        if (!q || q.length < 1) {
            return res.json({ users: [] });
        }
        
        const searchTerm = `%${q.toLowerCase()}%`;
        
        let users;
        if (USE_POSTGRES) {
            const result = await pool.query(`
                SELECT id, email, username, display_name, avatar, is_premium, is_admin, 
                       is_deactivated, deactivation_reason, signup_ip, created_at
                FROM users 
                WHERE LOWER(username) LIKE $1 
                   OR LOWER(email) LIKE $1 
                   OR CAST(id AS TEXT) = $2
                ORDER BY id ASC
                LIMIT 50
            `, [searchTerm, q]);
            users = result.rows;
        } else {
            users = db.prepare(`
                SELECT id, email, username, display_name, avatar, is_premium, is_admin,
                       is_deactivated, deactivation_reason, signup_ip, created_at
                FROM users 
                WHERE LOWER(username) LIKE ? 
                   OR LOWER(email) LIKE ? 
                   OR CAST(id AS TEXT) = ?
                ORDER BY id ASC
                LIMIT 50
            `).all(searchTerm, searchTerm, q);
        }
        
        res.json({ users });
    } catch (error) {
        console.error('Search users error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get user details with links and badges
app.get('/api/admin/users/:id', requireAdmin, async (req, res) => {
    try {
        const user = await queryOne(`
            SELECT id, email, username, display_name, bio, avatar, background,
                   background_type, gradient_start, gradient_end, show_userid,
                   is_premium, is_admin, is_deactivated, deactivation_reason,
                   signup_ip, created_at
            FROM users WHERE id = ?
        `, [req.params.id]);
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const links = await query('SELECT * FROM links WHERE user_id = ? ORDER BY display_order', [req.params.id]);
        const badges = await query(`
            SELECT b.id, b.name, b.image_url, b.description, ub.granted_at
            FROM badges b
            JOIN user_badges ub ON b.id = ub.badge_id
            WHERE ub.user_id = ?
            ORDER BY ub.granted_at DESC
        `, [req.params.id]);
        
        res.json({ user, links, badges });
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Remove user's avatar
app.delete('/api/admin/users/:id/avatar', requireAdmin, async (req, res) => {
    try {
        const user = await queryOne('SELECT avatar FROM users WHERE id = ?', [req.params.id]);
        if (!user) return res.status(404).json({ error: 'User not found' });
        
        if (user.avatar) {
            if (USE_SUPABASE_STORAGE) {
                await deleteFromSupabase('avatars', user.avatar);
            } else if (fs.existsSync(user.avatar)) {
                fs.unlinkSync(user.avatar);
            }
        }
        
        await query('UPDATE users SET avatar = NULL WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Remove avatar error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Remove user's background
app.delete('/api/admin/users/:id/background', requireAdmin, async (req, res) => {
    try {
        const user = await queryOne('SELECT background FROM users WHERE id = ?', [req.params.id]);
        if (!user) return res.status(404).json({ error: 'User not found' });
        
        if (user.background) {
            if (USE_SUPABASE_STORAGE) {
                await deleteFromSupabase('backgrounds', user.background);
            } else if (fs.existsSync(user.background)) {
                fs.unlinkSync(user.background);
            }
        }
        
        await query('UPDATE users SET background = NULL, background_type = ? WHERE id = ?', ['gradient', req.params.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Remove background error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Edit user's display name
app.put('/api/admin/users/:id/display-name', requireAdmin, async (req, res) => {
    try {
        const { display_name } = req.body;
        await query('UPDATE users SET display_name = ? WHERE id = ?', [display_name, req.params.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Edit display name error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Edit user's bio
app.put('/api/admin/users/:id/bio', requireAdmin, async (req, res) => {
    try {
        const { bio } = req.body;
        await query('UPDATE users SET bio = ? WHERE id = ?', [bio, req.params.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Edit bio error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get user's links (for editing)
app.get('/api/admin/users/:id/links', requireAdmin, async (req, res) => {
    try {
        const links = await query('SELECT * FROM links WHERE user_id = ? ORDER BY display_order', [req.params.id]);
        res.json({ links });
    } catch (error) {
        console.error('Get links error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update user's link
app.put('/api/admin/users/:userId/links/:linkId', requireAdmin, async (req, res) => {
    try {
        const { platform, url } = req.body;
        await query('UPDATE links SET platform = ?, url = ? WHERE id = ? AND user_id = ?', 
            [platform, url, req.params.linkId, req.params.userId]);
        res.json({ success: true });
    } catch (error) {
        console.error('Update link error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete user's link
app.delete('/api/admin/users/:userId/links/:linkId', requireAdmin, async (req, res) => {
    try {
        await query('DELETE FROM links WHERE id = ? AND user_id = ?', [req.params.linkId, req.params.userId]);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete link error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Add new link for user
app.post('/api/admin/users/:userId/links', requireAdmin, async (req, res) => {
    try {
        const { platform, url } = req.body;
        if (!platform || !url) {
            return res.status(400).json({ error: 'Platform and URL are required' });
        }
        
        const maxOrder = await queryOne('SELECT MAX(display_order) as max_order FROM links WHERE user_id = ?', [req.params.userId]);
        const displayOrder = (maxOrder?.max_order || 0) + 1;
        
        await insertAndReturn('links', {
            user_id: parseInt(req.params.userId),
            platform,
            url,
            display_order: displayOrder,
            is_active: USE_POSTGRES ? true : 1
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Add link error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Set user's avatar URL
app.put('/api/admin/users/:id/avatar', requireAdmin, async (req, res) => {
    try {
        const { avatar_url } = req.body;
        await query('UPDATE users SET avatar = ? WHERE id = ?', [avatar_url || null, req.params.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Set avatar error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Set user's background
app.put('/api/admin/users/:id/background', requireAdmin, async (req, res) => {
    try {
        const { background_url, background_type, gradient_start, gradient_end, background_video } = req.body;
        
        const updates = [];
        const values = [];
        
        if (background_type !== undefined) {
            updates.push('background_type = ?');
            values.push(background_type);
        }
        if (background_url !== undefined) {
            updates.push('background = ?');
            values.push(background_url || null);
        }
        if (gradient_start !== undefined) {
            updates.push('gradient_start = ?');
            values.push(gradient_start);
        }
        if (gradient_end !== undefined) {
            updates.push('gradient_end = ?');
            values.push(gradient_end);
        }
        if (background_video !== undefined) {
            updates.push('background_video = ?');
            values.push(background_video || null);
        }
        
        if (updates.length > 0) {
            values.push(req.params.id);
            await query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Set background error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Set user's music settings
app.put('/api/admin/users/:id/music', requireAdmin, async (req, res) => {
    try {
        const { music_type, music_url, music_start, music_end, prefer_music_over_video } = req.body;
        
        await query(`UPDATE users SET 
            music_type = ?, 
            music_url = ?, 
            music_start = ?, 
            music_end = ?, 
            prefer_music_over_video = ? 
            WHERE id = ?`, [
            music_type || 'none',
            music_url || null,
            music_start || 0,
            music_end || 0,
            USE_POSTGRES ? (prefer_music_over_video || false) : (prefer_music_over_video ? 1 : 0),
            req.params.id
        ]);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Set music error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Deactivate account
app.post('/api/admin/users/:id/deactivate', requireAdmin, async (req, res) => {
    try {
        const { reason } = req.body;
        
        if (!reason || reason.trim().length === 0) {
            return res.status(400).json({ error: 'Deactivation reason is required' });
        }
        
        const deactivatedValue = USE_POSTGRES ? true : 1;
        await query('UPDATE users SET is_deactivated = ?, deactivation_reason = ? WHERE id = ?', 
            [deactivatedValue, reason.trim(), req.params.id]);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Deactivate error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Reactivate account
app.post('/api/admin/users/:id/reactivate', requireAdmin, async (req, res) => {
    try {
        const { confirm } = req.body;
        
        if (confirm !== 'REACTIVATE') {
            return res.status(400).json({ error: 'Confirmation required' });
        }
        
        const deactivatedValue = USE_POSTGRES ? false : 0;
        await query('UPDATE users SET is_deactivated = ?, deactivation_reason = NULL WHERE id = ?', 
            [deactivatedValue, req.params.id]);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Reactivate error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete account permanently
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
    try {
        const { confirm } = req.body;
        
        if (confirm !== 'DELETE') {
            return res.status(400).json({ error: 'Confirmation required' });
        }
        
        // Get user to delete their files
        const user = await queryOne('SELECT avatar, background FROM users WHERE id = ?', [req.params.id]);
        
        if (user) {
            // Delete avatar
            if (user.avatar) {
                if (USE_SUPABASE_STORAGE) {
                    await deleteFromSupabase('avatars', user.avatar);
                } else if (fs.existsSync(user.avatar)) {
                    fs.unlinkSync(user.avatar);
                }
            }
            
            // Delete background
            if (user.background) {
                if (USE_SUPABASE_STORAGE) {
                    await deleteFromSupabase('backgrounds', user.background);
                } else if (fs.existsSync(user.background)) {
                    fs.unlinkSync(user.background);
                }
            }
        }
        
        await query('DELETE FROM users WHERE id = ?', [req.params.id]);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Grant premium
app.post('/api/admin/users/:id/premium', requireAdmin, async (req, res) => {
    try {
        const premiumValue = USE_POSTGRES ? true : 1;
        await query('UPDATE users SET is_premium = ? WHERE id = ?', [premiumValue, req.params.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Grant premium error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Remove premium
app.delete('/api/admin/users/:id/premium', requireAdmin, async (req, res) => {
    try {
        const premiumValue = USE_POSTGRES ? false : 0;
        await query('UPDATE users SET is_premium = ? WHERE id = ?', [premiumValue, req.params.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Remove premium error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============ BADGE MANAGEMENT ============

// Get all badges
app.get('/api/admin/badges', requireAdmin, async (req, res) => {
    try {
        const badges = await query('SELECT * FROM badges ORDER BY id ASC');
        res.json({ badges });
    } catch (error) {
        console.error('Get badges error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Upload badge image
app.post('/api/admin/badges/upload', requireAdmin, upload.single('badge'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        // Check file size (10MB max for badges)
        if (req.file.size > 10 * 1024 * 1024) {
            return res.status(400).json({ error: 'Badge image must be under 10MB' });
        }

        let imageUrl;

        if (USE_SUPABASE_STORAGE) {
            // Upload to Supabase Storage in badges bucket
            const fileName = `badges/${uuidv4()}${path.extname(req.file.originalname)}`;
            imageUrl = await uploadToSupabase('avatars', fileName, req.file.buffer, req.file.mimetype);
        } else {
            // Local storage - save to uploads/badges folder
            const badgesDir = 'uploads/badges';
            if (!fs.existsSync(badgesDir)) {
                fs.mkdirSync(badgesDir, { recursive: true });
            }
            const fileName = `${uuidv4()}${path.extname(req.file.originalname)}`;
            const filePath = path.join(badgesDir, fileName);
            fs.writeFileSync(filePath, req.file.buffer);
            imageUrl = '/' + filePath.replace(/\\/g, '/');
        }

        res.json({ success: true, image_url: imageUrl });
    } catch (error) {
        console.error('Badge upload error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Create badge
app.post('/api/admin/badges', requireAdmin, async (req, res) => {
    try {
        const { name, image_url, description } = req.body;

        if (!name || !image_url) {
            return res.status(400).json({ error: 'Name and image URL are required' });
        }

        const badge = await insertAndReturn('badges', {
            name,
            image_url,
            description: description || null
        });

        res.json({ success: true, badge });
    } catch (error) {
        console.error('Create badge error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete badge
app.delete('/api/admin/badges/:id', requireAdmin, async (req, res) => {
    try {
        await query('DELETE FROM badges WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete badge error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Grant badge to user
app.post('/api/admin/users/:userId/badges/:badgeId', requireAdmin, async (req, res) => {
    try {
        await insertAndReturn('user_badges', {
            user_id: parseInt(req.params.userId),
            badge_id: parseInt(req.params.badgeId)
        });
        res.json({ success: true });
    } catch (error) {
        if (error.message?.includes('UNIQUE') || error.code === '23505') {
            return res.status(400).json({ error: 'User already has this badge' });
        }
        console.error('Grant badge error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Remove badge from user
app.delete('/api/admin/users/:userId/badges/:badgeId', requireAdmin, async (req, res) => {
    try {
        await query('DELETE FROM user_badges WHERE user_id = ? AND badge_id = ?', 
            [req.params.userId, req.params.badgeId]);
        res.json({ success: true });
    } catch (error) {
        console.error('Remove badge error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============ PUBLIC BADGE API ============

// Get user's badges (public)
app.get('/api/users/:username/badges', async (req, res) => {
    try {
        const user = await queryOne('SELECT id FROM users WHERE username = ?', [req.params.username.toLowerCase()]);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const badges = await query(`
            SELECT b.id, b.name, b.image_url, b.description
            FROM badges b
            JOIN user_badges ub ON b.id = ub.badge_id
            WHERE ub.user_id = ?
            ORDER BY ub.granted_at ASC
        `, [user.id]);
        
        res.json({ badges });
    } catch (error) {
        console.error('Get user badges error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get public profile
app.get('/api/profile/:username', async (req, res) => {
    try {
        const user = await queryOne(
            `SELECT u.id, u.username, u.display_name, u.bio, u.avatar, u.background, 
                    u.background_type, u.gradient_start, u.gradient_end, u.show_userid, u.is_premium, u.hide_branding,
                    u.background_video, u.video_audio_default, u.repped_badge_id,
                    u.music_type, u.music_url, u.music_start, u.music_end, u.prefer_music_over_video,
                    u.click_to_enter, u.embed_position,
                    b.name as repped_badge_name, b.image_url as repped_badge_image
             FROM users u
             LEFT JOIN badges b ON u.repped_badge_id = b.id
             WHERE u.username = ?`,
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

// Public maintenance status (for maintenance page)
app.get('/api/maintenance/status', (req, res) => {
    res.json({
        maintenance_mode: maintenanceMode,
        view_only_maintenance_mode: viewOnlyMaintenanceMode
    });
});

// ============ PAGE ROUTES ============

app.get('/maintenance', (req, res) => {
    // Redirect to home if both maintenance modes are off
    if (!maintenanceMode && !viewOnlyMaintenanceMode) {
        return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, 'public', 'maintenance.html'));
});

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

app.get('/admin-panel-for-the-lolz', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-panel-for-the-lolz.html'));
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
        
        // Load maintenance mode from database
        try {
            const setting = await queryOne("SELECT value FROM settings WHERE key = 'maintenance_mode'");
            maintenanceMode = setting && setting.value === 'true';
            
            const viewOnlySetting = await queryOne("SELECT value FROM settings WHERE key = 'view_only_maintenance_mode'");
            viewOnlyMaintenanceMode = viewOnlySetting && viewOnlySetting.value === 'true';
            
            if (maintenanceMode) {
                console.log(`🔧 Full Maintenance mode: ENABLED`);
            } else if (viewOnlyMaintenanceMode) {
                console.log(`🔧 View-Only Maintenance mode: ENABLED`);
            } else {
                console.log(`🔧 Maintenance mode: disabled`);
            }
        } catch (e) {
            console.log('⚠️ Could not load maintenance mode setting');
        }
        
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
