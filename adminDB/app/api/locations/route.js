import pool from '../../../lib/db';
import { NextResponse } from 'next/server';

const AI_ENGINE = process.env.AI_ENGINE_URL || 'http://192.168.254.110:8000';

/** Build a rich text blob from a location row — used for RAG ingestion */
function locationToText(loc) {
    const lines = [];
    const catLabel = {
        restaurant: 'Restaurant',
        shop: 'Shop / Store',
        tourist_spot: 'Tourist Spot',
        hotel: 'Hotel / Accommodation',
        hospital: 'Hospital / Clinic',
        government: 'Government Office',
        school: 'School / University',
        other: 'Place of Interest',
    }[loc.category] ?? 'Place';

    lines.push(`${catLabel}: ${loc.name}`);
    if (loc.category) lines.push(`Type: ${catLabel}`);
    if (loc.address) lines.push(`Address: ${loc.address}`);
    if (loc.description) lines.push(`About: ${loc.description}`);
    if (loc.contact) lines.push(`Contact: ${loc.contact}`);
    if (loc.operating_hours) lines.push(`Operating Hours: ${loc.operating_hours}`);
    if (loc.latitude && loc.longitude)
        lines.push(`Coordinates: ${loc.latitude}, ${loc.longitude}`);
    if (loc.google_maps_url)
        lines.push(`Map: ${loc.google_maps_url}`);

    return lines.join('\n');
}

/** Push location text into RAG via AI-Engine */
async function ingestToRAG(loc) {
    const text = locationToText(loc);
    const filename = `location_${loc.id}_${loc.name.replace(/\s+/g, '_')}`;
    try {
        const res = await fetch(`${AI_ENGINE}/api/rag/ingest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, text }),
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) console.warn('[Locations RAG] Ingest returned', res.status);
        else {
            const data = await res.json();
            console.log(`[Locations RAG] Ingested '${loc.name}' — ${data.chunks_added ?? '?'} chunks`);
        }
    } catch (e) {
        console.warn('[Locations RAG] Ingest failed:', e.message);
    }
}

/* ── GET /api/locations ── */
export async function GET() {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM locations ORDER BY category, name'
        );
        return NextResponse.json({ success: true, data: rows });
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}

/* ── POST /api/locations ── */
export async function POST(request) {
    try {
        const body = await request.json();
        const {
            name, category = 'shop', description, address,
            latitude, longitude, contact, operating_hours, google_maps_url,
        } = body;

        if (!name?.trim()) {
            return NextResponse.json({ success: false, error: 'Name is required.' }, { status: 400 });
        }

        const [result] = await pool.query(
            `INSERT INTO locations
             (name, category, description, address, latitude, longitude, contact, operating_hours, google_maps_url)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                name.trim(), category, description || null, address || null,
                latitude || null, longitude || null,
                contact || null, operating_hours || null, google_maps_url || null,
            ]
        );

        const insertedId = result.insertId;

        // Fetch full row so we can build the RAG text
        const [rows] = await pool.query('SELECT * FROM locations WHERE id = ?', [insertedId]);
        const loc = rows[0];

        // Fire-and-forget RAG ingestion
        ingestToRAG(loc).catch(() => {});

        return NextResponse.json({ success: true, data: loc }, { status: 201 });
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
