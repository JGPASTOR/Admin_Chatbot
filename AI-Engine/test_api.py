import requests

url = "http://127.0.0.1:8001/api/chat"
payload = {
    "message": "hello",
    "session_id": "test",
    "language": "en"
}
response = requests.post(url, json=payload)
print(f"Status Code: {response.status_code}")
print(f"Response: {response.text}")
