import asyncio
import os
import re
import numpy as np

# Test script for ChromaDB-backed RAG — run inside the ai_engine container:
#   docker exec -it dts_ai_engine python -m app.test_rag_full

async def test():
    import chromadb

    chroma_host = os.environ.get("CHROMA_HOST", "localhost")
    chroma_port = int(os.environ.get("CHROMA_PORT", "8100"))

    client = chromadb.HttpClient(host=chroma_host, port=chroma_port)
    try:
        client.heartbeat()
        print(f"✅ Connected to ChromaDB at {chroma_host}:{chroma_port}")
    except Exception as e:
        print(f"❌ ChromaDB connection failed: {e}")
        return

    collection = client.get_or_create_collection("rag_documents")
    count = collection.count()
    print(f"📊 Collection has {count} chunks")

    if count == 0:
        print("No chunks indexed. Upload a document first.")
        return

    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer('all-MiniLM-L6-v2')

    query = 'what is section 1'
    print(f'\nQUERY: {query}')

    # 1. Embed query
    query_emb = model.encode([query], convert_to_numpy=True).tolist()

    # 2. Query ChromaDB
    results = collection.query(
        query_embeddings=query_emb,
        n_results=min(15, count),
        include=["documents", "distances", "metadatas"],
    )

    docs = results["documents"][0]
    distances = results["distances"][0]

    print('\n--- DETAILED SCORES ---')
    for i, (doc, dist) in enumerate(zip(docs, distances)):
        similarity = 1.0 - dist
        status = 'MATCH!' if 'SECTION 1' in doc.upper() else ''
        text_preview = doc[:100].replace('\n', ' ')
        print(f'Rank {i+1:3} | Score: {similarity:.4f} | {status:6} | Text: {text_preview}...')

if __name__ == '__main__':
    asyncio.run(test())
