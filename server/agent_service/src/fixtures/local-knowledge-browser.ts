// Explicit test process: temporary DB, synthetic caller and model, loopback only.
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createFixture } from '../test-fixture.js';
import { AgentHttpServer } from '../http/server.js';
const fixture = await createFixture();
const expert = { employee_id: 'local-worker', tenant_id: 'tenant-test', member_id: 'member-test', version: '1', display_name: '本机测试员工', handle: 'local-worker', synced_at: new Date().toISOString(), revoked: false, status: 'active' };
fixture.store.replaceProjections([expert], [], [{ ...expert, snapshot_version: '1', tool_policy: { allowed_tools: [] } }]);
fixture.faux.setResponses([
  fauxAssistantMessage(fauxToolCall('local_knowledge_search', { query: '采购审批' }), { stopReason: 'toolUse' }),
  fauxAssistantMessage('根据本机检索结果，采购审批需要两位经理签字。'),
]);
const http = new AgentHttpServer({ host: fixture.host, store: fixture.store, authenticate: () => ({ callerId: 'member-test', userId: 'member-test', tenantId: 'tenant-test' }) });
await http.listen(1448, '127.0.0.1');
console.log('Local knowledge browser fixture ready on 127.0.0.1:1448');
let closing = false;
const close = async () => { if (closing) return; closing = true; await http.close(); await fixture.close(); process.exit(0); };
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
