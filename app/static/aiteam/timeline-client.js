(function () {
  window.aiteam = window.aiteam || {};

  const timeline = {
    _cursor: 0,
    _eventSource: null,
    _generation: 0,
    _manualClose: false,
    _onEvent: null,
    _reconnectTimer: null,
    _runId: null,

    _normalizeCursor(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric <= 0) {
        return 0;
      }
      return Math.floor(numeric);
    },

    _streamUrl(runId, cursor) {
      return new URL(
        `/api/team/runs/${encodeURIComponent(runId)}/stream?cursor=${this._normalizeCursor(cursor)}`,
        document.baseURI || window.location.href,
      ).href;
    },

    _clearReconnectTimer() {
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
    },

    _handleTimelineEvent(event) {
      let parsed = null;
      try {
        parsed = typeof event === 'string' ? JSON.parse(event) : JSON.parse(event.data || '{}');
      } catch (_error) {
        return null;
      }
      const nextCursor = this._normalizeCursor(parsed && parsed.event_cursor);
      if (nextCursor > this._cursor) {
        this._cursor = nextCursor;
      }
      if (this._onEvent) {
        this._onEvent(parsed);
      }
      return parsed;
    },

    _scheduleReconnect(generation) {
      if (this._manualClose || !this._runId || this._reconnectTimer) {
        return;
      }
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        if (this._manualClose || this._generation !== generation || !this._runId) {
          return;
        }
        this._open(generation);
      }, 2000);
    },

    _open(generation) {
      if (!this._runId || typeof EventSource === 'undefined') {
        return;
      }
      const source = new EventSource(this._streamUrl(this._runId, this._cursor));
      this._eventSource = source;
      source.addEventListener('timeline', (event) => {
        if (generation !== this._generation) {
          return;
        }
        this._handleTimelineEvent(event);
      });
      source.onerror = () => {
        if (generation !== this._generation) {
          return;
        }
        try {
          source.close();
        } catch (_error) {
        }
        if (this._eventSource === source) {
          this._eventSource = null;
        }
        this._scheduleReconnect(generation);
      };
    },

    connect(runId, cursor, onEvent) {
      this.disconnect();
      this._runId = runId ? String(runId) : '';
      this._cursor = this._normalizeCursor(cursor);
      this._onEvent = typeof onEvent === 'function' ? onEvent : null;
      if (!this._runId) {
        return;
      }
      this._manualClose = false;
      this._generation += 1;
      this._open(this._generation);
    },

    disconnect() {
      this._manualClose = true;
      this._clearReconnectTimer();
      if (this._eventSource) {
        try {
          this._eventSource.close();
        } catch (_error) {
        }
      }
      this._eventSource = null;
      this._onEvent = null;
      this._runId = null;
    },

    getCurrentCursor() {
      return this._cursor;
    },

    handleEvent(event) {
      return this._handleTimelineEvent(event);
    },
  };

  window.aiteam.timeline = timeline;
})();
