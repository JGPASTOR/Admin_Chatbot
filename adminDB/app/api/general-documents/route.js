import pool from '../../../lib/db';
import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

/* ── helpers ── */
async function parseFile(buffer, ext) {
    if (ext === 'xlsx' || ext === 'xls') {
        const XLSX = await import('xlsx');
        const wb = XLSX.read(buffer, { type: 'buffer' });
        const sheets = {};
        for (const name of wb.SheetNames) {
            sheets[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 });
        }
        return { type: 'spreadsheet', sheets };
    }

    if (ext === 'docx') {
        const mammoth = await import('mammoth');
        const result = await mammoth.convertToHtml({ buffer });
        const textResult = await mammoth.extractRawText({ buffer });
        return { type: 'word', html: result.value, text: textResult.value };
    }

    if (ext === 'pdf') {
        const pdfModule = await import('pdf-parse');
        let PDFParseClass = pdfModule.default || pdfModule;
        if (typeof PDFParseClass !== 'function' && PDFParseClass.PDFParse) {
            PDFParseClass = PDFParseClass.PDFParse;
        }

        const parser = new PDFParseClass({ data: buffer });
        const data = await parser.getText();
        await parser.destroy();
        return { type: 'pdf', text: data.text, pages: data.total || data.numpages || 0 };
    }

    return { type: 'unknown', text: '' };
}

const UPLOAD_DIR = path.join(process.cwd(), 'public', 'uploads');
const MAX_SIZE = 30 * 1024 * 1024; // 30 MB

/* ── GET — list all general documents ── */
export async function GET() {
    try {
        const [rows] = await pool.query(
            'SELECT id, filename, original_name, file_type, file_size, created_at FROM general_documents ORDER BY created_at DESC'
        );
        return NextResponse.json({ success: true, data: rows });
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}

/* ── POST — upload + parse a file ── */
export async function POST(request) {
    try {
        const formData = await request.formData();
        const file = formData.get('file');

        if (!file || typeof file === 'string') {
            return NextResponse.json({ success: false, error: 'No file provided.' }, { status: 400 });
        }

        // Check size
        if (file.size > MAX_SIZE) {
            return NextResponse.json({ success: false, error: 'File exceeds the 30 MB limit.' }, { status: 400 });
        }

        // Determine extension
        const originalName = file.name;
        const ext = originalName.split('.').pop().toLowerCase();
        const allowed = ['pdf', 'docx', 'xlsx', 'xls', 'doc'];
        if (!allowed.includes(ext)) {
            return NextResponse.json({ success: false, error: `File type .${ext} is not supported. Allowed: .pdf, .docx, .xlsx` }, { status: 400 });
        }

        // Read file into buffer
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // Save to disk
        await fs.mkdir(UPLOAD_DIR, { recursive: true });
        const timestamp = Date.now();
        const safeFilename = `${timestamp}_${originalName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const filePath = path.join(UPLOAD_DIR, safeFilename);
        await fs.writeFile(filePath, buffer);

        // Parse the file
        let extractedData = {};
        try {
            extractedData = await parseFile(buffer, ext);
        } catch (parseErr) {
            console.error('Parse error:', parseErr.message);
            extractedData = { type: ext, text: '', error: 'Could not parse file content.' };
        }

        // Insert into DB
        const [result] = await pool.query(
            `INSERT INTO general_documents (filename, original_name, file_type, file_size, file_path, extracted_data)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [safeFilename, originalName, ext, file.size, `/uploads/${safeFilename}`, JSON.stringify(extractedData)]
        );

        // ── Forward extracted text to AI Engine RAG pipeline (non-blocking) ──
        const rawText =
            extractedData.text ||
            (extractedData.sheets ? JSON.stringify(extractedData.sheets) : '');

        let ragWarning = null;
        if (rawText) {
            const aiEngineUrl = process.env.AI_ENGINE_URL || 'http://127.0.0.1:8000';
            try {
                // Call ingest async (don't await deeply if we don't need to block UI)
                // We'll await it with a timeout to catch obvious errors, but we don't fail upload if AI fails
                const ragRes = await fetch(`${aiEngineUrl}/api/rag/ingest`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: originalName, text: rawText }),
                    signal: AbortSignal.timeout(15_000), // Reduce from 60s to 15s to avoid freezing UI
                });

                if (!ragRes.ok) {
                    const errBody = await ragRes.text();
                    ragWarning = `AI Engine returned ${ragRes.status}: ${errBody}`;
                    console.warn('[RAG Ingest] Warning:', ragWarning);
                } else {
                    const ragData = await ragRes.json();
                    console.log(`[RAG Ingest] OK — ${ragData.chunks_added ?? 'N/A'} chunks added for '${originalName}'.`);
                }
            } catch (ragErr) {
                // Ignore timeout or connection refused errors quietly so it doesn't break upload
                ragWarning = `Could not reach AI Engine: ${ragErr.message}`;
                console.warn('[RAG Ingest] Warning:', ragWarning);
            }
        }

        return NextResponse.json({
            success: true,
            data: {
                id: result.insertId,
                filename: safeFilename,
                original_name: originalName,
                file_type: ext,
                file_size: file.size,
            },
            rag_warning: ragWarning,  // null if AI Engine ingestion succeeded
        });
    } catch (err) {
        console.error('Upload error:', err);
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
