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

/** Trigger a lightweight locations sync on the AI-Engine after any add/edit/delete */
async function syncLocationsToRAG() {
    try {
        const res = await fetch(`${AI_ENGINE}/api/rag/sync-locations`, {
            method: 'POST',
            signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            console.warn(`[Locations RAG] Sync returned ${res.status}: ${body}`);
        } else {
            const data = await res.json();
            console.log(`[Locations RAG] Sync OK — ${data.total_chunks ?? 0} new chunk(s)`);
        }
    } catch (e) {
        console.warn('[Locations RAG] Sync failed (AI-Engine unreachable?):', e.message);
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

        // Fire-and-forget locations sync so the chatbot can find the new entry immediately
        syncLocationsToRAG().catch(() => {});

        return NextResponse.json({ success: true, data: loc }, { status: 201 });
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
