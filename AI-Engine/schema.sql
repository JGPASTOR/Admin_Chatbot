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
    timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_session_id (session_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Intent training data (for retraining the classifier)
CREATE TABLE IF NOT EXISTS training_data (
    id INT AUTO_INCREMENT PRIMARY KEY,
    text TEXT NOT NULL,
    intent VARCHAR(50) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_intent (intent)
) ENGINE=InnoDB;
