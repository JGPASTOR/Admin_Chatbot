

CREATE DATABASE IF NOT EXISTS `documenttracker`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE `documenttracker`;

CREATE TABLE IF NOT EXISTS `documents` (
  `id`                        INT            NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `slug`                      VARCHAR(300)   DEFAULT NULL UNIQUE,
  `title`                     VARCHAR(255)   DEFAULT NULL,
  `agency`                    VARCHAR(255)   DEFAULT NULL,
  `office`                    VARCHAR(255)   DEFAULT NULL,
  `subject`                   TEXT           DEFAULT NULL,
  `file_type`                 VARCHAR(50)    DEFAULT 'n/a',
  `is_public`                 TINYINT(1)     DEFAULT 1,
  `created_at`                VARCHAR(50)    DEFAULT NULL,
  `created_by`                VARCHAR(100)   DEFAULT NULL,
  `validated_at`              VARCHAR(100)   DEFAULT NULL,
  `validated_by`              VARCHAR(100)   DEFAULT NULL,
  `document_type`             VARCHAR(100)   DEFAULT NULL,
  `user_retention`            VARCHAR(200)   DEFAULT NULL,
  `office_retention`          VARCHAR(200)   DEFAULT NULL,
  `overall_days_onprocess`    VARCHAR(200)   DEFAULT NULL,
  `document_completed_status` TINYINT(1)     DEFAULT 0,

  `details`                   JSON           DEFAULT NULL,
  `created_timestamp`         DATETIME       DEFAULT CURRENT_TIMESTAMP,
  `updated_timestamp`         DATETIME       DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `offices` (
  `id`   INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `code` VARCHAR(20)  DEFAULT NULL UNIQUE,
  `name` VARCHAR(255) DEFAULT NULL,
  `head` VARCHAR(100) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `general_documents` (
  `id`             INT            NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `filename`       VARCHAR(255)   NOT NULL,
  `original_name`  VARCHAR(255)   NOT NULL,
  `file_type`      VARCHAR(20)    NOT NULL,
  `file_size`      INT            DEFAULT 0,
  `file_path`      VARCHAR(500)   DEFAULT NULL,
  `extracted_data` JSON           DEFAULT NULL,
  `created_at`     DATETIME       DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME       DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `faq_entries` (
  `id`         INT            NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `question`   TEXT           NOT NULL,
  `answer`     TEXT           NOT NULL,
  `section`    VARCHAR(100)   DEFAULT NULL,
  `doc_id`     INT            DEFAULT NULL,
  `doc_name`   VARCHAR(255)   DEFAULT NULL,
  `created_at` DATETIME       DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME       DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- keywords column for general_documents (added after initial schema)
ALTER TABLE `general_documents`
  ADD COLUMN IF NOT EXISTS `keywords` JSON DEFAULT NULL;

CREATE TABLE IF NOT EXISTS `pending_faqs` (
  `id`               INT            NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `doc_id`           INT            DEFAULT NULL,
  `doc_name`         VARCHAR(255)   DEFAULT NULL,
  `section`          VARCHAR(100)   DEFAULT NULL,
  `question`         TEXT           NOT NULL,
  `answer`           TEXT           NOT NULL,
  `status`           ENUM('pending','approved','rejected') DEFAULT 'pending',
  `confidence_score` TINYINT        DEFAULT 0,   -- 1-10 from LLM; 0 = rule-based fallback
  `created_at`       DATETIME       DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME       DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
