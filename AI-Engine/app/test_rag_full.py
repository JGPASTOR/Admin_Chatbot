import asyncio
import os
import re
import numpy as np
import pickle
from sklearn.metrics.pairwise import cosine_similarity

# Mock some parts since I'll run this from the HOST or outside
# Actually, I'll run this INSIDE the container via a simple script.

async def test():
    store_file = '/app/rag_store/rag_cache.pkl'
    if not os.path.exists(store_file):
        print('Store not found')
        return

    with open(store_file, 'rb') as f:
        data = pickle.load(f)
        chunks = data['chunks']
        embeddings = data['embeddings']

    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer('all-MiniLM-L6-v2')
    
    query = 'what is section 1'
    print(f'QUERY: {query}')
    
    # 1. Embed query
    query_emb = model.encode([query], convert_to_numpy=True)
    similarities = cosine_similarity(query_emb, embeddings)[0]
    
    # 3. Boost logic (copy pasted from RAG_SERVICE)
    stop_words = {'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'where', 'how', 'who', 'when', 'why', 'are', 'you', 'can', 'tell', 'about', 'status', 'document', 'documents', 'my', 'is'}
    raw_words = re.findall(r'\b[a-zA-Z0-9-]+\b', query.lower())
    keywords = [w for w in raw_words if (len(w) >= 3 or w.isdigit()) and w not in stop_words]
    
    print(f'KEYWORDS: {keywords}')
    
    for i, chunk_text in enumerate(chunks):
        chunk_lower = chunk_text.lower()
        matches = sum(1 for kw in keywords if kw in chunk_lower)
        phrase = ' '.join(keywords)
        phrase_boost = 1.0 if (len(keywords) > 1 and phrase in chunk_lower) else 0.0
        if matches > 0 or phrase_boost > 0:
            similarities[i] += (matches * 0.3) + phrase_boost

    # 4. Sort
    top_indices = np.argsort(similarities)[::-1]
    
    print('--- DETAILED SCORES ---')
    for i in top_indices[:15]:
        status = 'MATCH!' if 'SECTION 1' in chunks[i].upper() else ''
        text_preview = chunks[i][:100].replace('\n', ' ')
        print(f'Chunk {i:3} | Score: {similarities[i]:.4f} | {status:6} | Text: {text_preview}...')

if __name__ == '__main__':
    asyncio.run(test())
