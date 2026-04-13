Testing the LLM Service
Based on your diagram, the LLM Service acts as a centralized gateway (:8003) that both Engine 1 and Engine 2 use to communicate with the local Ollama instance (:11434) or the Gemini API fallback.

Here is how you can run and test this LLM Service on your desktop server to achieve that architecture.

1. Set Up and Run the LLM Service
Open your terminal and navigate to the project directory:

bash
cd /Users/imziiy/Desktop/2026/LLM-Service
Create a virtual environment, install the dependencies, and start the service:

bash
# 1. Create a virtual environment
python3 -m venv venv
# 2. Activate it
source venv/bin/activate
# 3. Install requirements
pip install -r requirements.txt
# 4. Run the LLM Service on port 8003
uvicorn app.main:app --host 0.0.0.0 --port 8003 --reload
You should see output indicating that the service is running on http://0.0.0.0:8003 and checking if Ollama is available.

2. Test the Health Endpoint
To verify the service is running and can see your providers (Ollama & Gemini), open a new terminal window and run:

bash
curl http://localhost:8003/api/providers
Expected Output:

json
{
  "ollama_available": true,
  "gemini_available": false
}
(If Ollama is running on port 11434, it will return true)

3. Test the Generate Endpoint
To test the actual LLM gateway just like Engine1 and Engine2 would, send a POST request to /api/generate:

bash
curl -X POST http://localhost:8003/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Explain the importance of a centralized LLM gateway in 2 sentences.",
    "system_prompt": "You are a helpful AI architect.",
    "provider": "ollama"
  }'
Expected Output:

json
{
  "response": "A centralized LLM gateway simplifies architecture by giving all client applications a single, unified API to interact with..."
  "provider_used": "ollama",
  "model_used": "llama3",
  "elapsed_ms": 1420
}
4. Integrating with Engine 1 & Engine 2
Once this service is running on :8003, you simply need to configure your Engine 1 (:8001) and Engine 2 (:8002) projects to point their LLM requests to http://localhost:8003/api/generate instead of calling Ollama or Gemini directly. The LLM Service will automatically handle the routing and fallbacks!