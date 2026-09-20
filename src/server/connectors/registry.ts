import type { ConnectorKind, ConnectorMeta } from '../../shared/types.ts';
import type { AccountRow, Repos } from '../db/repos.ts';
import type { SecretStore } from '../secrets/store.ts';
import type { Clock, Logger } from '../util.ts';
import type { Connector, ConnectorContext } from './types.ts';

export function accountSecretName(accountId: string, field: string): string {
  return `acct.${accountId}.${field}`;
}

export class ConnectorRegistry {
  private connectors = new Map<ConnectorKind, Connector>();
  private repos: Repos;
  private secrets: SecretStore;
  private clock: Clock;
  private log: Logger;
  private fetchImpl: typeof fetch;

  constructor(deps: { repos: Repos; secrets: SecretStore; clock: Clock; log: Logger; fetch?: typeof fetch }) {
    this.repos = deps.repos;
    this.secrets = deps.secrets;
    this.clock = deps.clock;
    this.log = deps.log;
    this.fetchImpl = deps.fetch ?? fetch;
  }

  register(connector: Connector): this {
    this.connectors.set(connector.meta.kind, connector);
    return this;
  }

  get(kind: ConnectorKind): Connector | undefined {
    return this.connectors.get(kind);
  }

  canSend(account: AccountRow): boolean {
    return this.get(account.connector)?.send !== undefined && (account.connector !== 'webhook' || Boolean(account.config.outboundUrl?.trim()));
  }

  metas(): ConnectorMeta[] {
    return [...this.connectors.values()].map((c) => c.meta);
  }

  context(account: AccountRow): ConnectorContext {
    const { repos, secrets } = this;
    return {
      account,
      config: account.config,
      getSecret: async (field) => {
        // Re-read: a token refresh in another call may have rotated the reference since `account` was loaded.
        const ref = repos.accounts.get(account.id)?.secretRefs[field] ?? '';
        return ref ? secrets.resolve(ref) : null;
      },
      setSecret: (field, value) => {
        const ref = secrets.put(accountSecretName(account.id, field), value);
        const current = repos.accounts.get(account.id);
        if (current) repos.accounts.update(account.id, { secretRefs: { ...current.secretRefs, [field]: ref } });
      },
      getCursor: () => repos.accounts.get(account.id)?.cursor ?? {},
      setCursor: (cursor) => {
        repos.accounts.update(account.id, { cursor });
      },
      now: () => this.clock.now(),
      log: this.log,
      fetch: this.fetchImpl,
    };
  }
}
