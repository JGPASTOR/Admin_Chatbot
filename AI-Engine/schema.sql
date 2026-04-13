-- DTS AI Engine Database Schema
-- Run: mysql -u root -p < schema.sql

CREATE DATABASE IF NOT EXISTS dts_ai_engine
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE dts_ai_engine;

-- Conversation sessions for multi-turn context
CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(36) PRIMARY KEY,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_active DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    context JSON NOT NULL DEFAULT ('{}')
) ENGINE=InnoDB;

-- Chat message logs
CREATE TABLE IF NOT EXISTS chat_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    session_id VARCHAR(36) NOT NULL,
    role VARCHAR(10) NOT NULL COMMENT '"user" or "bot"',
    message TEXT NOT NULL,
    intent VARCHAR(50) DEFAULT NULL,
    confidence FLOAT DEFAULT NULL,
    entities JSON DEFAULT NULL,
    -- Phase-1 observability: which layer answered and how fast
    response_source ENUM('faq_cache','rag_template','llm') DEFAULT NULL COMMENT 'Layer that produced the bot reply',
    response_ms INT DEFAULT NULL COMMENT 'Wall-clock response time in milliseconds',
    timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_session_id (session_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── Migration: apply to existing databases ────────────────────────────────────
-- Run these ALTER statements once on any database created before Phase-1:
-- ALTER TABLE chat_logs ADD COLUMN response_source ENUM('faq_cache','rag_template','llm') DEFAULT NULL AFTER intent;
-- ALTER TABLE chat_logs ADD COLUMN response_ms INT DEFAULT NULL AFTER response_source;

-- Intent training data (for retraining the classifier)
CREATE TABLE IF NOT EXISTS training_data (
    id INT AUTO_INCREMENT PRIMARY KEY,
    text TEXT NOT NULL,
    intent VARCHAR(50) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_intent (intent)
) ENGINE=InnoDB;

-- Flagged queries — questions the bot couldn't confidently answer
-- Admin reviews these and provides answers to feed back into the FAQ system
CREATE TABLE IF NOT EXISTS flagged_queries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    question TEXT NOT NULL,
    session_id VARCHAR(36) DEFAULT NULL,
    confidence FLOAT DEFAULT 0,
    topic VARCHAR(20) DEFAULT NULL,
    asked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status ENUM('pending', 'resolved', 'dismissed') DEFAULT 'pending',
    admin_answer TEXT DEFAULT NULL,
    resolved_at DATETIME DEFAULT NULL,
    INDEX idx_status (status)
) ENGINE=InnoDB;

-- ── Phase 2: Quality Layer ─────────────────────────────────────────────────────

-- Store each document chunk as its own row with full metadata.
-- Allows per-chunk re-embedding, deletion, or targeted FAQ re-generation
-- without reprocessing the full parent document.
CREATE TABLE IF NOT EXISTS document_chunks (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    doc_id        INT NOT NULL,
    doc_name      VARCHAR(255),
    chunk_index   INT NOT NULL,          -- order within document
    chunk_text    TEXT NOT NULL,
    section_label VARCHAR(255),          -- e.g. "Section 3 — Eligibility"
    page_number   INT,                   -- if available from PDF
    char_count    INT,
    created_at    DATETIME DEFAULT NOW(),
    UNIQUE KEY uq_doc_chunk (doc_id, chunk_index),
    INDEX idx_doc_id (doc_id),
    INDEX idx_section (section_label)
) ENGINE=InnoDB;

-- Queue table that drives background batch FAQ generation.
-- After upload, one row per chunk is inserted with status='pending'.
-- Worker endpoint /api/faq/process-queue picks up batches and stores results.
CREATE TABLE IF NOT EXISTS faq_generation_queue (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    doc_id       INT NOT NULL,
    doc_name     VARCHAR(255),
    chunk_index  INT NOT NULL,
    chunk_text   TEXT NOT NULL,
    section      VARCHAR(255),
    status       ENUM('pending', 'processing', 'done', 'failed') DEFAULT 'pending',
    retry_count  INT DEFAULT 0,
    created_at   DATETIME DEFAULT NOW(),
    processed_at DATETIME,
    INDEX idx_status (status),
    INDEX idx_doc_id (doc_id)
) ENGINE=InnoDB;

-- Curated Q&A pairs (source of truth for bot answers — checked before RAG).
CREATE TABLE IF NOT EXISTS faq_entries (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    question   TEXT NOT NULL,
    answer     TEXT NOT NULL,
    section    VARCHAR(100) DEFAULT NULL,
    created_at DATETIME DEFAULT NOW(),
    updated_at DATETIME DEFAULT NOW() ON UPDATE NOW(),
    INDEX idx_section (section)
) ENGINE=InnoDB;



-- Immutable audit log for every FAQ mutation.
-- change_type: created | edited | approved | rejected | deleted
-- changed_by:  'admin' | 'ai-auto' | 'ai-judge'
CREATE TABLE IF NOT EXISTS faq_history (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    faq_id      INT NOT NULL,
    question    TEXT NOT NULL,
    answer      TEXT NOT NULL,
    changed_by  VARCHAR(100),
    change_type ENUM('created', 'edited', 'approved', 'rejected', 'deleted') NOT NULL,
    changed_at  DATETIME DEFAULT NOW(),
    FOREIGN KEY (faq_id) REFERENCES faq_entries(id) ON DELETE CASCADE,
    INDEX idx_faq_id (faq_id)
) ENGINE=InnoDB;

-- ── Migration: apply to existing databases ────────────────────────────────────
-- Run these once if upgrading from a schema created before Phase-2:
-- (The CREATE TABLE IF NOT EXISTS statements above are safe to re-run)

-- ── Phase 4: Closed-Loop ────────────────────────────────────────────────────────

-- Pre-embedded common queries for instant RAG template responses
CREATE TABLE IF NOT EXISTS query_cache_warmup (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  query_text      TEXT NOT NULL,
  query_hash      VARCHAR(64) UNIQUE NOT NULL,
  rag_context     JSON DEFAULT NULL,
  hit_count       INT DEFAULT 0,
  last_refreshed  DATETIME DEFAULT NOW(),
  INDEX idx_hash (query_hash)
) ENGINE=InnoDB;
