window.aiteam = window.aiteam || {};

(function registerTeamPanelClient(ns) {
  function buildJsonHeaders(extraHeaders) {
    const headers = new Headers(extraHeaders || {});
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    return headers;
  }

  function normalizeError(data, fallback) {
    if (data && data.error) {
      if (typeof data.error === 'string') {
        return data.error;
      }
      if (data.error && typeof data.error === 'object') {
        return data.error.message || data.error.code || fallback;
      }
    }
    return fallback;
  }

  function buildResult(res, data) {
    const fallback = res.statusText || 'Request failed';
    const error = res.ok ? null : normalizeError(data, fallback);
    return {
      ok: res.ok,
      status: res.status,
      data,
      error,
    };
  }

  function buildQuerySuffix(query) {
    if (!query || typeof query !== 'object') {
      return '';
    }
    const params = new URLSearchParams();
    Object.keys(query).forEach((key) => {
      const value = query[key];
      if (value === undefined || value === null || value === '') {
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item) => params.append(key, String(item)));
        return;
      }
      params.set(key, String(value));
    });
    const text = params.toString();
    return text ? `?${text}` : '';
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

    delete(path, options) {
      return this._request('DELETE', path, undefined, options);
    },

    getWorkbench() {
      return this.get('/workbench');
    },

    getOfficeScene() {
      return this.get('/office/scene');
    },

    getOfficeFeed() {
      return this.get('/office/feed');
    },

    getKnowledgeBases(options) {
      return this.get('/knowledge-bases', options);
    },

    postKnowledgeDocument(kbId, body, options) {
      return this.post(`/knowledge-bases/${encodeURIComponent(kbId)}/documents`, body, options);
    },

    getTalentTemplates(options) {
      const query = options && options.query;
      if (query) {
        const requestOptions = { ...options };
        delete requestOptions.query;
        return this.get(`/talent-market/templates${buildQuerySuffix(query)}`, requestOptions);
      }
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

    getGroupConversation(conversationId, options) {
      return this.get(`/group-conversations/${encodeURIComponent(conversationId)}`, options);
    },

    submitGroupMessage(conversationId, body, options) {
      return this.post(`/group-conversations/${encodeURIComponent(conversationId)}/messages`, body, options);
    },

    getOrgTree(options) {
      return this.get('/org/tree', options);
    },

    updateOrgAssignment(assignmentId, body, options) {
      return this.patch(`/org/assignments/${encodeURIComponent(assignmentId)}`, body, options);
    },

    createRun(body, options) {
      return this.post('/runs', body, options);
    },

    retryRun(runId, body, options) {
      return this.post(`/runs/${encodeURIComponent(runId)}/retry`, body || {}, options);
    },

    abortRun(runId, body, options) {
      return this.post(`/runs/${encodeURIComponent(runId)}/abort`, body || {}, options);
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

    getSkillCatalog(options) {
      return this.get('/skills/catalog', options);
    },

    getSkillInstalls(options) {
      return this.get('/skills/installs', options);
    },

    installSkill(body, options) {
      return this.post('/skills/installs', body, options);
    },

    getBillingUsageOverview(options) {
      return this.get('/billing/usage/overview', options);
    },

    getBillingUsageRecords(query, options) {
      const suffix = query ? ('?' + query) : '';
      return this.get('/billing/usage/records' + suffix, options);
    },

    getConnectors(options) {
      return this.get('/connectors', options);
    },

    getConnector(connectorId, options) {
      return this.get(`/connectors/${encodeURIComponent(connectorId)}`, options);
    },

    createConnector(body, options) {
      return this.post('/connectors', body, options);
    },

    updateConnector(connectorId, body, options) {
      return this.patch(`/connectors/${encodeURIComponent(connectorId)}`, body, options);
    },

    testConnector(connectorId, body, options) {
      return this.post(`/connectors/${encodeURIComponent(connectorId)}/test`, body || {}, options);
    },

    updateConnectorGrants(connectorId, body, options) {
      return this.patch(`/connectors/${encodeURIComponent(connectorId)}/grants`, body, options);
    },

    getConnectorStatus(connectorId, options) {
      return this.get(`/connectors/${encodeURIComponent(connectorId)}/status`, options);
    },

    getSolutions(options) {
      return this.get('/solutions', options);
    },

    applySolution(solutionId, body, options) {
      return this.post(`/solutions/${encodeURIComponent(solutionId)}/apply`, body, options);
    },

    getMemories(options) {
      return this.get('/memories', options);
    },

    createMemory(body, options) {
      return this.post('/memories', body, options);
    },

    updateMemory(memoryId, body, options) {
      return this.patch(`/memories/${encodeURIComponent(memoryId)}`, body, options);
    },

    deleteMemory(memoryId, options) {
      return this.delete(`/memories/${encodeURIComponent(memoryId)}`, options);
    },
  };
}(window.aiteam));
