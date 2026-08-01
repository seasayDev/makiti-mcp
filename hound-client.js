#!/usr/bin/env node
/**
 * Hound MCP client for Makiti.
 * Spawns the Hound MCP server (via the Hermes wrapper) as a child process
 * and speaks JSON-RPC over stdio — same protocol Hermes uses.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import pino from 'pino';

const logger = pino({ level: 'silent' });

const HOUND_WRAPPER = process.env.HOUND_WRAPPER || '/data/data/com.termux/files/home/.hermes/scripts/hound-wrapper.sh';
const REQUEST_TIMEOUT_MS = 60_000;

export class HoundClient {
  constructor(wrapperPath = HOUND_WRAPPER) {
    this.wrapperPath = wrapperPath;
    this.proc = null;
    this.rl = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.ready = false;
    this.initPromise = null;
  }

  /** Spawn hound + initialize. Safe to call multiple times. */
  async connect() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._connect();
    return this.initPromise;
  }

  async _connect() {
    logger.info({ wrapper: this.wrapperPath }, 'spawning hound');
    this.proc = spawn(this.wrapperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    this.proc.on('error', (err) => {
      logger.error({ err: err.message }, 'hound spawn error');
      this._rejectAll(err);
    });
    this.proc.on('exit', (code, signal) => {
      logger.warn({ code, signal }, 'hound exited');
      this.ready = false;
      const err = new Error(`Hound process exited (code=${code}, signal=${signal})`);
      this._rejectAll(err);
      this.initPromise = null;
    });

    // stderr → file-ish log (never stdout)
    this.proc.stderr.on('data', (d) => logger.debug({ d: d.toString().slice(0, 200) }, 'hound stderr'));

    this.rl = createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => this._onLine(line));

    await this._request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'makiti', version: '1.0.0' },
    });
    this.ready = true;
    logger.info('hound connected');
  }

  _onLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id === undefined || msg.id === null) return; // notification, ignore
    const entry = this.pending.get(String(msg.id));
    if (!entry) return;
    this.pending.delete(String(msg.id));
    clearTimeout(entry.timer);
    if (msg.error) {
      entry.reject(new Error(msg.error.message || 'Hound JSON-RPC error'));
    } else {
      entry.resolve(msg.result);
    }
  }

  _request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Hound request '${method}' timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(String(id), { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  _rejectAll(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  /** Call a Hound tool; resolves with structuredContent (object) if present, else raw result. */
  async callTool(name, args = {}) {
    if (!this.ready) await this.connect();
    const result = await this._request('tools/call', { name, arguments: args });
    if (result?.structuredContent !== undefined && result.structuredContent !== null) {
      return result.structuredContent;
    }
    // Fallback: parse text content
    if (result?.content) {
      for (const block of result.content) {
        if (block.type === 'text') {
          try { return JSON.parse(block.text); } catch { /* keep looking */ }
        }
      }
    }
    return result;
  }

  /** smart_search → array of {title,url,snippet,relevance_score,...} */
  async search(query, opts = {}) {
    const sc = await this.callTool('mcp_smart_search', {
      query,
      options: {
        max_results: opts.max_results ?? 8,
        engines: opts.engines ?? ['google', 'brave', 'duckduckgo', 'yahoo'],
        ...(opts.freshness ? { freshness: opts.freshness } : {}),
        ...(opts.site ? { site: opts.site } : {}),
      },
    });
    return sc?.results || [];
  }

  /** smart_fetch → extracted page content */
  async fetch(url, opts = {}) {
    return this.callTool('mcp_smart_fetch', { url, ...opts });
  }

  async close() {
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill(); } catch { /* ignore */ }
    }
    this.ready = false;
    this.initPromise = null;
  }
}
