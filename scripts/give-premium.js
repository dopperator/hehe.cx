// Script to give a user premium status
// Usage: node scripts/give-premium.js <user_id>

const Database = require('better-sqlite3');
const db = new Database('hehecx.db');

const userId = process.argv[2] || 1;

try {
    const user = db.prepare('SELECT id, username, email, is_premium FROM users WHERE id = ?').get(userId);
    
    if (!user) {
        console.log(`❌ User with ID ${userId} not found`);
        process.exit(1);
    }
    
    console.log(`Found user: ${user.username} (${user.email})`);
    console.log(`Current premium status: ${user.is_premium ? 'Premium' : 'Free'}`);
    
    db.prepare('UPDATE users SET is_premium = 1 WHERE id = ?').run(userId);
    
    console.log(`✅ User ${user.username} (ID: ${userId}) is now Premium!`);
} catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
}

db.close();

