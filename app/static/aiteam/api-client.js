window.aiteam = window.aiteam || {};

(function registerTeamPanelClient(ns) {
  function buildJsonHeaders(extraHeaders) {
    const headers = new Headers(extraHeaders || {});
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    return headers;
  }

  function buildResult(res, data) {
    const error = res.ok ? null : ((data && data.error) || res.statusText || 'Request failed');
    return {
      ok: res.ok,
      status: res.status,
      data,
      error,
    };
  }

  ns.api = {
    BASE: '/api/team',

    _buildUrl(path) {
      const requestPath = String(path || '');
      if (requestPath.indexOf('/api/') === 0) {
        return requestPath;
      }
      return this.BASE + requestPath;
    },

    async _request(method, path, body, options) {
      const requestPath = String(path || '');
      const opts = options ? { ...options } : {};
      opts.method = method;
      opts.headers = buildJsonHeaders(opts.headers);
      if (body !== undefined) {
        opts.body = JSON.stringify(body);
      }

      try {
        const res = await fetch(this._buildUrl(requestPath), opts);
        const text = await res.text();
        const data = text ? JSON.parse(text) : null;
        return buildResult(res, data);
      } catch (err) {
        return {
          ok: false,
          status: 0,
          data: null,
          error: err && err.message ? err.message : 'Network request failed',
        };
      }
    },

    get(path, options) {
      return this._request('GET', path, undefined, options);
    },

    post(path, body, options) {
      return this._request('POST', path, body, options);
    },

    patch(path, body, options) {
      return this._request('PATCH', path, body, options);
    },

    getWorkbench() {
      return this.get('/workbench');
    },

    getTalentTemplates(options) {
      return this.get('/talent-market/templates', options);
    },

    getTemplate(templateId, options) {
      return this.get(`/talent-market/templates/${encodeURIComponent(templateId)}`, options);
    },

    recruit(body, options) {
      return this.post('/recruitments', body, options);
    },

    getConversation(conversationId, options) {
      return this.get(`/conversations/${encodeURIComponent(conversationId)}`, options);
    },

    createRun(body, options) {
      return this.post('/runs', body, options);
    },

    getRunStream(runId, cursor) {
      const value = Number.isFinite(cursor) ? cursor : 0;
      return fetch(`${this.BASE}/runs/${encodeURIComponent(runId)}/stream?cursor=${value}`);
    },

    getRunEvents(runId, cursor, limit, options) {
      const eventCursor = Number.isFinite(cursor) ? cursor : 0;
      const pageLimit = Number.isFinite(limit) ? limit : 100;
      return this.get(
        `/runs/${encodeURIComponent(runId)}/events?cursor=${eventCursor}&limit=${pageLimit}`,
        options,
      );
    },

    upload(body, options) {
      return this.post('/uploads', body, options);
    },

    getEmployees(options) {
      return this.get('/employees', options);
    },

    getEmployee(employeeId, options) {
      return this.get(`/employees/${encodeURIComponent(employeeId)}`, options);
    },

    updateEmployee(employeeId, body, options) {
      return this.patch(`/employees/${encodeURIComponent(employeeId)}`, body, options);
    },
  };
}(window.aiteam));
