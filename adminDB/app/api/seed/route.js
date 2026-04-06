/**
 * GET /api/seed
 * One-time endpoint: inserts the real document from documents.json
 * and the default offices into MySQL.
 * 
 * Visit http://localhost:3000/api/seed ONCE after running schema.sql.
 * Safe to call again — uses INSERT IGNORE so duplicates are skipped.
 */
import pool from '../../../lib/db';
import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const DEFAULT_OFFICES = [
    { code: 'CMO', name: "City Mayor's Office", head: 'Mayor Jose Santos' },
    { code: 'CTO', name: 'City Treasury Office', head: 'Treasurer Maria Cruz' },
    { code: 'CAO', name: 'City Accounting Office', head: 'Accountant Pedro Reyes' },
    { code: 'CHO', name: 'City Health Office', head: 'Dr. Ana Flores' },
    { code: 'CBO', name: 'City Budget Office', head: 'Budget Officer Leo Tan' },
    { code: 'CSWD', name: 'City Social Welfare and Development Office', head: 'CSWD Head' },
    { code: 'CAD', name: "City Administrator's Office", head: 'Administrator' },
    { code: 'BAC', name: 'Bids and Awards Committee (City Mayor\'s Office)', head: 'BAC Chair' },
    { code: 'CEO', name: 'Office of the City Engineer (City Engineering Office)', head: 'City Engineer' },
];

export async function GET() {
    try {
        const rootDir = process.cwd();
        const files = [];
        for (let i = 1006; i <= 1010; i++) files.push(`document${i}.json`);

        for (const file of files) {
            try {
                const filePath = path.join(rootDir, file);
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
                }
            } catch (err) {
                console.error(`Error reading/inserting ${file}:`, err.message);
            }
        }

        // ── Seed a Travel Order (Hardcoded Mock Data) ────────────────────────
        await pool.query(
            `INSERT IGNORE INTO documents
        (id, slug, title, agency, office, subject, created_at, created_by,
         validated_at, validated_by, overall_days_onprocess,
         document_completed_status, details)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
                1001,
                '1025202413940341989-travel-order',
                'TRAVEL ORDER',
                'City Government of Surigao',
                "City Mayor's Office",
                'Travel order for official business to Manila for budget coordination meeting.',
                '10/25/2024', 'Santos, Maria', '10/25/2024 | 08:00:00 AM', 'Santos, Maria',
                '00 Mon/s, 02 Day/s, 01 hour/s, 15 min., & 00 sec. ', 1,
                JSON.stringify({
                    routes: [
                        { age: '00 Mon/s, 00 Day/s, 01 hour/s, 00 min., & 00 sec. ', office: "1. City Mayor's Office", date_out: 'Oct 25, 2024 09:00:00 AM', received_at: 'Oct 25, 2024 08:00:00 AM', staff_operation: { employee: [{ 'no.': 1, tat: '01:00:00', received_by: 'Santos, Maria', current_operation: 'For Signature', date_out: 'Oct 25, 2024 @ 09:00:00 AM', received_at: 'Oct 25, 2024 08:00:00 AM', received_by_photopath: '', remarks: null, isreturn: false, processing: { process: [{ 'no.': 1, action: 'For Signature', started: 'Oct 25, 2024 08:00:00 AM', ended: 'Oct 25, 2024 09:00:00 AM', tat: '01:00:00', isreturn: false, remarks: null }] } }] } },
                        { age: '00 Mon/s, 02 Day/s, 00 hour/s, 15 min., & 00 sec. ', office: "2. City Administrator's Office", date_out: 'Oct 27, 2024 09:15:00 AM', received_at: 'Oct 25, 2024 09:00:00 AM', staff_operation: { employee: [{ 'no.': 1, tat: '2 days', received_by: 'Temon, Diana Rose', current_operation: 'Approved', date_out: 'Oct 27, 2024 @ 09:15:00 AM', received_at: 'Oct 25, 2024 09:00:00 AM', received_by_photopath: '', remarks: null, isreturn: false, processing: { process: [{ 'no.': 1, action: 'Approved', started: 'Oct 25, 2024 09:00:00 AM', ended: 'Oct 27, 2024 09:15:00 AM', tat: '2 days 00:15:00', isreturn: false, remarks: null }] } }] } },
                    ]
                }),
            ]
        );

        // ── Seed offices ────────────────────────────────────────────────────
        for (const o of DEFAULT_OFFICES) {
            await pool.query(
                'INSERT IGNORE INTO offices (code, name, head) VALUES (?, ?, ?)',
                [o.code, o.name, o.head]
            );
        }

        const [docRows] = await pool.query('SELECT COUNT(*) AS cnt FROM documents');
        const [offRows] = await pool.query('SELECT COUNT(*) AS cnt FROM offices');

        return NextResponse.json({
            success: true,
            seeded: true,
            documents: docRows[0].cnt,
            offices: offRows[0].cnt,
            message: 'All 5 documents and offices seeded successfully.',
        });
    } catch (err) {
        console.error('Seed error:', err);
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
