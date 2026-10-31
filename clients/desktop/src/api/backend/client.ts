import { ServiceApiClient, type AgentClientOptions } from '../agent/client'

export class BackendApiClient extends ServiceApiClient {
  constructor(options: AgentClientOptions = {}) { super(options, 'backend') }
}
