import mysql from 'mysql2/promise';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
    const pool = mysql.createPool({
        host: 'localhost',
        port: 3308,
        user: 'dts_user',
        password: 'dts_pass',
        database: 'documenttracker',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
    });

    try {
        const adminDir = __dirname;
        const rootDir = path.join(__dirname, '..');
        const files = ['documents.json', 'document2.json', 'document3.json', 'document4.json', 'document5.json'];

        console.log('Connecting to Docker MySQL (Port 3308) & seeding documents...');

        for (const file of files) {
            try {
                // Try adminDB folder first, then root
                let filePath = path.join(adminDir, file);
                try { await fs.access(filePath); } catch { filePath = path.join(rootDir, file); }
                
                const fileContent = await fs.readFile(filePath, 'utf8');
                const rawJson = JSON.parse(fileContent);
                const doc = rawJson.data;

                if (doc) {
                    await pool.query(
                        `INSERT IGNORE INTO documents
                    (id, slug, title, agency, office, subject, file_type, is_public,
                     created_at, created_by, validated_at, validated_by, document_type,
                     user_retention, office_retention, overall_days_onprocess,
                     document_completed_status, details)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                        [
                            doc.id, doc.slug, doc.title, doc.agency, doc.office, doc.subject,
                            doc.file_type || 'n/a', doc.is_public ? 1 : 0, doc.created_at,
                            doc.created_by, doc.validated_at, doc.validated_by,
                            doc.document_type || null, doc.user_retention || null,
                            doc.office_retention || null, doc.overall_days_onprocess || null,
                            doc.document_completed_status ? 1 : 0, JSON.stringify(doc.details)
                        ]
                    );
                    console.log(`✅ Seeded ${file} (ID: ${doc.id})`);
                }
            } catch (err) {
                console.error(`❌ Error with ${file}:`, err.message);
            }
        }
    } finally {
        await pool.end();
        console.log('Done.');
    }
}

run();
