import os
import time
import logging
import re
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

from langchain_community.document_loaders import TextLoader, PyPDFLoader, UnstructuredWordDocumentLoader
from langchain_community.document_loaders.unstructured import UnstructuredFileLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_huggingface import HuggingFaceEmbeddings
import chromadb

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Constants
# We use the existing chroma host and port used by the system if any, or default
CHROMA_HOST = os.environ.get("CHROMA_HOST", "localhost")
CHROMA_PORT = int(os.environ.get("CHROMA_PORT", "8100"))
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "uploads")
COLLECTION_NAME = "rag_documents"

class IngestionPipeline:
    def __init__(self):
        logger.info(f"Connecting to ChromaDB at {CHROMA_HOST}:{CHROMA_PORT}")
        self.chroma_client = chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)
        
        # HuggingFace Embeddings initialization
        logger.info("Initializing HuggingFace Embeddings (all-MiniLM-L6-v2)")
        self.embeddings = HuggingFaceEmbeddings(model_name="all-MiniLM-L6-v2")
        
        self.collection = self.chroma_client.get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"}
        )
        
        # Setup Text Splitter (Chunking)
        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=500,
            chunk_overlap=100,
            separators=["\n\n", "\n", " ", ""]
        )

    def clean_text(self, text: str) -> str:
        """Cleans data: Removes weird formatting or images."""
        # Remove decorative separator lines
        text = re.sub(r'([═=\-_*~─━▬])\1{2,}', '', text)
        # Remove empty lines
        text = re.sub(r'\n{3,}', '\n\n', text)
        return text.strip()

    def process_document(self, filepath: str):
        """Processes a single document: clean -> chunk -> embed."""
        try:
            logger.info(f"Step 1: Loading and Cleaning Data from {filepath}")
            if filepath.endswith('.txt'):
                loader = TextLoader(filepath)
            elif filepath.endswith('.pdf'):
                loader = PyPDFLoader(filepath)
            elif filepath.endswith('.docx'):
                loader = UnstructuredWordDocumentLoader(filepath)
            else:
                loader = UnstructuredFileLoader(filepath)
            
            docs = loader.load()
            
            # Application of text cleaning on the loaded documents
            for doc in docs:
                doc.page_content = self.clean_text(doc.page_content)
                
            logger.info(f"Step 2: Chunking {len(docs)} document(s) into small readable paragraphs")
            chunks = self.text_splitter.split_documents(docs)
            
            if not chunks:
                logger.warning(f"No text chunks found in {filepath}.")
                return
            
            logger.info(f"Step 3: Embedding {len(chunks)} chunks and saving to Vector DB")
            # Extract text and metadata for direct Chroma insertion
            texts = [chunk.page_content for chunk in chunks]
            metadatas = [{"filename": os.path.basename(filepath)} for _ in chunks]
            
            # Assuming we generate deterministic IDs based on filename and index
            import hashlib
            base_hash = hashlib.md5(os.path.basename(filepath).encode()).hexdigest()[:8]
            existing_count = self.collection.count()
            ids = [f"{base_hash}_auto_{existing_count + i}" for i in range(len(chunks))]
            
            # Embeddings are natively supported by sentence-transformers via HF, 
            # but we can let Chroma do it if we hooked it up, or embed directly:
            embeds = self.embeddings.embed_documents(texts)
            
            self.collection.add(
                ids=ids,
                documents=texts,
                embeddings=embeds,
                metadatas=metadatas
            )
            
            logger.info(f"Successfully processed {os.path.basename(filepath)}! Added {len(chunks)} chunks.")
            
        except Exception as e:
            logger.error(f"Failed to process file {filepath}: {e}")

class UploadWatchdog(FileSystemEventHandler):
    def __init__(self, pipeline: IngestionPipeline):
        self.pipeline = pipeline
        self.processed_files = set()

    def on_created(self, event):
        if event.is_directory:
            return
        
        filepath = event.src_path
        filename = os.path.basename(filepath)
        
        # Avoid processing hidden or temp files
        if filename.startswith('.') or filename.startswith('~'):
            return
            
        # Give the file a moment to finish downloading/copying
        time.sleep(1)
        
        if filepath not in self.processed_files:
            logger.info(f"Watcher Event: New Upload Detected -> {filename}")
            self.processed_files.add(filepath)
            self.pipeline.process_document(filepath)

if __name__ == "__main__":
    if not os.path.exists(UPLOAD_DIR):
        logger.info(f"Creating upload directory at '{UPLOAD_DIR}'")
        os.makedirs(UPLOAD_DIR)
        
    pipeline = IngestionPipeline()
    event_handler = UploadWatchdog(pipeline)
    
    observer = Observer()
    observer.schedule(event_handler, UPLOAD_DIR, recursive=False)
    
    logger.info(f"==================================================")
    logger.info(f"The Automator (Ingestion Pipeline) is now running.")
    logger.info(f"Watching directory: {os.path.abspath(UPLOAD_DIR)}")
    logger.info(f"==================================================")
    
    observer.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        logger.info("Stopping The Automator...")
        observer.stop()
    observer.join()
