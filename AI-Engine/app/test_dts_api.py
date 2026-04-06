import asyncio
import httpx
import json

async def fetch_document():
    url = "http://192.168.168.214:8000/api/documents/1000"  # Guessing Laravel runs on 8000
    print(f"Fetching {url}...")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(url)
            print(f"Status Code: {response.status_code}")
            try:
                data = response.json()
                print("JSON Response:")
                print(json.dumps(data, indent=2))
            except Exception as e:
                print(f"Response is not JSON: {response.text}")
    except Exception as e:
        print(f"Connection error: {e}")

asyncio.run(fetch_document())
