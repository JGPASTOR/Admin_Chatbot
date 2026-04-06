"""
DTS API client for fetching document status.

Supports mock mode (built-in sample data) and live mode (HTTP calls to DTS backend).
Parses the real DTS API response format into a flat, AI-friendly structure.
"""

import json
import logging
import os
import httpx
from typing import Optional, Dict, Any, List
from app.config import settings

logger = logging.getLogger(__name__)


def parse_dts_document(raw: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Parse a raw DTS API response into a flat, AI-friendly dict.

    Extracts key info from the deeply nested DTS JSON structure:
    - Document metadata (PDID, title, office, agency)
    - Current location (last office in route)
    - Current holder and action
    - Processing timeline
    - Route summary (list of offices visited)

    Args:
        raw: The raw JSON response from the DTS API (the 'data' field)

    Returns:
        Flat dict with extracted document info, or None if parsing fails.
    """
    if not raw:
        return None

    # Handle two possible response formats:
    # 1. Wrapped: { "success": true, "data": { "pdid": ..., ... } }  ← documents.json / mock format
    # 2. Root-level: { "id": ..., "title": ..., ... }               ← live DTS API format
    if "data" in raw and isinstance(raw["data"], dict):
        data = raw["data"]
    elif "id" in raw or "pdid" in raw:
        data = raw  # already at root level
    else:
        return None

    try:
        # --- Basic metadata ---
        # Live API uses "id", mock/wrapped format uses "pdid"
        pdid = str(data.get("pdid") or data.get("id", "N/A"))
        title = data.get("title", "N/A")
        agency = data.get("agency", "N/A")
        origin_office = data.get("office", "N/A")
        subject = data.get("subject", "")
        created_at = data.get("created_at", "N/A")
        created_by = data.get("created_by", "N/A")
        is_completed = data.get("document_completed_status", False)
        total_time = data.get("overall_days_onprocess", "N/A")

        # --- Parse routes to find current location ---
        routes = []
        details = data.get("details")
        raw_routes = []

        if isinstance(details, list):
            # Laravel may return details as a list of route objects directly
            # or as a list with one element that has a 'routes' key
            if details:
                first = details[0]
                if isinstance(first, dict) and "routes" in first:
                    raw_routes = first.get("routes", [])
                elif isinstance(first, dict) and "office" in first:
                    # The list IS the routes (each element is a route stop)
                    raw_routes = details
        elif isinstance(details, dict):
            raw_routes = details.get("routes", [])
        elif not details:
            # Some APIs put routes directly on the root data object
            raw_routes = data.get("routes", [])

        current_office = origin_office
        current_holder = "N/A"
        current_action = "N/A"
        current_holder_photo = ""

        route_summary: List[Dict[str, str]] = []

        for route in raw_routes:
            office_name = route.get("office", "Unknown")
            # Strip the numbered prefix (e.g., "1. City Health Office" -> "City Health Office")
            clean_office = office_name
            if ". " in office_name:
                clean_office = office_name.split(". ", 1)[1]

            received_at = route.get("received_at", "N/A")
            date_out = route.get("date_out")
            age = route.get("age", "")

            # Get the last employee action at this stop
            staff_ops = route.get("staff_operation", {})
            employees = staff_ops.get("employee", []) if staff_ops else []

            last_action = "N/A"
            last_holder = "N/A"
            last_photo = ""
            last_tat = "N/A"
            if employees:
                last_emp = employees[-1]
                last_holder = last_emp.get("received_by", "N/A")
                last_action = last_emp.get("current_operation", "N/A")
                last_tat = last_emp.get("tat", "N/A")
                raw_photo = last_emp.get("received_by_photopath", "") or ""
                # Build full URL from relative photo path
                if raw_photo:
                    last_photo = f"{settings.DTS_API_BASE_URL}/{raw_photo}"

            route_summary.append({
                "office": clean_office,
                "received_at": received_at,
                "date_out": date_out if date_out else "Still here",
                "holder": last_holder,
                "holder_photo": last_photo,
                "action": last_action,
                "tat": last_tat,
            })

            # The last route is the current location
            current_office = clean_office
            current_holder = last_holder
            current_action = last_action
            current_holder_photo = last_photo

        # Determine status
        if is_completed:
            status = "Completed"
        elif raw_routes and raw_routes[-1].get("date_out") is None:
            status = "In Progress"
        else:
            status = "In Transit"

        return {
            "pdid": pdid,
            "title": title,
            "agency": agency,
            "origin_office": origin_office,
            "subject": subject,
            "created_at": created_at,
            "created_by": created_by,
            "status": status,
            "is_completed": is_completed,
            "total_time": total_time,
            "current_office": current_office,
            "current_holder": current_holder,
            "current_holder_photo": current_holder_photo,
            "current_action": current_action,
            "route_count": len(route_summary),
            "route_summary": route_summary,
        }

    except Exception as e:
        logger.error(f"Error parsing DTS document JSON: {e}")
        return None


# ---------------------------------------------------------------------------
# Mock document data for development/testing
# Uses the real DTS format structure
# ---------------------------------------------------------------------------

# Load mock data from documents.json if available, otherwise use built-in sample
def _load_mock_data() -> Dict[str, Dict[str, Any]]:
    """Load mock documents, using documents.json if available."""
    docs = {}

    # Try to load real sample data from documents.json
    json_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
        "documents.json"
    )
    if os.path.exists(json_path):
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            parsed = parse_dts_document(raw)
            if parsed:
                pdid_key = str(parsed["pdid"]).lstrip("0").zfill(3)
                docs[pdid_key] = parsed
        except (json.JSONDecodeError, IOError):
            pass

    # Built-in fallback samples (already in parsed/flat format)
    builtin = {
        "001": {
            "pdid": "001",
            "title": "Leave Application - Juan Dela Cruz",
            "agency": "City Government of Surigao",
            "origin_office": "City Human Resource Office",
            "subject": "Application for vacation leave",
            "created_at": "02/20/2026",
            "created_by": "Dela Cruz, Juan",
            "status": "In Progress",
            "is_completed": False,
            "total_time": "00 Mon/s, 05 Day/s, 02 hour/s, 30 min., & 00 sec.",
            "current_office": "City Mayor's Office",
            "current_holder": "Ranario, Michille",
            "current_action": "For Signature",
            "route_count": 3,
            "route_summary": [
                {"office": "City Human Resource Office", "received_at": "Feb 20, 2026 09:00:00 AM", "date_out": "Feb 20, 2026 10:30:00 AM", "holder": "Dela Cruz, Juan", "action": "Register document into the Document Tracking System (DTS)."},
                {"office": "City Administrator's Office", "received_at": "Feb 20, 2026 10:30:00 AM", "date_out": "Feb 22, 2026 02:00:00 PM", "holder": "Temon, Diana Rose", "action": "Bringing out the document."},
                {"office": "City Mayor's Office", "received_at": "Feb 22, 2026 02:00:00 PM", "date_out": "Still here", "holder": "Ranario, Michille", "action": "For Signature"},
            ],
        },
        "002": {
            "pdid": "002",
            "title": "Purchase Request - Office Supplies",
            "agency": "City Government of Surigao",
            "origin_office": "City Health Office",
            "subject": "Office supplies for Q1 2026",
            "created_at": "02/18/2026",
            "created_by": "Santos, Maria",
            "status": "Completed",
            "is_completed": True,
            "total_time": "00 Mon/s, 07 Day/s, 04 hour/s, 15 min., & 30 sec.",
            "current_office": "City Budget Office",
            "current_holder": "Fabio, Roberto",
            "current_action": "Released",
            "route_count": 5,
            "route_summary": [
                {"office": "City Health Office", "received_at": "Feb 18, 2026 08:00:00 AM", "date_out": "Feb 18, 2026 09:30:00 AM", "holder": "Tinio, Bryant", "action": "Register document into the Document Tracking System (DTS)."},
                {"office": "City Mayor's Office", "received_at": "Feb 18, 2026 09:30:00 AM", "date_out": "Feb 19, 2026 11:00:00 AM", "holder": "Ranario, Michille", "action": "Purchase Request"},
                {"office": "City Health Office", "received_at": "Feb 19, 2026 11:00:00 AM", "date_out": "Feb 20, 2026 03:00:00 PM", "holder": "Kong, Florcita", "action": "Validate"},
                {"office": "Bids and Awards Committee", "received_at": "Feb 20, 2026 03:00:00 PM", "date_out": "Feb 23, 2026 10:00:00 AM", "holder": "Azarcon, Rowena", "action": "For Rfq"},
                {"office": "City Budget Office", "received_at": "Feb 23, 2026 10:00:00 AM", "date_out": "Feb 25, 2026 12:15:00 PM", "holder": "Fabio, Roberto", "action": "Released"},
            ],
        },
        "003": {
            "pdid": "003",
            "title": "Travel Order - Conference Attendance",
            "agency": "City Government of Surigao",
            "origin_office": "City Administrator's Office",
            "subject": "Travel order for national conference",
            "created_at": "02/22/2026",
            "created_by": "Reyes, Pedro",
            "status": "In Progress",
            "is_completed": False,
            "total_time": "00 Mon/s, 03 Day/s, 01 hour/s, 45 min., & 20 sec.",
            "current_office": "City Administrator's Office",
            "current_holder": "Temon, Diana Rose",
            "current_action": "For Signature",
            "route_count": 2,
            "route_summary": [
                {"office": "City Administrator's Office", "received_at": "Feb 22, 2026 10:00:00 AM", "date_out": "Feb 22, 2026 11:00:00 AM", "holder": "Reyes, Pedro", "action": "Register document into the Document Tracking System (DTS)."},
                {"office": "City Administrator's Office", "received_at": "Feb 22, 2026 11:00:00 AM", "date_out": "Still here", "holder": "Temon, Diana Rose", "action": "For Signature"},
            ],
        },
    }

    # Merge: real data from documents.json takes priority
    for k, v in builtin.items():
        if k not in docs:
            docs[k] = v

    return docs


MOCK_DOCUMENTS = _load_mock_data()


async def get_document(pdid: str) -> Optional[Dict[str, Any]]:
    """
    Fetch document info by PDID.

    In mock mode: returns from built-in sample data.
    In live mode: calls DTS backend API and parses the response.

    Args:
        pdid: The document PDID (e.g., "001", "1000")

    Returns:
        Parsed document info dict or None if not found.
    """
    # Normalize PDID
    pdid_clean = pdid.strip().lstrip("0") or "0"
    pdid_key = pdid_clean.zfill(3)

    if settings.DTS_MOCK_MODE:
        # Try both the zero-padded key and the raw number
        return MOCK_DOCUMENTS.get(pdid_key) or MOCK_DOCUMENTS.get(pdid_clean)

    # Live mode: call DTS backend
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            url = f"{settings.DTS_API_BASE_URL}/api/documents/{pdid_clean}"
            response = await client.get(url)

            if response.status_code == 200:
                raw = response.json()
                parsed = parse_dts_document(raw)
                return parsed
            elif response.status_code == 404:
                return None
            else:
                response.raise_for_status()
    except httpx.HTTPError as e:
        logger.error(f"DTS API request failed for PDID {pdid_clean}: {e}")
        return None

    return None
