(function () {
  window.aiteam = window.aiteam || {};

  const timeline = {
    _cursor: 0,
    _eventSource: null,
    _generation: 0,
    _manualClose: false,
    _onEvent: null,
    _onStatus: null,
    _onReconnect: null,
    _reconnectTimer: null,
    _runId: null,
    _hasConnected: false,

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

    _emitStatus(phase, detail) {
      if (typeof this._onStatus === 'function') {
        this._onStatus(Object.assign({
          phase: phase,
          run_id: this._runId,
          cursor: this._cursor,
        }, detail || {}));
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
      this._emitStatus('reconnecting', { retry_in_ms: 2000 });
      this._reconnectTimer = setTimeout(async () => {
        this._reconnectTimer = null;
        if (this._manualClose || this._generation !== generation || !this._runId) {
          return;
        }
        if (typeof this._onReconnect === 'function') {
          this._emitStatus('catching_up');
          try {
            const result = await this._onReconnect({
              runId: this._runId,
              cursor: this._cursor,
              generation: generation,
            });
            if (result && Object.prototype.hasOwnProperty.call(result, 'cursor')) {
              this._cursor = this._normalizeCursor(result.cursor);
            }
          } catch (error) {
            this._emitStatus('error', {
              retryable: true,
              message: error && error.message ? error.message : 'catch-up failed',
            });
            this._scheduleReconnect(generation);
            return;
          }
        }
        this._open(generation);
      }, 2000);
    },

    _open(generation) {
      if (!this._runId || typeof EventSource === 'undefined') {
        return;
      }
      this._emitStatus(this._hasConnected ? 'reconnecting' : 'connecting');
      const source = new EventSource(this._streamUrl(this._runId, this._cursor));
      this._eventSource = source;
      source.onopen = () => {
        if (generation !== this._generation) {
          return;
        }
        this._hasConnected = true;
        this._emitStatus('live');
      };
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

    connect(runId, cursor, handlers) {
      this.disconnect();
      this._runId = runId ? String(runId) : '';
      this._cursor = this._normalizeCursor(cursor);
      this._onEvent = typeof handlers === 'function' ? handlers : (handlers && typeof handlers.onEvent === 'function' ? handlers.onEvent : null);
      this._onStatus = handlers && typeof handlers.onStatus === 'function' ? handlers.onStatus : null;
      this._onReconnect = handlers && typeof handlers.onReconnect === 'function' ? handlers.onReconnect : null;
      this._hasConnected = false;
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
      this._onStatus = null;
      this._onReconnect = null;
      this._runId = null;
      this._hasConnected = false;
    },

    getCurrentCursor() {
      return this._cursor;
    },

    setCurrentCursor(cursor) {
      this._cursor = this._normalizeCursor(cursor);
      return this._cursor;
    },

    handleEvent(event) {
      return this._handleTimelineEvent(event);
    },
  };

  window.aiteam.timeline = timeline;
})();
