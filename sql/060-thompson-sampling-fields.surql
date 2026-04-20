-- Migration: Add Thompson Sampling fields to activity_template table
-- Date: 2026-04-20
-- Purpose: Enable Thompson Sampling learning by tracking execution statistics
--
-- These fields support the learning loop:
--   trace stored -> Thompson update -> improved recommendations
--
-- Usage: thompson_alpha / (thompson_alpha + thompson_beta) = expected success rate

-- Thompson Sampling parameters (Beta distribution)
DEFINE FIELD thompson_alpha ON activity_template TYPE option<number> DEFAULT 1 COMMENT 'Thompson Sampling alpha parameter (successes + 1)';
DEFINE FIELD thompson_beta ON activity_template TYPE option<number> DEFAULT 1 COMMENT 'Thompson Sampling beta parameter (failures + 1)';

-- Execution counters
DEFINE FIELD total_executions ON activity_template TYPE option<int> DEFAULT 0 COMMENT 'Total number of executions';
DEFINE FIELD successful_executions ON activity_template TYPE option<int> DEFAULT 0 COMMENT 'Number of successful executions';
DEFINE FIELD failed_executions ON activity_template TYPE option<int> DEFAULT 0 COMMENT 'Number of failed executions';

-- Last execution timestamp for recency tracking
DEFINE FIELD last_executed_at ON activity_template TYPE option<datetime> COMMENT 'Timestamp of last execution';
