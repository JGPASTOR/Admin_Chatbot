import pool from '../../../lib/db';
import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { extractKeywordsFromDoc } from '../../../lib/keywords';

/* ── Text cleaner — strips decorative separator lines before chunking/LLM ── */
function cleanDocText(text) {
    return text
        .split('\n')
        .map(line => {
            const t = line.trim();
            if (/^([═=\-_*~─━▬•·\s])\1{2,}$/.test(t)) return '';
            if (t.length > 0 && (t.replace(/[^a-zA-Z0-9]/g, '').length / t.length) < 0.2) return '';
            return line;
        })
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/* ── Auto-FAQ chunk helpers ── */
const MIN_CHUNK = 150;
const MAX_CHUNK = 800;

/**
 * Semantic chunking:
 * 1. Split by SECTION headers first (preserves document structure)
 * 2. Within each section, split by paragraph (blank lines)
 * 3. Merge tiny paragraphs into previous chunk; split huge ones by sentence
 */
function chunkText(text) {
    // Split at SECTION boundaries first
    const sectionPattern = /(?=\bSECTION\s+\d+\b)/gi;
    const sections = text.split(sectionPattern);
    const chunks = [];

    for (const section of sections) {
        const s = section.trim();
        if (!s) continue;

        // Split section into paragraphs (2+ newlines = paragraph break)
        const paragraphs = s.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length >= 30);

        let current = '';
        for (const para of paragraphs) {
            if ((current + '\n\n' + para).trim().length <= MAX_CHUNK) {
                current = current ? current + '\n\n' + para : para;
            } else {
                if (current.length >= MIN_CHUNK) chunks.push(current.trim());
                // If paragraph itself is too large, split by sentences
                if (para.length > MAX_CHUNK) {
                    const sentences = para.match(/[^.!?]+[.!?]+/g) || [para];
                    let sub = '';
                    for (const sent of sentences) {
                        if ((sub + ' ' + sent).trim().length <= MAX_CHUNK) {
                            sub = sub ? sub + ' ' + sent : sent;
                        } else {
                            if (sub.length >= MIN_CHUNK) chunks.push(sub.trim());
                            sub = sent;
                        }
                    }
                    if (sub.length >= MIN_CHUNK) chunks.push(sub.trim());
                    current = '';
                } else {
                    current = para;
                }
            }
        }
        if (current.length >= MIN_CHUNK) chunks.push(current.trim());
    }

    return chunks;
}

function inferLabel(chunk) {
    const lines = chunk.split('\n').map(l => l.trim()).filter(Boolean);
    const firstLine = lines[0] || '';
    const secMatch = firstLine.match(/^SECTION\s+(\d+)\s*[—\-:.]?\s*(.*)/i);
    if (secMatch) {
        const num = secMatch[1];
        const topic = secMatch[2].trim();
        return { label: `Section ${num}`, topic: topic || `Section ${num}` };
    }
    // ALL-CAPS heading
    if (firstLine === firstLine.toUpperCase() && firstLine.length > 3 && firstLine.length < 100)
        return { label: firstLine.slice(0, 60), topic: firstLine };
    // Title-case line without period
    if (firstLine.length < 80 && !firstLine.endsWith('.') && lines.length > 1)
        return { label: firstLine.slice(0, 60), topic: firstLine };
    return { label: firstLine.slice(0, 60), topic: firstLine };
}

/**
 * Smarter question generation:
 * - Detects definition patterns → "What is X?"
 * - Detects requirement/must patterns → "What are the requirements for X?"
 * - Detects procedure/steps → "How do you X?"
 * - Detects purpose/objective → "What is the purpose of X?"
 * - Falls back to topic-based question
 */
function makeQuestion(topic, chunkBody) {
    const t = topic.trim();
    if (!t) return 'What does this section cover?';
    if (t.endsWith('?')) return t;

    const stripped = t.replace(/^SECTION\s+\d+\s*[—\-:.]?\s*/i, '').trim();
    if (!stripped) return `What is Section ${t}?`;

    const lower = stripped.toLowerCase();
    const body = (chunkBody || '').toLowerCase();

    // Already a question word
    if (/^(what|how|why|when|where|who|which|can|is|are|does|do)\b/.test(lower)) {
        return stripped.endsWith('?') ? stripped : stripped + '?';
    }

    // Definition clues in body
    if (/\b(means|refers to|is defined as|is described as)\b/.test(body))
        return `What is ${stripped}?`;

    // Requirement/must clues
    if (/\b(must|shall|required|requirement|comply|compliance)\b/.test(body))
        return `What are the requirements for ${stripped}?`;

    // Procedure/process clues
    if (/\b(steps|procedure|process|how to|follow|submit|apply|accomplish)\b/.test(body))
        return `How do you ${stripped.toLowerCase()}?`;

    // Purpose/objective clues
    if (/\b(purpose|objective|goal|aim|intend|ensure)\b/.test(body))
        return `What is the purpose of ${stripped}?`;

    // Eligibility clues
    if (/\b(eligible|eligibility|qualify|qualified|who can)\b/.test(body))
        return `Who is eligible for ${stripped}?`;

    // Default: "What is X?"
    return `What is ${stripped}?`;
}

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

/* ── DELETE — remove a document by id ── */
export async function DELETE(request) {
    try {
        const { id } = await request.json();
        if (!id) return NextResponse.json({ success: false, error: 'id is required.' }, { status: 400 });

        // Fetch file info before deleting
        const [rows] = await pool.query('SELECT filename, original_name FROM general_documents WHERE id = ?', [id]);
        if (rows.length === 0) return NextResponse.json({ success: false, error: 'Document not found.' }, { status: 404 });
        const { filename, original_name } = rows[0];

        // Delete from DB (cascade: pending_faqs reference doc_id but we'll clean those too)
        await pool.query('DELETE FROM general_documents WHERE id = ?', [id]);
        await pool.query('DELETE FROM pending_faqs WHERE doc_id = ?', [id]);

        // Delete file from disk (non-fatal)
        try {
            const filePath = path.join(UPLOAD_DIR, filename);
            await fs.unlink(filePath);
        } catch { /* file may not exist */ }

        // Notify AI Engine to remove from RAG index (non-fatal)
        const aiEngineUrl = process.env.AI_ENGINE_URL || 'http://127.0.0.1:8000';
        try {
            await fetch(`${aiEngineUrl}/api/rag/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: original_name }),
                signal: AbortSignal.timeout(8000),
            });
        } catch { /* non-fatal */ }

        return NextResponse.json({ success: true, message: `"${original_name}" deleted.` });
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}

/* ── GET — list all general documents ── */
export async function GET() {
    try {
        const [rows] = await pool.query(
            'SELECT id, filename, original_name, file_type, file_size, keywords, created_at FROM general_documents ORDER BY created_at DESC'
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

        const docId = result.insertId;

        // ── Auto-extract keywords ──
        try {
            const keywords = extractKeywordsFromDoc(extractedData);
            if (keywords.length > 0) {
                await pool.query('UPDATE general_documents SET keywords = ? WHERE id = ?', [JSON.stringify(keywords), docId]);
            }
        } catch (kwErr) {
            console.warn('[Keywords] Failed to extract keywords:', kwErr.message);
        }

        // ── Auto-generate FAQ proposals — FIRE AND FORGET (non-blocking) ──
        // Upload returns immediately. Qwen3 generation runs in background (~2-4 min).
        // Admin refreshes the Pending Proposals tab after a moment to see results.
        const _docText = (() => {
            if (extractedData?.text) return cleanDocText(extractedData.text);
            if (extractedData?.sheets) return Object.entries(extractedData.sheets)
                .map(([name, rows]) => `${name}:\n${rows.map(r => r.join('\t')).join('\n')}`)
                .join('\n\n').trim();
            return '';
        })();

        if (_docText) {
            const _aiUrl = process.env.AI_ENGINE_URL || 'http://127.0.0.1:8000';

            (async () => {
                try {
                    let pairs = [];

                    // ── Try Qwen3-powered generation (up to 5 min) ──
                    try {
                        const faqRes = await fetch(`${_aiUrl}/api/faq/generate`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ text: _docText, filename: originalName }),
                            signal: AbortSignal.timeout(300_000), // 5 min for Qwen3:9b
                        });
                        if (faqRes.ok) {
                            const faqData = await faqRes.json();
                            if (faqData.success && Array.isArray(faqData.pairs) && faqData.pairs.length > 0) {
                                pairs = faqData.pairs;
                                console.log(`[Auto-FAQ] Qwen3 generated ${pairs.length} pairs for '${originalName}'.`);
                            }
                        }
                    } catch (llmErr) {
                        console.warn('[Auto-FAQ] LLM unavailable, falling back to rule-based:', llmErr.message);
                    }

                    // ── Rule-based fallback ──
                    if (pairs.length === 0) {
                        const chunks = chunkText(_docText);
                        for (const chunk of chunks.slice(0, 30)) {
                            const { label, topic } = inferLabel(chunk);
                            pairs.push({ question: makeQuestion(topic, chunk), answer: chunk, confidence: 5, section: label });
                        }
                        console.log(`[Auto-FAQ] Rule-based fallback: ${pairs.length} proposals for '${originalName}'.`);
                    }

                    // ── Store proposals + auto-approve high-confidence ones ──
                    const conn = await pool.getConnection();
                    try {
                        let autoApproved = 0;
                        for (const pair of pairs) {
                            const confidence = Number(pair.confidence ?? 5);
                            const status = confidence >= 8 ? 'approved' : 'pending';

                            await conn.query(
                                `INSERT INTO pending_faqs (doc_id, doc_name, section, question, answer, status, confidence_score)
                                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                                [docId, originalName, pair.section || '', pair.question, pair.answer, status, confidence]
                            );

                            if (status === 'approved') {
                                const [ex] = await conn.query(
                                    'SELECT id FROM faq_entries WHERE LOWER(TRIM(question)) = LOWER(TRIM(?)) LIMIT 1',
                                    [pair.question]
                                );
                                if (ex.length === 0) {
                                    await conn.query(
                                        'INSERT INTO faq_entries (question, answer, section, doc_id, doc_name) VALUES (?, ?, ?, ?, ?)',
                                        [pair.question, pair.answer, pair.section || '', docId, originalName]
                                    );
                                }
                                // Push each auto-approved FAQ to AI Engine cache
                                fetch(`${_aiUrl}/api/faq`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ question: pair.question, answer: pair.answer, section: pair.section || null }),
                                    signal: AbortSignal.timeout(5000),
                                }).catch(() => {});
                                autoApproved++;
                            }
                        }
                        console.log(`[Auto-FAQ] '${originalName}': ${autoApproved} auto-approved, ${pairs.length - autoApproved} pending review.`);
                    } finally {
                        conn.release();
                    }
                } catch (err) {
                    console.warn('[Auto-FAQ] Background generation failed:', err.message);
                }
            })(); // fire and forget — no await
        }

        // ── Forward extracted text to AI Engine RAG pipeline (non-blocking) ──
        const rawText = extractedData.text
            ? cleanDocText(extractedData.text)
            : (extractedData.sheets ? JSON.stringify(extractedData.sheets) : '');

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
                id: docId,
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
