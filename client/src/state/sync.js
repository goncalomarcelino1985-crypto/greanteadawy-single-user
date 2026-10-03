// WebSocket live sync with the server. Ops are applied optimistically on the client,
// sent to the server, and broadcast to other clients. Claude's MCP edits arrive here too.
import { uid, applyOps } from '@greanteadawy/core';
import { api } from './api.js';
import { runJob } from '../lib/jobs.js';

class Sync {
  constructor() {
    this.ws = null;
    this.store = null;
    this.clientId = uid('client');
    this.projectId = null;
    this.outbox = []; // { opId, projectId, ops } not yet acknowledged
    this.rev = 0; // last server revision we know about
    this.dirty = false; // remote ops interleaved with our pending ops -> resync once the outbox drains
    this.retry = 0;
    this.closedByUser = false;
  }

  /** Connect for the signed-in user (called after login). */
  start(store) {
    this.store = store;
    this.closedByUser = false;
    this.projectId = null;
    this.outbox = [];
    this.rev = 0;
    this.dirty = false;
    if (this.ws && this.ws.readyState <= 1) return;
    this.connect();
  }

  /** Disconnect (logout). */
  stop() {
    this.closedByUser = true;
    clearTimeout(this.retryTimer);
    if (this.ws) {
      try { this.ws.close(1000, 'logout'); } catch { /* ignore */ }
    }
    this.ws = null;
    this.projectId = null;
    this.outbox = [];
  }

  get state() {
    return this.store.getState();
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.store.setState({ connected: true });
      this.send({ type: 'hello', clientId: this.clientId });
      if (this.projectId) this.send({ type: 'subscribe', projectId: this.projectId });
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.store.setState({ connected: false });
      if (this.closedByUser) return;
      if (ev.code === 4401) {
        this.store.getState().authLost();
        return;
      }
      const delay = Math.min(8000, 500 * 2 ** this.retry++);
      this.retryTimer = setTimeout(() => {
        // the upgrade is refused (no close code) when the session expired: check before retrying
        api.authStatus().then((st) => {
          if (!st.user) this.store.getState().authLost();
          else if (!this.closedByUser) this.connect();
        }).catch(() => { if (!this.closedByUser) this.connect(); });
      }, delay);
    };
    ws.onerror = () => { /* onclose handles reconnect */ };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this.onMessage(msg);
    };
  }

  send(msg) {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  subscribe(projectId) {
    this.projectId = projectId;
    this.outbox = [];
    this.dirty = false;
    this.send({ type: 'subscribe', projectId });
  }

  resync() {
    this.dirty = false;
    this.send({ type: 'resync' });
  }

  /** The project we're on (or about to open) no longer exists: open another one, or start a new one. */
  async recoverMissingProject(missingId) {
    if (this.recovering) return;
    this.recovering = true;
    try {
      this.outbox = this.outbox.filter((o) => o.projectId !== missingId);
      const list = await api.listProjects().catch(() => null);
      const st = this.state;
      if (list) this.store.setState({ projects: list });
      const next = list?.find((p) => p.id !== missingId);
      if (next) {
        st.toast(`That project was deleted — opened "${next.name}"`, 'info');
        st.openProject(next.id);
      } else if (list) {
        // the server makes sure every user has a project; reconnecting picks it up
        this.ws?.close();
      }
    } finally {
      this.recovering = false;
    }
  }

  /** Called when the outbox may have drained. */
  settle() {
    if (!this.outbox.length && this.dirty) this.resync();
  }

  /** coalesce: the local undo-grouping key, so other tabs can group the same gesture into one undo step too. */
  sendOps(projectId, ops, coalesce = null) {
    const opId = uid('op');
    this.outbox.push({ opId, projectId, ops, coalesce });
    this.send({ type: 'ops', projectId, ops, opId, ...(coalesce ? { coalesce } : {}) });
  }

  onMessage(msg) {
    const st = this.state;
    switch (msg.type) {
      case 'welcome': {
        if (msg.activity?.length) this.store.setState({ activity: msg.activity.slice().reverse() });
        st.refreshProjects();
        st.refreshSamples();
        // the server guarantees an active project (it creates a starter project for new users)
        if (!this.projectId && msg.activeProjectId) this.subscribe(msg.activeProjectId);
        break;
      }
      case 'project': {
        // fresh authoritative state; re-apply (and re-send) anything not yet acknowledged.
        // The server de-duplicates by opId and add-ops are idempotent, so re-sending is safe.
        let project = msg.project;
        const pending = this.outbox.filter((o) => o.projectId === project.id);
        this.outbox = pending;
        if (pending.length) {
          try {
            for (const o of pending) project = applyOps(project, o.ops);
          } catch { /* keep server state */ }
          for (const o of pending) this.send({ type: 'ops', projectId: o.projectId, ops: o.ops, opId: o.opId, ...(o.coalesce ? { coalesce: o.coalesce } : {}) });
          this.dirty = true;
        }
        this.projectId = project.id;
        this.rev = msg.project.rev || 0;
        st.setProjectFromServer(project);
        break;
      }
      case 'ack':
        this.outbox = this.outbox.filter((o) => o.opId !== msg.opId);
        if (typeof msg.rev === 'number') this.rev = Math.max(this.rev, msg.rev);
        this.settle();
        break;
      case 'reject': {
        this.outbox = this.outbox.filter((o) => o.opId !== msg.opId);
        if (msg.gone) {
          this.recoverMissingProject(this.projectId);
          break;
        }
        st.toast(`Edit rejected: ${msg.message}`, 'error');
        if (msg.project) {
          // server state at the time of the rejection + our later edits that are still queued there
          let project = msg.project;
          for (const o of this.outbox) {
            try { project = applyOps(project, o.ops); } catch { /* the server will reject it too */ }
          }
          this.rev = msg.project.rev || this.rev;
          st.setProjectFromServer(project);
        }
        this.settle();
        break;
      }
      case 'ops':
        if (msg.projectId !== st.project?.id) break;
        if (this.outbox.length) this.dirty = true; // ordering vs. our in-flight ops is unknown
        else if (typeof msg.rev === 'number' && this.rev && msg.rev !== this.rev + 1) this.dirty = true; // missed something
        if (typeof msg.rev === 'number') this.rev = Math.max(this.rev, msg.rev);
        st.applyRemote(msg.ops, msg.source, msg.coalesce || null);
        this.settle();
        break;
      case 'activity': {
        const item = { source: msg.source, text: msg.text, time: msg.time, projectId: msg.projectId };
        const exported = /^(Rendered|Exported)/.test(msg.text || '');
        this.store.setState((s) => ({ activity: [item, ...s.activity].slice(0, 100), ...(exported ? { exportsRev: s.exportsRev + 1 } : {}) }));
        break;
      }
      case 'job':
        runJob(msg.jobId, msg.job, this);
        break;
      case 'transport': {
        if (msg.action === 'audition') {
          st.audition(msg.channelId, msg.key, msg.velocity, msg.duration);
          break;
        }
        if (msg.action === 'play') {
          st.play({ mode: msg.mode, patternId: msg.patternId, position: msg.position || 0 });
          st.toast(`Claude pressed play (${msg.mode} mode)`, 'claude');
        } else if (msg.action === 'stop') {
          st.stop();
        }
        break;
      }
      case 'open':
        if (msg.projectId !== st.project?.id) {
          st.refreshProjects();
          if (st.followClaude) {
            st.openProject(msg.projectId);
            st.toast('Claude opened a project', 'claude');
          } else {
            st.toast('Claude created/opened another project (see Projects)', 'claude');
          }
        }
        break;
      case 'projects-changed':
        st.refreshProjects().then(() => {
          const s = this.state;
          if (s.project && !s.projects.some((p) => p.id === s.project.id)) this.recoverMissingProject(s.project.id);
        });
        break;
      case 'samples-changed':
        st.refreshSamples();
        break;
      case 'plugins-changed':
        st.loadPlugins();
        break;
      case 'versions-changed':
        if (msg.projectId === st.project?.id) this.store.setState((s) => ({ versionsRev: (s.versionsRev || 0) + 1 }));
        break;
      case 'error':
        if (msg.request === 'subscribe' && msg.status === 404) {
          this.recoverMissingProject(this.projectId);
          break;
        }
        if (msg.message) st.toast(msg.message, 'error');
        break;
      default:
    }
  }
}

export const sync = new Sync();
