
import mysql from 'mysql2/promise';

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'documenttracker',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

async function initDb() {
    const conn = await pool.getConnection();
    try {
        await conn.query(`
            CREATE TABLE IF NOT EXISTS \`documents\` (
                \`id\`                        INT            NOT NULL AUTO_INCREMENT PRIMARY KEY,
                \`slug\`                      VARCHAR(300)   DEFAULT NULL,
                \`title\`                     VARCHAR(255)   DEFAULT NULL,
                \`agency\`                    VARCHAR(255)   DEFAULT NULL,
                \`office\`                    VARCHAR(255)   DEFAULT NULL,
                \`subject\`                   TEXT           DEFAULT NULL,
                \`file_type\`                 VARCHAR(50)    DEFAULT 'n/a',
                \`is_public\`                 TINYINT(1)     DEFAULT 1,
                \`created_at\`                VARCHAR(50)    DEFAULT NULL,
                \`created_by\`                VARCHAR(100)   DEFAULT NULL,
                \`validated_at\`              VARCHAR(100)   DEFAULT NULL,
                \`validated_by\`              VARCHAR(100)   DEFAULT NULL,
                \`document_type\`             VARCHAR(100)   DEFAULT NULL,
                \`user_retention\`            VARCHAR(200)   DEFAULT NULL,
                \`office_retention\`          VARCHAR(200)   DEFAULT NULL,
                \`overall_days_onprocess\`    VARCHAR(200)   DEFAULT NULL,
                \`document_completed_status\` TINYINT(1)     DEFAULT 0,
                \`details\`                   JSON           DEFAULT NULL,
                \`created_timestamp\`         DATETIME       DEFAULT CURRENT_TIMESTAMP,
                \`updated_timestamp\`         DATETIME       DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY \`slug_unique\` (\`slug\`(191))
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);

        await conn.query(`
            CREATE TABLE IF NOT EXISTS \`offices\` (
                \`id\`   INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
                \`code\` VARCHAR(20)  DEFAULT NULL,
                \`name\` VARCHAR(255) DEFAULT NULL,
                \`head\` VARCHAR(100) DEFAULT NULL,
                UNIQUE KEY \`code_unique\` (\`code\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);

        await conn.query(`
            CREATE TABLE IF NOT EXISTS \`general_documents\` (
                \`id\`             INT            NOT NULL AUTO_INCREMENT PRIMARY KEY,
                \`filename\`       VARCHAR(255)   NOT NULL,
                \`original_name\`  VARCHAR(255)   NOT NULL,
                \`file_type\`      VARCHAR(20)    NOT NULL,
                \`file_size\`      INT            DEFAULT 0,
                \`file_path\`      VARCHAR(500)   DEFAULT NULL,
                \`extracted_data\` JSON           DEFAULT NULL,
                \`keywords\`       JSON           DEFAULT NULL,
                \`created_at\`     DATETIME       DEFAULT CURRENT_TIMESTAMP,
                \`updated_at\`     DATETIME       DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);

        // Add keywords column if it doesn't exist yet (for existing installs)
        try {
            await conn.query(`ALTER TABLE general_documents ADD COLUMN \`keywords\` JSON DEFAULT NULL`);
        } catch { /* already exists */ }

        await conn.query(`
            CREATE TABLE IF NOT EXISTS \`pending_faqs\` (
                \`id\`         INT            NOT NULL AUTO_INCREMENT PRIMARY KEY,
                \`doc_id\`     INT            DEFAULT NULL,
                \`doc_name\`   VARCHAR(255)   DEFAULT NULL,
                \`section\`    VARCHAR(100)   DEFAULT NULL,
                \`question\`   TEXT           NOT NULL,
                \`answer\`     TEXT           NOT NULL,
                \`status\`     VARCHAR(20)    DEFAULT 'pending',
                \`created_at\` DATETIME       DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);

        await conn.query(`
            CREATE TABLE IF NOT EXISTS \`faq_entries\` (
                \`id\`         INT            NOT NULL AUTO_INCREMENT PRIMARY KEY,
                \`question\`   TEXT           NOT NULL,
                \`answer\`     TEXT           NOT NULL,
                \`section\`    VARCHAR(100)   DEFAULT NULL,
                \`doc_id\`     INT            DEFAULT NULL,
                \`doc_name\`   VARCHAR(255)   DEFAULT NULL,
                \`created_at\` DATETIME       DEFAULT CURRENT_TIMESTAMP,
                \`updated_at\` DATETIME       DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);

        // Migration guard: fix pre-existing faq_entries tables that may be missing defaults
        await conn.query(`
            ALTER TABLE \`faq_entries\`
                MODIFY COLUMN \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
                MODIFY COLUMN \`updated_at\` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        `).catch(() => { /* ignore if already correct */ });

        // Migrate existing installs — add doc_id / doc_name if missing
        try { await conn.query(`ALTER TABLE faq_entries ADD COLUMN \`doc_id\` INT DEFAULT NULL`); } catch { /* exists */ }
        try { await conn.query(`ALTER TABLE faq_entries ADD COLUMN \`doc_name\` VARCHAR(255) DEFAULT NULL`); } catch { /* exists */ }

        console.log('✅ DB tables ready (documenttracker)');
    } catch (err) {
        console.error('❌ DB init error:', err.message);
    } finally {
        conn.release();
    }
}

initDb();

export default pool;
