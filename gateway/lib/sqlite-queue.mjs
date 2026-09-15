// NIAC Live SQLite WAL Durable Ingestion Queue (Phase 3)
// Implements transactional group commits with native node:sqlite for zero-loss ingestion.

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

export class SQLiteAnswerQueue {
  constructor(dbPath = null, options = {}) {
    this.options = {
      groupCommitIntervalMs: options.groupCommitIntervalMs || 15,
      groupCommitBatchSize: options.groupCommitBatchSize || 25,
      ...options
    };

    if (!dbPath) {
      const dataDir = path.resolve(process.cwd(), 'data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      this.dbPath = path.join(dataDir, 'answer-queue.db');
    } else {
      this.dbPath = dbPath;
      if (dbPath !== ':memory:') {
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new DatabaseSync(this.dbPath);
    this._initDatabase();

    this.pendingCommits = [];
    this.commitTimer = null;
    this.isFlushing = false;
  }

  _initDatabase() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS answer_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        answer_id TEXT UNIQUE NOT NULL,
        participant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        question_id TEXT NOT NULL,
        option_index INTEGER NOT NULL,
        clue_number INTEGER,
        response_ms INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        client_submitted_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_participant_question ON answer_queue(participant_id, question_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_participant_idempotency ON answer_queue(participant_id, idempotency_key);
    `);

    const columns=new Set(this.db.prepare('PRAGMA table_info(answer_queue)').all().map(column=>column.name));
    if(!columns.has('clue_number'))this.db.exec('ALTER TABLE answer_queue ADD COLUMN clue_number INTEGER');
    if(!columns.has('response_ms'))this.db.exec('ALTER TABLE answer_queue ADD COLUMN response_ms INTEGER NOT NULL DEFAULT 0');

    this.findDuplicateStmt = this.db.prepare(`
      SELECT answer_id FROM answer_queue 
      WHERE participant_id = ? AND (question_id = ? OR idempotency_key = ?)
      LIMIT 1
    `);

    this.insertStmt = this.db.prepare(`
      INSERT INTO answer_queue (
        answer_id, participant_id, session_id, question_id,
        option_index, clue_number, response_ms, idempotency_key, client_submitted_at, received_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')
    `);

    this.getBatchStmt = this.db.prepare(`
      SELECT answer_id, participant_id, session_id, question_id, option_index, clue_number, response_ms, idempotency_key, received_at
      FROM answer_queue
      WHERE status = 'queued'
      ORDER BY id ASC
      LIMIT ?
    `);

    this.markFlushedStmt = this.db.prepare(`
      UPDATE answer_queue SET status = 'flushed' WHERE answer_id = ?
    `);

    this.queueDepthStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM answer_queue WHERE status = 'queued'
    `);

    this.totalCountStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM answer_queue
    `);
  }

  async enqueueAnswer(item) {
    const participantId = item.participantId;
    const questionId = item.questionId;
    const idempotencyKey = item.idempotencyKey;
    const answerId = item.answerId || crypto.randomUUID();
    const receivedAt = item.receivedAt || new Date().toISOString();

    // 1. Fast duplicate check against persistent database
    const existing = this.findDuplicateStmt.get(participantId, questionId, idempotencyKey);
    if (existing) {
      return {
        accepted: true,
        duplicate: true,
        answerId: existing.answer_id
      };
    }

    // 2. Fast duplicate check against currently buffered items awaiting commit
    const pendingExisting = this.pendingCommits.find(p =>
      p.item.participantId === participantId &&
      (p.item.questionId === questionId || p.item.idempotencyKey === idempotencyKey)
    );
    if (pendingExisting) {
      return {
        accepted: true,
        duplicate: true,
        answerId: pendingExisting.item.answerId
      };
    }

    const record = {
      answerId,
      participantId,
      sessionId: item.sessionId,
      questionId,
      optionIndex: Number(item.optionIndex),
      clueNumber: item.clueNumber == null ? null : Number(item.clueNumber),
      responseMs: Math.max(0,Number(item.responseMs || 0)),
      idempotencyKey,
      clientSubmittedAt: item.clientSubmittedAt || receivedAt,
      receivedAt
    };

    return new Promise((resolve, reject) => {
      this.pendingCommits.push({ item: record, resolve, reject });

      if (this.pendingCommits.length >= this.options.groupCommitBatchSize) {
        clearTimeout(this.commitTimer);
        this.commitTimer = null;
        this._flushGroupCommit();
      } else if (!this.commitTimer) {
        this.commitTimer = setTimeout(() => {
          this.commitTimer = null;
          this._flushGroupCommit();
        }, this.options.groupCommitIntervalMs);
      }
    });
  }

  _flushGroupCommit() {
    if (this.pendingCommits.length === 0 || this.isFlushing) return;
    this.isFlushing = true;

    const batch = this.pendingCommits;
    this.pendingCommits = [];

    try {
      this.db.exec('BEGIN IMMEDIATE');

      for (const entry of batch) {
        const it = entry.item;
        try {
          this.insertStmt.run(
            it.answerId,
            it.participantId,
            it.sessionId,
            it.questionId,
            it.optionIndex,
            it.clueNumber,
            it.responseMs,
            it.idempotencyKey,
            it.clientSubmittedAt,
            it.receivedAt
          );
          entry.result = {
            accepted: true,
            duplicate: false,
            answerId: it.answerId
          };
        } catch (err) {
          // If unique constraint violated during commit race, mark as duplicate
          if (String(err).includes('UNIQUE constraint failed')) {
            const dup = this.findDuplicateStmt.get(it.participantId, it.questionId, it.idempotencyKey);
            entry.result = {
              accepted: true,
              duplicate: true,
              answerId: dup ? dup.answer_id : it.answerId
            };
          } else {
            entry.error = err;
          }
        }
      }

      this.db.exec('COMMIT');

      for (const entry of batch) {
        if (entry.error) {
          entry.reject(entry.error);
        } else {
          entry.resolve(entry.result);
        }
      }
    } catch (txErr) {
      try { this.db.exec('ROLLBACK'); } catch {}
      for (const entry of batch) {
        entry.reject(txErr);
      }
    } finally {
      this.isFlushing = false;
      if (this.pendingCommits.length > 0) {
        this._flushGroupCommit();
      }
    }
  }

  getQueuedBatch(limit = 100) {
    return this.getBatchStmt.all(limit);
  }

  markFlushed(answerIds) {
    if (!answerIds || answerIds.length === 0) return 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of answerIds) {
        this.markFlushedStmt.run(id);
      }
      this.db.exec('COMMIT');
      return answerIds.length;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  }

  getQueueDepth() {
    const row = this.queueDepthStmt.get();
    return row ? Number(row.count) : 0;
  }

  getTotalCount() {
    const row = this.totalCountStmt.get();
    return row ? Number(row.count) : 0;
  }

  flushNow() {
    clearTimeout(this.commitTimer);
    this.commitTimer = null;
    this._flushGroupCommit();
  }

  close() {
    this.flushNow();
    this.db.close();
  }
}
