-- Migration: vector embeddings for comments
-- Run this in your Supabase SQL editor.
--
-- Safe to run before or after the matching code deploys. The app only touches
-- comments.embedding in best-effort background steps, so until this has run,
-- ingestion and analysis keep working and the embedding step logs and skips.

-- 1. pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. The embedding column.
--
-- 1024 = the output dimension of Voyage's voyage-4 model, confirmed from a live
-- API response (not only the docs). lib/embeddings.ts pins output_dimension to
-- this same constant, so a future change to the model's default can never
-- produce vectors this column rejects. Changing it means changing both.
--
-- Nullable on purpose: null means "not embedded yet", which is exactly what the
-- backfill script and the ingestion pipeline look for.
ALTER TABLE comments ADD COLUMN IF NOT EXISTS embedding vector(1024);
